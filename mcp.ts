// The MCP surface: JSON-RPC 2.0 over POST /mcp, in both protocol eras a client may speak — the
// modern one (a `server/discover` probe answered with supported versions) and the legacy one
// (initialize + notifications/initialized). The tools act on the same store as REST and GraphQL,
// so an issue made here is the same issue everywhere. tools/list is a constant: two calls must
// answer byte-identical results.

import type { ServerResponse } from 'node:http';
import {
  VIEWER,
  createRepo,
  getRepo,
  createIssue,
  createPull,
  mergePull,
  issueJson,
  pullJson,
  repoJson,
} from './store.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'gitforge', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
}

const prop = (description: string): { type: string; description: string } => ({ type: 'string', description });

/** The tool catalogue, built once: tools/list must be byte-stable across calls. */
const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: prop('The repository name.'),
        description: prop('A short description of the repository.'),
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: prop('The repository owner login (defaults to the authenticated user).'),
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get the details of a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('The repository owner login.'),
        repo: prop('The repository name.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('The repository owner login.'),
        repo: prop('The repository name.'),
        title: prop('The issue title.'),
        body: prop('The issue body.'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('The repository owner login.'),
        repo: prop('The repository name.'),
        state: prop('Filter by state: open, closed, or all.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request between two branches of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('The repository owner login.'),
        repo: prop('The repository name.'),
        title: prop('The pull request title.'),
        body: prop('The pull request body.'),
        head: prop('The head branch (the branch with the changes).'),
        base: prop('The base branch (the branch the changes merge into).'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('The repository owner login.'),
        repo: prop('The repository name.'),
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

interface RpcOutcome {
  status: number;
  body: Record<string, unknown> | undefined;
}

function result(id: unknown, value: unknown): RpcOutcome {
  return { status: 200, body: { jsonrpc: '2.0', id: id as never, result: value } };
}

function rpcError(id: unknown, code: number, message: string): RpcOutcome {
  return { status: 200, body: { jsonrpc: '2.0', id: id as never, error: { code, message } } };
}

function toolResult(value: unknown): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const out: Record<string, unknown> = { content: [{ type: 'text', text }], isError: false };
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) out['structuredContent'] = value;
  if (Array.isArray(value)) out['structuredContent'] = { items: value };
  return out;
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function argString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function callTool(name: string, args: Record<string, unknown>, origin: string): RpcOutcome | 'unknown-tool' {
  const owner = argString(args, 'owner') ?? VIEWER.login;
  const repoName = argString(args, 'repo');
  switch (name) {
    case 'create_repo': {
      const repoArg = argString(args, 'name');
      if (repoArg === undefined) return result(null, toolError('missing required argument: name'));
      const created = createRepo(repoArg, {
        description: argString(args, 'description') ?? '',
        isPrivate: args['private'] === true,
      });
      if (created === null) return result(null, toolError(`a repository named ${repoArg} already exists`));
      return result(null, toolResult(repoJson(created, origin)));
    }
    case 'get_repo': {
      if (repoName === undefined) return result(null, toolError('missing required argument: repo'));
      const repo = getRepo(owner, repoName);
      if (repo === undefined) return result(null, toolError(`repository ${owner}/${repoName} not found`));
      return result(null, toolResult(repoJson(repo, origin)));
    }
    case 'create_issue': {
      if (repoName === undefined) return result(null, toolError('missing required argument: repo'));
      const title = argString(args, 'title');
      if (title === undefined) return result(null, toolError('missing required argument: title'));
      const repo = getRepo(owner, repoName);
      if (repo === undefined) return result(null, toolError(`repository ${owner}/${repoName} not found`));
      const issue = createIssue(repo, { title, body: argString(args, 'body') ?? '' });
      return result(null, toolResult(issueJson(repo, issue, origin)));
    }
    case 'list_issues': {
      if (repoName === undefined) return result(null, toolError('missing required argument: repo'));
      const repo = getRepo(owner, repoName);
      if (repo === undefined) return result(null, toolError(`repository ${owner}/${repoName} not found`));
      const state = argString(args, 'state') ?? 'open';
      const issues = [...repo.issues.values()].filter((issue) =>
        state === 'all' ? true : state === 'closed' ? issue.state === 'closed' : issue.state === 'open',
      );
      return result(null, toolResult(issues.map((issue) => issueJson(repo, issue, origin))));
    }
    case 'create_pull_request': {
      if (repoName === undefined) return result(null, toolError('missing required argument: repo'));
      const title = argString(args, 'title');
      const head = argString(args, 'head');
      const base = argString(args, 'base');
      if (title === undefined || head === undefined || base === undefined) {
        return result(null, toolError('missing required arguments: title, head and base are required'));
      }
      const repo = getRepo(owner, repoName);
      if (repo === undefined) return result(null, toolError(`repository ${owner}/${repoName} not found`));
      const created = createPull(repo, { title, body: argString(args, 'body') ?? '', head, base });
      if (typeof created === 'string') return result(null, toolError(`could not create the pull request: ${created}`));
      return result(null, toolResult(pullJson(repo, created, origin)));
    }
    case 'merge_pull_request': {
      if (repoName === undefined) return result(null, toolError('missing required argument: repo'));
      const rawNumber = args['pull_number'];
      const number = typeof rawNumber === 'number' ? rawNumber : typeof rawNumber === 'string' ? Number(rawNumber) : Number.NaN;
      if (!Number.isInteger(number)) return result(null, toolError('missing required argument: pull_number'));
      const repo = getRepo(owner, repoName);
      if (repo === undefined) return result(null, toolError(`repository ${owner}/${repoName} not found`));
      const pull = repo.pulls.get(number);
      if (pull === undefined) return result(null, toolError(`pull request ${number} not found`));
      if (pull.state !== 'open') return result(null, toolError(`pull request ${number} is not open`));
      const merged = mergePull(repo, pull, 'squash');
      if (merged === 'conflict') return result(null, toolError(`pull request ${number} has conflicts`));
      if (merged === 'not-open') return result(null, toolError(`pull request ${number} is not open`));
      return result(null, toolResult({ ...pullJson(repo, pull, origin), sha: merged }));
    }
    default:
      return 'unknown-tool';
  }
}

/** Handle one JSON-RPC message. `id === undefined` marks a notification (answer 202, no body). */
function handleMessage(message: Record<string, unknown>, origin: string): RpcOutcome {
  const id = message['id'];
  const method = typeof message['method'] === 'string' ? (message['method'] as string) : '';
  const params = (typeof message['params'] === 'object' && message['params'] !== null ? message['params'] : {}) as Record<string, unknown>;
  if (id === undefined) return { status: 202, body: undefined };
  switch (method) {
    case 'server/discover':
      return result(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'initialize': {
      const requested = typeof params['protocolVersion'] === 'string' ? (params['protocolVersion'] as string) : '';
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return result(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return result(id, {});
    case 'tools/list':
      return result(id, { tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params['name'] === 'string' ? (params['name'] as string) : '';
      const args = (typeof params['arguments'] === 'object' && params['arguments'] !== null ? params['arguments'] : {}) as Record<string, unknown>;
      const outcome = callTool(toolName, args, origin);
      if (outcome === 'unknown-tool') return rpcError(id, -32601, `unknown tool: ${toolName}`);
      // callTool built its outcome with a placeholder id; restamp it with the request's.
      return { status: outcome.status, body: { ...(outcome.body as Record<string, unknown>), id: id as never } };
    }
    default:
      return rpcError(id, -32601, `unknown method: ${method}`);
  }
}

/** Handle POST /mcp. Auth is enforced by the router before this is called. */
export function handleMCP(res: ServerResponse, rawBody: unknown, bodyMalformed: boolean, origin: string): void {
  if (bodyMalformed || typeof rawBody !== 'object' || rawBody === null) {
    const body = Buffer.from(
      JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
      'utf8',
    );
    res.writeHead(400, { 'content-type': 'application/json', 'content-length': body.length });
    res.end(body);
    return;
  }
  if (Array.isArray(rawBody)) {
    const bodies: Record<string, unknown>[] = [];
    let status = 200;
    for (const item of rawBody) {
      const outcome = handleMessage((item ?? {}) as Record<string, unknown>, origin);
      if (outcome.body !== undefined) bodies.push(outcome.body);
      else status = 202;
    }
    if (bodies.length === 0) {
      res.writeHead(202);
      res.end();
      return;
    }
    const body = Buffer.from(JSON.stringify(bodies), 'utf8');
    res.writeHead(status === 202 && bodies.length === 0 ? 202 : 200, { 'content-type': 'application/json', 'content-length': body.length });
    res.end(body);
    return;
  }
  const outcome = handleMessage(rawBody as Record<string, unknown>, origin);
  if (outcome.body === undefined) {
    res.writeHead(202);
    res.end();
    return;
  }
  const body = Buffer.from(JSON.stringify(outcome.body), 'utf8');
  res.writeHead(outcome.status, { 'content-type': 'application/json', 'content-length': body.length });
  res.end(body);
}
