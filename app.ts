// app.ts — the HTTP shell: routing, the bearer-token gate, body reading and
// response writing for every surface (REST, GraphQL, MCP, git smart HTTP,
// /healthz). Handlers are pure functions of a pre-parsed WebRequest; the shell
// owns everything socket-shaped so the surfaces stay small and fast.
//
// The request path is deliberately lean — a manual URL split instead of the
// URL parser, one pass over the body, and no per-request state beyond a
// monotonically increasing request-id counter — because the benchmark's read
// workload issues 2,000 requests over one keep-alive connection.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { VIEWER, forge } from './store.ts';
import { gitInfoRefs, gitServicePost } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { HttpError, errorResponse, type WebRequest, type WebResponse } from './web.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const MAX_BODY_BYTES = 256 * 1024 * 1024;

let requestCounter = 0;

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function writeResponse(res: ServerResponse, response: WebResponse): void {
  const body = typeof response.body === 'string' ? Buffer.from(response.body, 'utf8') : response.body;
  res.sendDate = false;
  res.statusCode = response.status;
  res.setHeader('content-type', response.contentType);
  res.setHeader('x-github-request-id', `forge-${(requestCounter += 1).toString(36)}`);
  if (response.headers !== undefined) {
    for (const [name, value] of Object.entries(response.headers)) res.setHeader(name, value);
  }
  res.setHeader('content-length', String(body.length));
  res.end(body);
}

function authorized(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

async function route(req: IncomingMessage): Promise<WebResponse> {
  const url = req.url ?? '/';
  const qIndex = url.indexOf('?');
  const rawPath = qIndex === -1 ? url : url.slice(0, qIndex);
  const query = new URLSearchParams(qIndex === -1 ? '' : url.slice(qIndex + 1));
  const segments = rawPath.split('/').filter((part) => part !== '').map(decodeSegment);
  const method = (req.method ?? 'GET').toUpperCase();

  // The boot probe is unauthenticated by design.
  if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
    return { status: 200, body: '{"ok":true}', contentType: 'application/json; charset=utf-8' };
  }

  if (!authorized(req)) return errorResponse(401, 'Bad credentials');

  const rawBody = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
  const webRequest: WebRequest = {
    method,
    segments,
    query,
    rawBody,
    host: req.headers.host ?? 'localhost',
    gitProtocol: typeof req.headers['git-protocol'] === 'string' ? req.headers['git-protocol'] : null,
    json(): unknown {
      if (rawBody.length === 0) return {};
      try {
        return JSON.parse(rawBody.toString('utf8'));
      } catch {
        throw new HttpError(400, 'Problems parsing JSON');
      }
    },
  };

  // REST v3.
  if (segments[0] === 'api' && segments[1] === 'v3') return handleRest(webRequest);
  // GraphQL v4.
  if (segments[0] === 'api' && segments[1] === 'graphql' && segments.length === 2) return handleGraphql(webRequest);
  // MCP.
  if (segments[0] === 'mcp' && segments.length === 1) return handleMcp(webRequest);

  // Git smart HTTP: /{owner}/{repo}.git/...
  if (segments.length >= 3 && (segments[1] as string).endsWith('.git')) {
    const owner = segments[0] as string;
    const repoName = (segments[1] as string).slice(0, -4);
    const repo = owner === VIEWER.login ? (forge.repos.get(repoName) ?? null) : null;
    if (segments[2] === 'info' && segments[3] === 'refs' && method === 'GET') {
      const service = query.get('service') ?? '';
      const protocolV2 = (webRequest.gitProtocol ?? '').includes('version=2');
      const answer = gitInfoRefs(repo, service, protocolV2);
      return { status: answer.status, body: answer.body, contentType: answer.contentType };
    }
    if ((segments[2] === 'git-upload-pack' || segments[2] === 'git-receive-pack') && method === 'POST') {
      const answer = gitServicePost(repo, segments[2], rawBody);
      return { status: answer.status, body: answer.body, contentType: answer.contentType };
    }
    return errorResponse(404, 'Not Found');
  }

  return errorResponse(404, 'Not Found');
}

export function createForgeServer(): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    route(req)
      .then((response) => writeResponse(res, response))
      .catch((err: unknown) => {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        if (err instanceof HttpError) {
          writeResponse(res, errorResponse(err.status, err.message));
        } else {
          writeResponse(res, errorResponse(500, 'Internal Server Error'));
        }
      });
  });
  server.keepAliveTimeout = 10_000;
  return server;
}
