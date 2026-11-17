// Entrypoint for the forge process.
//
// This file owns the contest lifecycle and nothing else: the forge itself
// (git smart HTTP, REST, GraphQL and MCP over one store) is built by
// createApp() in app.ts. The job here is to bind that server to a port the
// kernel picks, tell the suite's env which port it was, and then stay alive
// until the env says the trial is over.
//
// The wire, in order:
//   1. MAKEFUN_ENV_URL names the env's origin. A trial always sets it; with
//      no env there is nobody to register with and nobody to serve, so the
//      process refuses to start.
//   2. Listen on port 0. The kernel assigns a free ephemeral port; a fixed
//      port could collide, and 8080 belongs to the env itself.
//   3. POST {"port": N} to <env>/register. The env notes the address the
//      request arrived from and dials the forge back at that address.
//   4. Poll GET <env>/done. It answers {"done": false} while the suite is
//      still driving the forge and {"done": true} once its export is
//      written; only then may this process wind down.
//   5. Close the server and exit 0 so the harness can collect the export.

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';

/** Origin of the suite's env, with any trailing slashes removed. */
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

/** Longest a single call to the env may run before it counts as failed. */
const CALL_TIMEOUT_MS = 30_000;

/** Delay after the first failed call; each later failure waits twice as long. */
const FIRST_RETRY_WAIT_MS = 250;

/** The retry delay never grows past this, however many failures pile up. */
const LONGEST_RETRY_WAIT_MS = 2_000;

/** Sleep for the given number of milliseconds. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * How long to wait before the next attempt, given how many calls have
 * failed so far: 250 ms, then 500, 1 s, and 2 s for every failure after.
 */
function waitBeforeRetry(failures: number): number {
  return Math.min(LONGEST_RETRY_WAIT_MS, FIRST_RETRY_WAIT_MS * 2 ** failures);
}

/**
 * Announce the bound port to the env, retrying until it accepts.
 *
 * The env takes exactly one registration: 200 means it recorded ours and
 * 409 means another process registered first, so both end the loop — there
 * is nothing further this process can do about either. A 400 or 405 says
 * the request itself breaks the contract, which no retry will fix, so it
 * is thrown and ends the program. Everything else — the env still
 * starting up, a reset connection, a timeout, an unexpected status — is
 * retried on the shared backoff pacing.
 */
async function announcePort(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    let status: number | undefined;
    try {
      const reply = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      status = reply.status;
      // Drain the body so the connection is released before we move on.
      await reply.text().catch(() => undefined);
    } catch {
      status = undefined; // Unreachable or timed out: fall through to retry.
    }
    if (status === 200 || status === 409) return;
    if (status === 400 || status === 405) {
      throw new Error(`the env refused the registration with HTTP ${status}`);
    }
    await pause(waitBeforeRetry(failures));
  }
}

/**
 * Poll the env's /done until it reports the trial finished.
 *
 * A poll that fails, times out, or answers anything other than a JSON body
 * with done set to true simply means the suite is not finished yet, so it
 * is retried on the same pacing as registration. This function returns
 * only on a definite {"done": true}; the process must never exit earlier,
 * because the export the scorer reads exists only once the suite is done.
 */
async function waitForTrialEnd(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    let finished = false;
    try {
      const reply = await fetch(`${envOrigin}/done`, {
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (reply.ok) {
        const body: unknown = await reply.json();
        finished =
          typeof body === 'object' &&
          body !== null &&
          (body as { done?: unknown }).done === true;
      } else {
        await reply.text().catch(() => undefined);
      }
    } catch {
      finished = false;
    }
    if (finished) return;
    await pause(waitBeforeRetry(failures));
  }
}

/** Bind the forge, register it with the env, and wait out the trial. */
async function run(): Promise<void> {
  if (envOrigin === '') {
    throw new Error('MAKEFUN_ENV_URL is not set: there is no env to register with');
  }

  const server: Server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });

  const bound = server.address();
  if (bound === null || typeof bound !== 'object') {
    throw new Error('the server did not report the TCP address it bound');
  }
  const port = (bound as AddressInfo).port;
  process.stdout.write(`[entry] listening on port ${port}\n`);

  await announcePort(port);
  process.stdout.write('[entry] registered; waiting for the env to finish\n');

  await waitForTrialEnd();

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[entry] fatal: ${detail}\n`);
  process.exit(1);
}
