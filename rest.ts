// The GitHub REST v3 surface: repositories, contents, git refs, commits, labels, issues, issue
// comments and pull requests, in the shapes the suite's REST client (and the MCP/GraphQL fixture
// builders, which also drive REST) consumes. Every reply is JSON with an X-GitHub-Request-Id;
// errors are always `{ "message": string }`.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type Repo,
  type Issue,
  createRepo,
  getRepo,
  listRepos,
  deleteRepo,
  createLabel,
  createIssue,
  addComment,
  createPull,
  mergePull,
  pullFiles,
  branchTip,
  commitFiles,
  filesToTree,
  commitTree,
  putObject,
  getObject,
  buildCommit,
  viewerIdent,
  nowEpochSec,
  nowIso,
  repoJson,
  userJson,
  labelJson,
  issueJson,
  commentJson,
  pullJson,
  commitJson,
} from './store.ts';

let requestCounter = 0;

export interface RestContext {
  origin: string;
  body: Record<string, unknown> | undefined;
  /** Set when the request carried a body that was not valid JSON. */
  bodyMalformed: boolean;
  query: URLSearchParams;
}

function sendJson(res: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  requestCounter += 1;
  const body = value === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(value), 'utf8');
  const headers: Record<string, string> = {
    'x-github-request-id': `req-${requestCounter}`,
    ...extraHeaders,
  };
  if (status !== 204) {
    headers['content-type'] = 'application/json; charset=utf-8';
    headers['content-length'] = String(body.length);
  }
  res.writeHead(status, headers);
  res.end(status === 204 ? undefined : body);
}

