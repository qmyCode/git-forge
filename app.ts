// The HTTP router: one process serving the forge's four surfaces from the one store — git smart
// HTTP at /{owner}/{repo}.git, REST under /api/v3, GraphQL at /api/graphql, MCP at /mcp — plus
// the unauthenticated /healthz the harness boots against. Every API and git call carries the
// suite's bearer token; a missing or wrong one is a 401 before any routing happens.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { TOKEN, getRepo } from './store.ts';
import { handleRest, type RestContext } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMCP } from './mcp.ts';
import { handleInfoRefs, handleUploadPack, handleReceivePack } from './gitproto.ts';

const MAX_BODY_BYTES = 256 * 1024 * 1024;

let routerRequestCounter = 0;

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  routerRequestCounter += 1;
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    // Router-level replies (401s among them) carry the header the protocol checks require too.
    'x-github-request-id': `req-${routerRequestCounter}`,
  });
  res.end(body);
}

function authorized(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  return req.headers['authorization'] === `Bearer ${TOKEN}`;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

interface ParsedBody {
  /** The parsed JSON value when the body was JSON; otherwise undefined. */
  json: unknown;
  /** True when a non-empty body failed to parse as JSON. */
  malformed: boolean;
  /** The parsed JSON value when it is a plain object; otherwise undefined. */
  object: Record<string, unknown> | undefined;
}

function parseBody(raw: Buffer): ParsedBody {
  if (raw.length === 0) return { json: undefined, malformed: false, object: undefined };
  try {
    const json: unknown = JSON.parse(raw.toString('utf8'));
    const object = typeof json === 'object' && json !== null && !Array.isArray(json) ? (json as Record<string, unknown>) : undefined;
    return { json, malformed: false, object };
  } catch {
    return { json: undefined, malformed: true, object: undefined };
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  const url = new URL(req.url ?? '/', 'http://internal');
  const pathname = url.pathname;
  const origin = `http://${req.headers['host'] ?? 'localhost'}`;

  // The boot check: no auth, always the same answer.
  if (pathname === '/healthz') {
    if (method === 'GET') sendJson(res, 200, { ok: true });
    else sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(pathname);
  if (gitMatch !== null) {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const owner = decodeSegment(gitMatch[1] as string);
    const name = decodeSegment(gitMatch[2] as string);
    const repo = getRepo(owner, name);
    const tail = gitMatch[3] ?? '';
    if (tail === '/info/refs' && method === 'GET') {
      const service = url.searchParams.get('service') ?? '';
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, 400, { message: 'Bad Request' });
        return;
      }
      const protocolV2 = (req.headers['git-protocol'] ?? '').toString().includes('version=2');
      handleInfoRefs(req, res, repo, service, protocolV2);
      return;
    }
    if (tail === '/git-upload-pack' && method === 'POST') {
      const body = await readBody(req);
      const protocolV2 = (req.headers['git-protocol'] ?? '').toString().includes('version=2');
      handleUploadPack(res, repo, body, protocolV2);
      return;
    }
    if (tail === '/git-receive-pack' && method === 'POST') {
      const body = await readBody(req);
      handleReceivePack(res, repo, body);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // REST v3.
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    // Every method may carry a body here (DELETE on the contents route does).
    const parsed = parseBody(await readBody(req));
    const segments = pathname
      .replace(/^\/api\/v3\/?/, '')
      .split('/')
      .filter((segment) => segment !== '')
      .map(decodeSegment);
    const ctx: RestContext = { origin, body: parsed.object, bodyMalformed: parsed.malformed, query: url.searchParams };
    handleRest(req, res, ctx, segments);
    return;
  }

  // GraphQL.
  if (pathname === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const parsed = parseBody(await readBody(req));
    if (parsed.malformed) {
      sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
      return;
    }
    handleGraphQL(res, parsed.json);
    return;
  }

  // MCP.
  if (pathname === '/mcp') {
    if (method === 'GET') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (method === 'DELETE') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const parsed = parseBody(await readBody(req));
    handleMCP(res, parsed.json, parsed.malformed, origin);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

/** Build the forge's HTTP server (main.ts binds it to an ephemeral port and registers it). */
export function createApp(): Server {
  return createServer((req, res) => {
    route(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });
}
