// mcp.ts — the Model Context Protocol endpoint (POST /mcp), JSON-RPC 2.0 over
// Streamable HTTP with plain JSON responses.
//
// Era: this server speaks the handshake revisions (2025-11-25 and earlier). It
// answers `server/discover` with JSON-RPC -32601 (method not found), which is
// exactly how a pre-discover server identifies itself; the client then runs
// `initialize` + `notifications/initialized`. No session header is issued —
// every request is self-contained, which keeps concurrent calls trivially
// isolated: each response echoes its own request id and touches only the
// shared store.
//
// The six tools mirror github-mcp-server's argument contract and act on the
// same store as REST and GraphQL, so ids and objects agree across surfaces.

import {
  VIEWER,
  createIssueRec,
  createPullRec,
  forge,
  mergePull,
  type Repo,
} from './store.ts';
import { issueJsonObject, pullJsonObject, repoJson } from './rest.ts';
import type { WebRequest, WebResponse } from './web.ts';

const JSON_RPC = '2.0';
const PARSE_ERROR = -32700;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
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
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
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
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

function rpcResult(id: unknown, result: unknown): WebResponse {
  return {
    status: 200,
    body: JSON.stringify({ jsonrpc: JSON_RPC, id, result }),
    contentType: 'application/json; charset=utf-8',
  };
}

function rpcError(id: unknown, code: number, message: string, status = 200): WebResponse {
  return {
    status,
    body: JSON.stringify({ jsonrpc: JSON_RPC, id, error: { code, message } }),
    contentType: 'application/json; charset=utf-8',
  };
}

function toolResult(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function toolFailure(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function findRepo(owner: unknown, repo: unknown): Repo | null {
  if (owner !== VIEWER.login || typeof repo !== 'string') return null;
  return forge.repos.get(repo) ?? null;
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = args.name as string;
      const existing = forge.repos.get(repoName);
      if (existing !== undefined) return toolResult(repoJson(existing));
      const repo = forge.createRepo(repoName);
      repo.isPrivate = args.private === true;
      repo.description = typeof args.description === 'string' ? args.description : '';
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = findRepo(args.owner, args.repo);
      if (repo === null) return toolFailure(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = findRepo(args.owner, args.repo);
      if (repo === null) return toolFailure(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
      const issue = createIssueRec(repo, {
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : '',
      });
      return toolResult(issueJsonObject(repo, issue));
    }
    case 'list_issues': {
      const repo = findRepo(args.owner, args.repo);
      if (repo === null) return toolFailure(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => a.number - b.number);
      return toolResult(issues.map((issue) => issueJsonObject(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = findRepo(args.owner, args.repo);
      if (repo === null) return toolFailure(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
      const head = args.head as string;
      const base = args.base as string;
      if (repo.branchTip(head) === undefined) return toolFailure(`Head branch ${head} does not exist`);
      if (repo.branchTip(base) === undefined) return toolFailure(`Base branch ${base} does not exist`);
      const pull = createPullRec(repo, {
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : '',
        headRef: head,
        baseRef: base,
      });
      return toolResult(pullJsonObject(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = findRepo(args.owner, args.repo);
      if (repo === null) return toolFailure(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = repo.pulls.get(number);
      if (pull === undefined) return toolFailure(`Pull request ${number} not found`);
      const result = mergePull(repo, pull, 'squash');
      if (!result.ok) return toolFailure(`Pull request ${number} is not mergeable (${result.reason})`);
      return toolResult(pullJsonObject(repo, pull));
    }
    default:
      return toolFailure(`Unknown tool ${name}`);
  }
}

function handleMessage(message: Record<string, unknown>): WebResponse | null {
  const hasId = 'id' in message;
  const id = hasId ? message.id : null;
  const method = typeof message.method === 'string' ? message.method : '';

  // Notifications (no id) are acknowledged with an empty 202 and no body.
  if (!hasId) return null;

  switch (method) {
    case 'server/discover':
      return rpcError(id, METHOD_NOT_FOUND, 'Method not found: server/discover');
    case 'initialize': {
      const params = (message.params ?? {}) as Record<string, unknown>;
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = LEGACY_REVISIONS.includes(requested) ? requested : '2025-03-26';
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'gitforge', version: '1.0.0' },
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const params = (message.params ?? {}) as Record<string, unknown>;
      const toolName = typeof params.name === 'string' ? params.name : '';
      const tool = TOOL_BY_NAME.get(toolName);
      if (tool === undefined) return rpcError(id, INVALID_PARAMS, `Unknown tool: ${toolName}`);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const missing = tool.inputSchema.required.filter((field) => args[field] === undefined || args[field] === null);
      if (missing.length > 0) {
        return rpcError(id, INVALID_PARAMS, `Missing required argument(s): ${missing.join(', ')}`);
      }
      return rpcResult(id, callTool(toolName, args));
    }
    default:
      return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

export function handleMcp(req: WebRequest): WebResponse {
  if (req.method !== 'POST') {
    return { status: 405, body: '', contentType: 'application/json; charset=utf-8' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.rawBody.toString('utf8'));
  } catch {
    return rpcError(null, PARSE_ERROR, 'Parse error', 400);
  }
  if (Array.isArray(parsed)) {
    const responses: unknown[] = [];
    for (const entry of parsed) {
      if (entry !== null && typeof entry === 'object') {
        const answer = handleMessage(entry as Record<string, unknown>);
        if (answer !== null) responses.push(JSON.parse(answer.body as string));
      }
    }
    return { status: 200, body: JSON.stringify(responses), contentType: 'application/json; charset=utf-8' };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return rpcError(null, PARSE_ERROR, 'Parse error', 400);
  }
  const answer = handleMessage(parsed as Record<string, unknown>);
  if (answer === null) {
    // A notification: 202, empty body.
    return { status: 202, body: '', contentType: 'application/json; charset=utf-8' };
  }
  return answer;
}