function fail(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function bodyString(body: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = body?.[key];
  return typeof value === 'string' ? value : undefined;
}

function bodyBool(body: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = body?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

/** Paginate a list the way the checks walk it: Link headers with absolute same-origin URLs. */
function paginate<T>(
  res: ServerResponse,
  ctx: RestContext,
  pathname: string,
  items: readonly T[],
  serialize: (item: T) => unknown,
): void {
  const perPageRaw = Number(ctx.query.get('per_page') ?? '30');
  const pageRaw = Number(ctx.query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.floor(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const links: string[] = [];
  const urlFor = (p: number): string => `${ctx.origin}/api/v3${pathname}?per_page=${perPage}&page=${p}`;
  if (page < totalPages) links.push(`<${urlFor(page + 1)}>; rel="next"`, `<${urlFor(totalPages)}>; rel="last"`);
  if (page > 1) links.push(`<${urlFor(page - 1)}>; rel="prev"`, `<${urlFor(1)}>; rel="first"`);
  sendJson(res, 200, slice.map(serialize), links.length > 0 ? { link: links.join(', ') } : {});
}

/** Sort issues or pulls by created order (creation order is number order here). */
function sortByCreated<T extends { number: number }>(items: T[], ctx: RestContext): T[] {
  const direction = (ctx.query.get('direction') ?? 'desc').toLowerCase();
  const sorted = [...items].sort((a, b) => a.number - b.number);
  if (direction !== 'asc') sorted.reverse();
  return sorted;
}

function stateFilter<T extends { state: string; merged?: boolean }>(items: readonly T[], ctx: RestContext): T[] {
  const state = (ctx.query.get('state') ?? 'open').toLowerCase();
  if (state === 'all') return [...items];
  if (state === 'closed') return items.filter((item) => item.state === 'closed');
  return items.filter((item) => item.state === 'open');
}

// --------------------------------------------------------------------------- contents + commits

/** Resolve a branch name, ref, or sha to a commit oid; null when it names nothing. */
function resolveCommit(repo: Repo, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') return branchTip(repo, repo.defaultBranch);
  const byRef = repo.refs.get(ref.startsWith('refs/') ? ref : `refs/heads/${ref}`);
  if (byRef !== undefined) return byRef;
  if (/^[0-9a-f]{40}$/.test(ref) && getObject(repo, ref)?.type === 'commit') return ref;
  return null;
}

/** Make one commit on a branch (or as its first commit) replacing one file's content. */
function commitFileChange(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): string {
  const tip = branchTip(repo, branch);
  const files = tip === null ? new Map<string, string>() : commitFiles(repo, tip);
  if (content === null) files.delete(path);
  else files.set(path, putObject(repo, 'blob', content));
  const tree = filesToTree(repo, files);
  const commit = buildCommit({
    tree,
    parents: tip === null ? [] : [tip],
    ident: viewerIdent(),
    timestamp: nowEpochSec(),
    message,
  });
  const sha = putObject(repo, 'commit', commit);
  repo.refs.set(`refs/heads/${branch}`, sha);
  repo.updatedAt = nowIso();
  return sha;
}

function handleGetContents(res: ServerResponse, ctx: RestContext, repo: Repo, path: string): void {
  const commit = resolveCommit(repo, ctx.query.get('ref') ?? undefined);
  if (commit === null) {
    fail(res, 404, 'Not Found');
    return;
  }
  const tree = commitTree(repo, commit);
  if (tree === null) {
    fail(res, 404, 'Not Found');
    return;
  }
  if (path === '') {
    const entries = listTreeLevel(repo, tree, '');
    sendJson(res, 200, entries);
    return;
  }
  // Walk to the target: either a blob (a file) or a subtree (a directory listing).
  const segments = path.split('/');
  let currentTree: string | null = tree;
  for (let i = 0; i < segments.length; i += 1) {
    if (currentTree === null) break;
    const entry = treeEntry(repo, currentTree, segments[i] as string);
    if (entry === undefined) {
      currentTree = null;
      break;
    }
    if (i === segments.length - 1) {
      if (entry.mode === '40000') {
        sendJson(res, 200, listTreeLevel(repo, entry.oid, path));
        return;
      }
      const blob = getObject(repo, entry.oid);
      if (blob === undefined) break;
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        content: blob.data.toString('base64'),
        name: segments[i],
        path,
        sha: entry.oid,
        size: blob.data.length,
        url: '',
        html_url: '',
        git_url: '',
        download_url: '',
      });
      return;
    }
    if (entry.mode !== '40000') {
      currentTree = null;
      break;
    }
    currentTree = entry.oid;
  }
  fail(res, 404, 'Not Found');
}

interface TreeLevelEntry {
  mode: string;
  oid: string;
}

function treeEntry(repo: Repo, treeOid: string, name: string): TreeLevelEntry | undefined {
  const object = getObject(repo, treeOid);
  if (object === undefined || object.type !== 'tree') return undefined;
  const text = object.data;
  let offset = 0;
  while (offset < text.length) {
    const space = text.indexOf(0x20, offset);
    const nul = text.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0) return undefined;
    const entryName = text.subarray(space + 1, nul).toString('utf8');
    const mode = text.subarray(offset, space).toString('ascii');
    const oid = text.subarray(nul + 1, nul + 21).toString('hex');
    if (entryName === name) return { mode, oid };
    offset = nul + 21;
  }
  return undefined;
}

function listTreeLevel(repo: Repo, treeOid: string, prefix: string): Record<string, unknown>[] {
  const object = getObject(repo, treeOid);
  if (object === undefined || object.type !== 'tree') return [];
  const out: Record<string, unknown>[] = [];
  let offset = 0;
  const data = object.data;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({
      type: mode === '40000' ? 'dir' : 'file',
      name,
      path: prefix === '' ? name : `${prefix}/${name}`,
      sha: oid,
      size: 0,
      url: '',
      html_url: '',
      git_url: '',
    });
    offset = nul + 21;
  }
  return out;
}

