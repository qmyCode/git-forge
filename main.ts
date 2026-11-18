// gitforge — an in-memory GitHub-core forge (REST v3 + GraphQL v4 + MCP + git smart HTTP).
//
// Trial lifecycle (the only job of this entrypoint):
//   1. bind an ephemeral TCP port on all interfaces,
//   2. POST {"port": N} to $MAKEFUN_ENV_URL/register (the first registration wins),
//   3. poll GET $MAKEFUN_ENV_URL/done until the environment answers {"done": true},
//   4. exit 0.
// Everything the trial measures is served by createForgeServer() in app.ts; this file
// deliberately stays out of the request path so the hot routes never pay for lifecycle code.

import { createForgeServer } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(port: number): Promise<void> {
  // One POST; the environment answers 200 {"ok":true} to the first registration.
  const response = await fetch(`${envUrl}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
  });
  if (response.status !== 200) {
    throw new Error(`register answered HTTP ${response.status}`);
  }
  const body: unknown = await response.json().catch(() => null);
  if (body === null || typeof body !== 'object' || (body as { ok?: unknown }).ok !== true) {
    throw new Error('register did not confirm with {"ok":true}');
  }
}

async function pollUntilDone(): Promise<void> {
  // Backoff 250 ms, doubling, capped at 2 s; each call gets a 30 s budget.
  let delay = 250;
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(30_000) });
      if (response.status === 200) {
        const body: unknown = await response.json().catch(() => null);
        if (body !== null && typeof body === 'object' && (body as { done?: unknown }).done === true) {
          return;
        }
      }
    } catch {
      // A transient environment error is not an exit reason; keep polling.
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 2_000);
  }
}

async function main(): Promise<void> {
  if (envUrl === '') throw new Error('MAKEFUN_ENV_URL is not set');
  const server = createForgeServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no TCP address bound');
  console.log(`[entry] listening on port ${address.port}`);
  await register(address.port);
  console.log('[entry] registered; polling for done');
  await pollUntilDone();
  console.log('[entry] done; exiting');
  // Stop accepting new connections, then exit: in-flight keep-alive sockets
  // must not hold the trial open past this point.
  server.close();
  server.closeIdleConnections();
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('[entry] fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