function handlePutContents(res: ServerResponse, ctx: RestContext, repo: Repo, path: string): void {
  const body = ctx.body ?? {};
  const message = bodyString(body, 'message');
  const contentB64 = bodyString(body, 'content');
  if (message === undefined || contentB64 === undefined) {
    fail(res, 422, 'Validation Failed: message and content are required');
    return;
  }
  const branch = bodyString(body, 'branch') ?? repo.defaultBranch;
  const givenSha = bodyString(body, 'sha');
  const tip = branchTip(repo, branch);
  const files = tip === null ? new Map<string, string>() : commitFiles(repo, tip);
  const existing = files.get(path);
  if (existing !== undefined) {
    if (givenSha === undefined) {
      fail(res, 422, 'Validation Failed: sha is required when the file exists');
      return;
    }
    if (givenSha !== existing) {
      fail(res, 409, 'Conflict: the given sha does not match the file');
      return;
    }
  } else if (givenSha !== undefined) {
    fail(res, 422, 'Validation Failed: sha supplied for a file that does not exist');
    return;
  }
  const content = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
  const sha = commitFileChange(repo, branch, path, content, message);
  const blobSha = putObject(repo, 'blob', content);
  sendJson(res, existing === undefined ? 201 : 200, {
    content: {
      type: 'file',
      encoding: 'base64',
      content: content.toString('base64'),
      name: path.split('/').pop(),
      path,
      sha: blobSha,
      size: content.length,
      url: '',
      html_url: '',
      git_url: '',
      download_url: '',
    },
    commit: { sha, message, url: '', html_url: '' },
  });
}

function handleDeleteContents(res: ServerResponse, ctx: RestContext, repo: Repo, path: string): void {
  const body = ctx.body ?? {};
  const message = bodyString(body, 'message');
  const givenSha = bodyString(body, 'sha');
  if (message === undefined || givenSha === undefined) {
    fail(res, 422, 'Validation Failed: message and sha are required');
    return;
  }
  const branch = bodyString(body, 'branch') ?? repo.defaultBranch;
  const tip = branchTip(repo, branch);
  const files = tip === null ? new Map<string, string>() : commitFiles(repo, tip);
  const existing = files.get(path);
  if (existing === undefined) {
    fail(res, 404, 'Not Found');
    return;
  }
  if (givenSha !== existing) {
    fail(res, 409, 'Conflict: the given sha does not match the file');
    return;
  }
  const sha = commitFileChange(repo, branch, path, null, message);
  sendJson(res, 200, { content: null, commit: { sha, message, url: '', html_url: '' } });
}

// --------------------------------------------------------------------------- route handlers

/** Handle one authenticated /api/v3 request. `segments` are the decoded path segments after /api/v3. */
export function handleRest(req: IncomingMessage, res: ServerResponse, ctx: RestContext, segments: readonly string[]): void {
  const method = (req.method ?? 'GET').toUpperCase();
  if (ctx.bodyMalformed && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
    fail(res, 400, 'Problems parsing JSON');
    return;
  }
  const [s0, s1, s2, s3, s4, s5] = segments as [string?, string?, string?, string?, string?, string?];

  // Root and meta.
  if (segments.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, { current_user_url: `${ctx.origin}/api/v3/user` }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }
    fail(res, 404, 'Not Found');
    return;
  }
  if (s0 === 'meta' && segments.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, { installed_version: 'gitforge-1.0.0', verifiable_password_authentication: false });
      return;
    }
    fail(res, 404, 'Not Found');
    return;
  }

  // The viewer.
  if (s0 === 'user' && segments.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, userJson());
      return;
    }
    fail(res, 404, 'Not Found');
    return;
  }
  if (s0 === 'user' && s1 === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      paginate(res, ctx, '/user/repos', listRepos(), (repo) => repoJson(repo, ctx.origin));
      return;
    }
    if (method === 'POST') {
      const name = bodyString(ctx.body, 'name');
      if (name === undefined || name === '') {
        fail(res, 422, 'Validation Failed: name is required');
        return;
      }
      const repo = createRepo(name, {
        description: bodyString(ctx.body, 'description') ?? '',
        isPrivate: bodyBool(ctx.body, 'private') ?? false,
        defaultBranch: bodyString(ctx.body, 'default_branch') ?? 'main',
      });
      if (repo === null) {
        fail(res, 422, `Validation Failed: name already exists on this account`);
        return;
      }
      sendJson(res, 201, repoJson(repo, ctx.origin));
      return;
    }
    fail(res, 404, 'Not Found');
    return;
  }

  if (s0 !== 'repos' || s1 === undefined || s2 === undefined) {
    fail(res, 404, 'Not Found');
    return;
  }
  const owner = s1;
  const repoName = s2;
  const repo = getRepo(owner, repoName);
  if (repo === undefined) {
    fail(res, 404, 'Not Found');
    return;
  }
  const rest = segments.slice(3);

  // The repository itself.
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo, ctx.origin));
      return;
    }
    if (method === 'PATCH') {
      const description = bodyString(ctx.body, 'description');
      if (description !== undefined) repo.description = description;
      const name = bodyString(ctx.body, 'name');
      if (name !== undefined && name !== repo.name) repo.name = name;
      const isPrivate = bodyBool(ctx.body, 'private');
      if (isPrivate !== undefined) repo.isPrivate = isPrivate;
      const defaultBranch = bodyString(ctx.body, 'default_branch');
      if (defaultBranch !== undefined) repo.defaultBranch = defaultBranch;
      repo.updatedAt = nowIso();
      sendJson(res, 200, repoJson(repo, ctx.origin));
      return;
    }
    if (method === 'DELETE') {
      deleteRepo(owner, repoName);
      sendJson(res, 204, undefined);
      return;
    }
    fail(res, 404, 'Not Found');
    return;
  }

  const [r0, r1] = rest as [string, string?];

  if (r0 === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') {
      handleGetContents(res, ctx, repo, path);
      return;
    }
    if (method === 'PUT') {
      handlePutContents(res, ctx, repo, path);
      return;
    }
    if (method === 'DELETE') {
      handleDeleteContents(res, ctx, repo, path);
      return;
    }
    fail(res, 404, 'Not Found');
    return;
  }

  if (r0 === 'git' && r1 === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const ref = bodyString(ctx.body, 'ref');
      const sha = bodyString(ctx.body, 'sha');
      if (ref === undefined || sha === undefined || getObject(repo, sha) === undefined) {
        fail(res, 422, 'Validation Failed: ref and a known sha are required');
        return;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, node_id: '', object: { sha, type: getObject(repo, sha)?.type ?? 'commit', url: '' }, url: '' });
      return;
    }
    if (method === 'GET' && rest.length > 2) {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) {
        fail(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, { ref, node_id: '', object: { sha, type: getObject(repo, sha)?.type ?? 'commit', url: '' }, url: '' });
      return;
    }
    fail(res, 404, 'Not Found');
    return;
  }

  if (r0 === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .sort()
        .map((ref) => ({
          name: ref.slice('refs/heads/'.length),
          commit: { sha: repo.refs.get(ref) as string, url: '' },
          protected: false,
        }));
      sendJson(res, 200, branches);
      return;
    }
    if (method === 'GET' && rest.length > 1) {
      const branch = rest.slice(1).join('/');
      const sha = branchTip(repo, branch);
      if (sha === null) {
        fail(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, { name: branch, commit: { sha, url: '' }, protected: false });
      return;
    }
    fail(res, 404, 'Not Found');
    return;
  }

  if (r0 === 'commits') {
    if (method === 'GET' && rest.length === 1) {
      const tip = resolveCommit(repo, ctx.query.get('sha') ?? undefined);
      if (tip === null) {
        sendJson(res, 200, []);
        return;
      }
      const ordered: string[] = [];
      const seen = new Set<string>();
      const visit = (oid: string): void => {
        if (seen.has(oid)) return;
        const object = getObject(repo, oid);
        if (object === undefined || object.type !== 'commit') return;
        seen.add(oid);
        ordered.push(oid);
        const parents = parseParents(object.data);
        for (const parent of parents) visit(parent);
      };
      visit(tip);
      const commits = ordered
        .map((oid) => commitJson(repo, oid, ctx.origin))
        .filter((value): value is Record<string, unknown> => value !== null);
      paginate(res, ctx, `/repos/${owner}/${repoName}/commits`, commits, (value) => value);
      return;
    }
    if (method === 'GET' && rest.length === 2) {
      const value = commitJson(repo, r1 as string, ctx.origin);
      if (value === null) {
        fail(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, value);
      return;
    }
    fail(res, 404, 'Not Found');
    return;
  }

  if (r0 === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      sendJson(res, 200, [...repo.labels.values()].map(labelJson));
      return;
    }
    if (method === 'POST' && rest.length === 1) {
      const name = bodyString(ctx.body, 'name');
      if (name === undefined || name === '') {
        fail(res, 422, 'Validation Failed: name is required');
        return;
      }
      const label = createLabel(repo, name, bodyString(ctx.body, 'color') ?? 'ededed', bodyString(ctx.body, 'description') ?? null);
      if (label === null) {
        fail(res, 422, 'Validation Failed: name has already been taken');
        return;
      }
      sendJson(res, 201, labelJson(label));
      return;
    }
    fail(res, 404, 'Not Found');
    return;
  }

  if (r0 === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const items = sortByCreated(stateFilter([...repo.issues.values()], ctx), ctx);
        paginate(res, ctx, `/repos/${owner}/${repoName}/issues`, items, (issue) => issueJson(repo, issue, ctx.origin));
        return;
      }
      if (method === 'POST') {
        const title = bodyString(ctx.body, 'title');
        if (title === undefined) {
          fail(res, 422, 'Validation Failed: title is required');
          return;
        }
        const rawLabels = ctx.body?.['labels'];
        const labelNames = Array.isArray(rawLabels)
          ? rawLabels.filter((value): value is string => typeof value === 'string')
          : [];
        try {
          const issue = createIssue(repo, { title, body: bodyString(ctx.body, 'body') ?? '', labelNames });
          sendJson(res, 201, issueJson(repo, issue, ctx.origin));
        } catch {
          fail(res, 422, 'Validation Failed: one or more labels do not exist on this repository');
        }
        return;
      }
      fail(res, 404, 'Not Found');
      return;
    }
    const number = Number(r1);
    const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
    if (rest.length === 2) {
      if (issue === undefined) {
        fail(res, 404, 'Not Found');
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, issueJson(repo, issue, ctx.origin));
        return;
      }
      if (method === 'PATCH') {
        applyIssuePatch(repo, issue, ctx);
        sendJson(res, 200, issueJson(repo, issue, ctx.origin));
        return;
      }
      fail(res, 404, 'Not Found');
      return;
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (issue === undefined) {
        fail(res, 404, 'Not Found');
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map((comment) => commentJson(repo, issue.number, comment, ctx.origin)));
        return;
      }
      if (method === 'POST') {
        const bodyText = bodyString(ctx.body, 'body');
        if (bodyText === undefined) {
          fail(res, 422, 'Validation Failed: body is required');
          return;
        }
        const comment = addComment(issue, bodyText);
        sendJson(res, 201, commentJson(repo, issue.number, comment, ctx.origin));
        return;
      }
      fail(res, 404, 'Not Found');
      return;
    }
    fail(res, 404, 'Not Found');
    return;
  }

  if (r0 === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const items = sortByCreated(stateFilter([...repo.pulls.values()], ctx), ctx);
        paginate(res, ctx, `/repos/${owner}/${repoName}/pulls`, items, (pull) => pullJson(repo, pull, ctx.origin));
        return;
      }
      if (method === 'POST') {
        const title = bodyString(ctx.body, 'title');
        const head = bodyString(ctx.body, 'head');
        const base = bodyString(ctx.body, 'base');
        if (title === undefined || head === undefined || base === undefined) {
          fail(res, 422, 'Validation Failed: title, head and base are required');
          return;
        }
        const created = createPull(repo, { title, body: bodyString(ctx.body, 'body') ?? '', head, base });
        if (created === 'head-missing' || created === 'base-missing') {
          fail(res, 422, `Validation Failed: the ${created === 'head-missing' ? 'head' : 'base'} branch does not exist`);
          return;
        }
        if (created === 'duplicate') {
          fail(res, 422, 'Validation Failed: a pull request already exists for this combination');
          return;
        }
        sendJson(res, 201, pullJson(repo, created, ctx.origin));
        return;
      }
      fail(res, 404, 'Not Found');
      return;
    }
    const number = Number(r1);
    const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
    if (rest.length === 2) {
      if (pull === undefined) {
        fail(res, 404, 'Not Found');
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, pullJson(repo, pull, ctx.origin));
        return;
      }
      if (method === 'PATCH') {
        const state = bodyString(ctx.body, 'state');
        if (state === 'closed' && pull.state === 'open') {
          pull.state = 'closed';
          pull.closedAt = nowIso();
        }
        const title = bodyString(ctx.body, 'title');
        if (title !== undefined) pull.title = title;
        const bodyText = bodyString(ctx.body, 'body');
        if (bodyText !== undefined) pull.body = bodyText;
        pull.updatedAt = nowIso();
        sendJson(res, 200, pullJson(repo, pull, ctx.origin));
        return;
      }
      fail(res, 404, 'Not Found');
      return;
    }
    if (pull === undefined) {
      fail(res, 404, 'Not Found');
      return;
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      const files = pullFiles(repo, pull).map((file) => ({
        sha: file.sha ?? '',
        filename: file.filename,
        status: file.status === 'removed' ? 'removed' : file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        blob_url: '',
        raw_url: '',
        contents_url: '',
      }));
      sendJson(res, 200, files);
      return;
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      if (pull.state !== 'open') {
        fail(res, 405, 'Pull Request is not open');
        return;
      }
      const method2 = bodyString(ctx.body, 'merge_method') ?? 'merge';
      const result = mergePull(repo, pull, method2 === 'merge' ? 'merge' : 'squash');
      if (result === 'conflict') {
        fail(res, 405, 'Pull Request is not mergeable: conflicts must be resolved');
        return;
      }
      if (result === 'not-open') {
        fail(res, 405, 'Pull Request is not open');
        return;
      }
      sendJson(res, 200, { sha: result, merged: true, message: 'Pull Request successfully merged' });
      return;
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (method === 'GET') {
        sendJson(res, 200, pull.comments.map((comment) => commentJson(repo, pull.number, comment, ctx.origin)));
        return;
      }
      if (method === 'POST') {
        const bodyText = bodyString(ctx.body, 'body');
        if (bodyText === undefined) {
          fail(res, 422, 'Validation Failed: body is required');
          return;
        }
        const comment = addComment(pull, bodyText);
        sendJson(res, 201, commentJson(repo, pull.number, comment, ctx.origin));
        return;
      }
      fail(res, 404, 'Not Found');
      return;
    }
    fail(res, 404, 'Not Found');
    return;
  }

  fail(res, 404, 'Not Found');
}

function parseParents(data: Buffer): string[] {
  const parents: string[] = [];
  for (const line of data.toString('utf8').split('\n')) {
    if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    if (line === '') break;
  }
  return parents;
}

function applyIssuePatch(repo: Repo, issue: Issue, ctx: RestContext): void {
  const title = bodyString(ctx.body, 'title');
  if (title !== undefined) issue.title = title;
  const bodyText = bodyString(ctx.body, 'body');
  if (bodyText !== undefined) issue.body = bodyText;
  const state = bodyString(ctx.body, 'state');
  if (state === 'closed' && issue.state === 'open') {
    issue.state = 'closed';
    issue.closedAt = nowIso();
  } else if (state === 'open' && issue.state === 'closed') {
    issue.state = 'open';
    issue.closedAt = null;
  }
  const rawLabels = ctx.body?.['labels'];
  if (Array.isArray(rawLabels)) {
    const names = rawLabels.filter((value): value is string => typeof value === 'string');
    if (names.every((name) => repo.labels.has(name))) issue.labelNames = names;
  }
  issue.updatedAt = nowIso();
}
