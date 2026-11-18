// rest.ts — the GitHub REST v3 surface.
//
// Routes (all under /api/v3): the index and meta reads, the viewer, repositories
// (create/read/patch/delete/list with Link pagination), branches and git refs,
// commits, the contents API, labels, issues + comments, and pull requests +
// files + merge. Every reply is JSON with a {message} error shape; the shell in
// app.ts adds the X-GitHub-Request-Id header and the bearer-token gate.
//
// Performance: the benchmark reads one issue 2,000 times over a keep-alive
// connection and creates 200 issues. The single-issue GET serves a memoised
// serialisation (invalidated on any mutation of that issue), and issue creation
// is O(1) counter work plus one serialisation.

import {
  Repo,
  VIEWER,
  ZERO_OID,
  commitFile,
  commitMessage,
  createIssueRec,
  createPullRec,
  flattenTree,
  forge,
  globalId,
  iso,
  listDirAt,
  mergeBase,
  mergePull,
  peel,
  readFileAt,
  stamp,
  type IssueRec,
  type PullRec,
} from './store.ts';
import { HttpError, errorResponse, jsonResponse, type WebRequest, type WebResponse } from './web.ts';

// ---------------------------------------------------------------------------
// serialisers

export function viewerJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: globalId('U', VIEWER.id),
    type: 'User',
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.numId,
    node_id: globalId('R', repo.numId),
    name: repo.name,
    full_name: `${VIEWER.login}/${repo.name}`,
    private: repo.isPrivate,
    owner: viewerJson(),
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    created_at: iso(repo.createdSec),
    updated_at: iso(repo.createdSec),
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return { name, color: label?.color ?? 'ededed' };
}

export function issueJsonObject(repo: Repo, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.numId,
    node_id: globalId('I', issue.numId),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: viewerJson(),
    comments: issue.comments.length,
    created_at: iso(issue.sec),
    updated_at: iso(issue.sec),
  };
}

/** The benchmark's hot read: a memoised serialised issue body. */
function issueJsonCached(repo: Repo, issue: IssueRec): string {
  let cached = repo.issueJsonCache.get(issue.number);
  if (cached === undefined) {
    cached = JSON.stringify(issueJsonObject(repo, issue));
    repo.issueJsonCache.set(issue.number, cached);
  }
  return cached;
}

export function commentJson(comment: { numId: number; body: string; sec: number }): Record<string, unknown> {
  return {
    id: comment.numId,
    node_id: globalId('C', comment.numId),
    body: comment.body,
    user: viewerJson(),
    created_at: iso(comment.sec),
    updated_at: iso(comment.sec),
  };
}

export function pullJsonObject(repo: Repo, pull: PullRec): Record<string, unknown> {
  const headSha = repo.branchTip(pull.headRef) ?? ZERO_OID;
  const baseSha = repo.branchTip(pull.baseRef) ?? ZERO_OID;
  return {
    id: pull.numId,
    node_id: globalId('P', pull.numId),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: headSha, label: `${VIEWER.login}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${VIEWER.login}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedSec === null ? null : iso(pull.mergedSec),
    merge_commit_sha: pull.mergeSha,
    user: viewerJson(),
    created_at: iso(pull.sec),
    updated_at: iso(pull.mergedSec ?? pull.sec),
  };
}

// ---------------------------------------------------------------------------
// helpers

function bodyObject(req: WebRequest): Record<string, unknown> {
  const value = req.json();
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

function repoOr404(owner: string, name: string): Repo {
  if (owner !== VIEWER.login) throw new HttpError(404, 'Not Found');
  const repo = forge.repos.get(name);
  if (repo === undefined) throw new HttpError(404, 'Not Found');
  return repo;
}

function issueOr404(repo: Repo, number: number): IssueRec {
  const issue = repo.issues.get(number);
  if (issue === undefined) throw new HttpError(404, 'Not Found');
  return issue;
}

function pullOr404(repo: Repo, number: number): PullRec {
  const pull = repo.pulls.get(number);
  if (pull === undefined) throw new HttpError(404, 'Not Found');
  return pull;
}

function parseNumber(text: string | undefined): number {
  const n = Number(text);
  return Number.isInteger(n) && n > 0 ? n : -1;
}

// ---------------------------------------------------------------------------
// repositories

function createRepo(req: WebRequest): WebResponse {
  const body = bodyObject(req);
  const name = stringField(body, 'name');
  if (name === undefined || name === '') throw new HttpError(422, 'Repository name is required');
  if (forge.repos.has(name)) throw new HttpError(422, 'Repository already exists');
  const repo = forge.createRepo(name);
  repo.isPrivate = body.private === true;
  repo.description = stringField(body, 'description') ?? '';
  return jsonResponse(201, repoJson(repo));
}

function listRepos(req: WebRequest): WebResponse {
  const perPage = Math.max(1, Math.min(100, Number(req.query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(req.query.get('page') ?? '1') || 1);
  const all = [...forge.repos.values()];
  const slice = all.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  if (page * perPage < all.length) {
    const next = `http://${req.host}/api/v3/user/repos?page=${page + 1}&per_page=${perPage}`;
    headers.link = `<${next}>; rel="next"`;
  }
  return jsonResponse(200, slice.map((repo) => repoJson(repo)), headers);
}

function patchRepo(req: WebRequest, repo: Repo): WebResponse {
  const body = bodyObject(req);
  const description = stringField(body, 'description');
  if (description !== undefined) repo.description = description;
  if (typeof body.private === 'boolean') repo.isPrivate = body.private;
  return jsonResponse(200, repoJson(repo));
}

// ---------------------------------------------------------------------------
// branches, refs, commits

function listBranches(repo: Repo): WebResponse {
  const branches: Array<Record<string, unknown>> = [];
  for (const [ref, oid] of repo.refs) {
    if (!ref.startsWith('refs/heads/')) continue;
    branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid } });
  }
  branches.sort((a, b) => ((a.name as string) < (b.name as string) ? -1 : 1));
  return jsonResponse(200, branches);
}

function getBranch(repo: Repo, branch: string): WebResponse {
  const tip = repo.branchTip(branch);
  if (tip === undefined) throw new HttpError(404, 'Not Found');
  return jsonResponse(200, { name: branch, commit: { sha: tip } });
}

function createRef(req: WebRequest, repo: Repo): WebResponse {
  const body = bodyObject(req);
  const ref = stringField(body, 'ref');
  const sha = stringField(body, 'sha');
  if (ref === undefined || !ref.startsWith('refs/') || sha === undefined) {
    throw new HttpError(422, 'ref and sha are required');
  }
  const target = repo.objects.get(sha);
  if (target === undefined) throw new HttpError(422, 'sha does not name an object');
  if (repo.refs.has(ref)) throw new HttpError(422, 'Reference already exists');
  repo.setRef(ref, sha);
  return jsonResponse(201, { ref, object: { type: target.t, sha } });
}

function getRef(repo: Repo, ref: string): WebResponse {
  const oid = repo.refs.get(ref);
  if (oid === undefined) throw new HttpError(404, 'Not Found');
  const target = repo.objects.get(oid);
  return jsonResponse(200, { ref, object: { type: target?.t ?? 'commit', sha: oid } });
}

interface AuthorLine {
  name: string;
  email: string;
  sec: number;
}

function parseAuthorLine(data: Buffer, key: string): AuthorLine {
  const text = data.subarray(0, data.indexOf('\n\n') === -1 ? data.length : data.indexOf('\n\n')).toString('utf8');
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${key} `)) continue;
    const value = line.slice(key.length + 1);
    const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(value);
    if (match !== null) {
      return { name: match[1] as string, email: match[2] as string, sec: Number(match[3]) };
    }
    return { name: value, email: '', sec: 0 };
  }
  return { name: '', email: '', sec: 0 };
}

function listCommits(req: WebRequest, repo: Repo): WebResponse {
  const rev = req.query.get('sha') ?? repo.defaultBranch;
  const start = repo.resolveRef(rev);
  if (start === undefined) return jsonResponse(200, []);
  const startCommit = peel(repo, start);
  if (startCommit === null) return jsonResponse(200, []);
  const seen = new Set<string>();
  const order: string[] = [];
  const stack = [startCommit];
  while (stack.length > 0 && order.length < 1000) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    order.push(oid);
    const head = repo.headOf(oid);
    if (head !== undefined) {
      // Push parents reversed so the first parent is visited first.
      for (let i = head.parents.length - 1; i >= 0; i -= 1) stack.push(head.parents[i] as string);
    }
  }
  const items = order.map((oid) => {
    const obj = repo.objects.get(oid);
    const data = obj?.d ?? Buffer.alloc(0);
    const head = repo.headOf(oid);
    const author = parseAuthorLine(data, 'author');
    const committer = parseAuthorLine(data, 'committer');
    return {
      sha: oid,
      commit: {
        message: commitMessage(data),
        author: { name: author.name, email: author.email, date: iso(author.sec) },
        committer: { name: committer.name, email: committer.email, date: iso(committer.sec) },
      },
      parents: (head?.parents ?? []).map((parent) => ({ sha: parent })),
    };
  });
  return jsonResponse(200, items);
}

// ---------------------------------------------------------------------------
// contents

function contentsPut(req: WebRequest, repo: Repo, path: string): WebResponse {
  const body = bodyObject(req);
  const message = stringField(body, 'message') ?? 'Update file';
  const encoded = stringField(body, 'content');
  if (encoded === undefined) throw new HttpError(422, 'content is required');
  const content = Buffer.from(encoded, 'base64');
  const branch = stringField(body, 'branch') ?? repo.defaultBranch;
  const shaField = stringField(body, 'sha');
  const current = readFileAt(repo, branch, path);
  if (current !== null) {
    if (shaField === undefined || shaField.toLowerCase() !== current.oid.toLowerCase()) {
      throw new HttpError(409, 'The sha does not match the current file');
    }
  } else if (shaField !== undefined) {
    throw new HttpError(422, 'The file does not exist');
  }
  const { commitSha, blobSha } = commitFile(repo, branch, path, content, message);
  const base = path.split('/').pop() ?? path;
  return jsonResponse(current === null ? 201 : 200, {
    content: { name: base, path, sha: blobSha, size: content.length, encoding: 'base64' },
    commit: { sha: commitSha },
  });
}

function contentsGet(req: WebRequest, repo: Repo, path: string): WebResponse {
  const rev = req.query.get('ref') ?? repo.defaultBranch;
  const file = readFileAt(repo, rev, path);
  if (file !== null) {
    const name = path.split('/').pop() ?? path;
    return jsonResponse(200, {
      type: 'file',
      encoding: 'base64',
      content: file.data.toString('base64'),
      name,
      path,
      sha: file.oid,
      size: file.data.length,
    });
  }
  const dir = listDirAt(repo, rev, path);
  if (dir !== null) {
    return jsonResponse(
      200,
      dir.map((entry) => ({ type: entry.type, name: entry.name, path: entry.path, sha: entry.sha, size: 0 })),
    );
  }
  throw new HttpError(404, 'Not Found');
}

function contentsDelete(req: WebRequest, repo: Repo, path: string): WebResponse {
  const body = bodyObject(req);
  const message = stringField(body, 'message') ?? 'Delete file';
  const branch = stringField(body, 'branch') ?? repo.defaultBranch;
  const shaField = stringField(body, 'sha');
  const current = readFileAt(repo, branch, path);
  if (current === null) throw new HttpError(404, 'Not Found');
  if (shaField !== undefined && shaField.toLowerCase() !== current.oid.toLowerCase()) {
    throw new HttpError(409, 'The sha does not match the current file');
  }
  const { commitSha } = commitFile(repo, branch, path, null, message);
  return jsonResponse(200, { content: null, commit: { sha: commitSha } });
}

// ---------------------------------------------------------------------------
// issues and comments

function createIssue(req: WebRequest, repo: Repo): WebResponse {
  const body = bodyObject(req);
  const title = stringField(body, 'title');
  if (title === undefined) throw new HttpError(422, 'title is required');
  const labels: string[] = [];
  if (Array.isArray(body.labels)) {
    for (const entry of body.labels) {
      const name = typeof entry === 'string' ? entry : (entry as { name?: unknown })?.name;
      if (typeof name !== 'string' || !repo.labels.has(name)) {
        throw new HttpError(422, `Validation Failed: label ${String(name)} does not exist`);
      }
      labels.push(name);
    }
  }
  const issue = createIssueRec(repo, { title, body: stringField(body, 'body') ?? '', labels });
  return {
    status: 201,
    body: issueJsonCached(repo, issue),
    contentType: 'application/json; charset=utf-8',
  };
}

function listIssues(req: WebRequest, repo: Repo): WebResponse {
  const state = req.query.get('state') ?? 'open';
  const direction = req.query.get('direction') ?? 'desc';
  const perPage = Math.max(1, Math.min(100, Number(req.query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(req.query.get('page') ?? '1') || 1);
  let items = [...repo.issues.values()];
  if (state === 'open' || state === 'closed') items = items.filter((issue) => issue.state === state);
  items.sort((a, b) => {
    const byTime = a.sec - b.sec || a.number - b.number;
    return direction === 'asc' ? byTime : -byTime;
  });
  const slice = items.slice((page - 1) * perPage, page * perPage);
  return jsonResponse(200, slice.map((issue) => issueJsonObject(repo, issue)));
}

function patchIssue(req: WebRequest, repo: Repo, number: number): WebResponse {
  const issue = issueOr404(repo, number);
  const body = bodyObject(req);
  const state = stringField(body, 'state');
  if (state === 'closed' || state === 'open') issue.state = state;
  const title = stringField(body, 'title');
  if (title !== undefined) issue.title = title;
  const text = stringField(body, 'body');
  if (text !== undefined) issue.body = text;
  repo.issueJsonCache.delete(number);
  return {
    status: 200,
    body: issueJsonCached(repo, issue),
    contentType: 'application/json; charset=utf-8',
  };
}

function createComment(req: WebRequest, repo: Repo, number: number): WebResponse {
  const issue = issueOr404(repo, number);
  const body = bodyObject(req);
  const text = stringField(body, 'body');
  if (text === undefined) throw new HttpError(422, 'body is required');
  const comment = { numId: forge.entityId(), body: text, sec: stamp() };
  issue.comments.push(comment);
  repo.issueJsonCache.delete(number);
  return jsonResponse(201, commentJson(comment));
}

function listComments(repo: Repo, number: number): WebResponse {
  const issue = issueOr404(repo, number);
  return jsonResponse(200, issue.comments.map((comment) => commentJson(comment)));
}

// ---------------------------------------------------------------------------
// pull requests

function createPull(req: WebRequest, repo: Repo): WebResponse {
  const body = bodyObject(req);
  const title = stringField(body, 'title');
  const head = stringField(body, 'head');
  const base = stringField(body, 'base');
  if (title === undefined || head === undefined || base === undefined) {
    throw new HttpError(422, 'title, head and base are required');
  }
  if (repo.branchTip(head) === undefined) throw new HttpError(422, `Head branch ${head} does not exist`);
  if (repo.branchTip(base) === undefined) throw new HttpError(422, `Base branch ${base} does not exist`);
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
      throw new HttpError(422, 'A pull request already exists for this branch combination');
    }
  }
  const pull = createPullRec(repo, { title, body: stringField(body, 'body') ?? '', headRef: head, baseRef: base });
  return jsonResponse(201, pullJsonObject(repo, pull));
}

function listPulls(req: WebRequest, repo: Repo): WebResponse {
  const state = req.query.get('state') ?? 'open';
  const perPage = Math.max(1, Math.min(100, Number(req.query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(req.query.get('page') ?? '1') || 1);
  let items = [...repo.pulls.values()];
  if (state === 'open') items = items.filter((pull) => pull.state === 'open');
  else if (state === 'closed') items = items.filter((pull) => pull.state === 'closed');
  items.sort((a, b) => a.number - b.number);
  const slice = items.slice((page - 1) * perPage, page * perPage);
  return jsonResponse(200, slice.map((pull) => pullJsonObject(repo, pull)));
}

/** Line-diff counts between two blob texts (LCS over lines; files here are small). */
function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n').filter((_, i, arr) => !(i === arr.length - 1 && arr[i] === ''));
  const newLines = newText === '' ? [] : newText.split('\n').filter((_, i, arr) => !(i === arr.length - 1 && arr[i] === ''));
  const m = oldLines.length;
  const n = newLines.length;
  if (m * n > 4_000_000) {
    return { additions: n, deletions: m };
  }
  const dp = new Uint32Array((m + 1) * (n + 1));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i * (n + 1) + j] =
        oldLines[i] === newLines[j]
          ? (dp[(i + 1) * (n + 1) + j + 1] as number) + 1
          : Math.max(dp[(i + 1) * (n + 1) + j] as number, dp[i * (n + 1) + j + 1] as number);
    }
  }
  const common = dp[0] as number;
  return { additions: n - common, deletions: m - common };
}

export interface ChangedFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** The changed files of a pull request: merge-base tree versus head tree. */
export function pullChangedFiles(repo: Repo, pull: PullRec): ChangedFile[] {
  const baseTip = repo.branchTip(pull.baseRef);
  const headTip = repo.branchTip(pull.headRef);
  if (baseTip === undefined || headTip === undefined) return [];
  const base = mergeBase(repo, baseTip, headTip);
  const baseFlat = base === null ? new Map() : flattenTree(repo, repo.headOf(base)?.tree ?? '');
  const headFlat = flattenTree(repo, repo.headOf(headTip)?.tree ?? '');
  const files: ChangedFile[] = [];
  const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of paths) {
    const before = baseFlat.get(path);
    const after = headFlat.get(path);
    if (before?.oid === after?.oid) continue;
    const oldText = before === undefined ? '' : (repo.objects.get(before.oid)?.d.toString('utf8') ?? '');
    const newText = after === undefined ? '' : (repo.objects.get(after.oid)?.d.toString('utf8') ?? '');
    const { additions, deletions } = lineDiffCounts(oldText, newText);
    files.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  files.sort((a, b) => (a.filename < b.filename ? -1 : 1));
  return files;
}

function mergePullRequest(req: WebRequest, repo: Repo, number: number): WebResponse {
  const pull = repo.pulls.get(number);
  if (pull === undefined) throw new HttpError(404, 'Not Found');
  const body = req.rawBody.length > 0 ? bodyObject(req) : {};
  const methodField = stringField(body, 'merge_method') ?? 'merge';
  const result = mergePull(repo, pull, methodField === 'merge' ? 'merge' : 'squash');
  if (!result.ok) {
    if (result.reason === 'conflict' || result.reason === 'already-merged') {
      throw new HttpError(405, 'Pull Request is not mergeable');
    }
    throw new HttpError(405, 'Pull Request is not mergeable');
  }
  return jsonResponse(200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
}

// ---------------------------------------------------------------------------
// router

export function handleRest(req: WebRequest): WebResponse {
  const segments = req.segments;
  // segments: ['api', 'v3', ...]
  const rest = segments.slice(2);
  const method = req.method;

  try {
    if (rest.length === 0) {
      if (method === 'GET') {
        return jsonResponse(200, { current_user_url: '/api/v3/user' }, { 'x-oauth-scopes': 'repo, user' });
      }
      throw new HttpError(404, 'Not Found');
    }
    if (rest[0] === 'meta' && rest.length === 1) {
      if (method === 'GET') return jsonResponse(200, { installed_version: '2026.1-forge' });
      throw new HttpError(404, 'Not Found');
    }
    if (rest[0] === 'user' && rest.length === 1) {
      if (method === 'GET') return jsonResponse(200, viewerJson());
      throw new HttpError(404, 'Not Found');
    }
    if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
      if (method === 'POST') return createRepo(req);
      if (method === 'GET') return listRepos(req);
      throw new HttpError(404, 'Not Found');
    }
    if (rest[0] === 'repos' && rest.length >= 3) {
      const owner = rest[1] as string;
      const name = rest[2] as string;
      const tail = rest.slice(3);
      if (tail.length === 0) {
        if (method === 'GET') return jsonResponse(200, repoJson(repoOr404(owner, name)));
        if (method === 'PATCH') return patchRepo(req, repoOr404(owner, name));
        if (method === 'DELETE') {
          repoOr404(owner, name);
          forge.repos.delete(name);
          return { status: 204, body: '', contentType: 'application/json; charset=utf-8' };
        }
        throw new HttpError(404, 'Not Found');
      }
      const repo = repoOr404(owner, name);
      if (tail[0] === 'branches') {
        if (tail.length === 1 && method === 'GET') return listBranches(repo);
        if (tail.length >= 2 && method === 'GET') return getBranch(repo, tail.slice(1).join('/'));
        throw new HttpError(404, 'Not Found');
      }
      if (tail[0] === 'git' && tail[1] === 'refs') {
        if (tail.length === 2 && method === 'POST') return createRef(req, repo);
        if (tail.length >= 3 && method === 'GET') return getRef(repo, `refs/${tail.slice(2).join('/')}`);
        throw new HttpError(404, 'Not Found');
      }
      if (tail[0] === 'commits' && tail.length === 1) {
        if (method === 'GET') return listCommits(req, repo);
        throw new HttpError(404, 'Not Found');
      }
      if (tail[0] === 'contents' && tail.length >= 2) {
        const path = tail.slice(1).join('/');
        if (method === 'PUT') return contentsPut(req, repo, path);
        if (method === 'GET') return contentsGet(req, repo, path);
        if (method === 'DELETE') return contentsDelete(req, repo, path);
        throw new HttpError(404, 'Not Found');
      }
      if (tail[0] === 'labels' && tail.length === 1) {
        if (method === 'POST') {
          const body = bodyObject(req);
          const labelName = stringField(body, 'name');
          if (labelName === undefined) throw new HttpError(422, 'name is required');
          const color = stringField(body, 'color') ?? 'ededed';
          if (!repo.labels.has(labelName)) repo.labels.set(labelName, { name: labelName, color });
          return jsonResponse(201, { name: labelName, color });
        }
        throw new HttpError(404, 'Not Found');
      }
      if (tail[0] === 'issues') {
        if (tail.length === 1) {
          if (method === 'POST') return createIssue(req, repo);
          if (method === 'GET') return listIssues(req, repo);
          throw new HttpError(404, 'Not Found');
        }
        const number = parseNumber(tail[1]);
        if (number === -1) throw new HttpError(404, 'Not Found');
        if (tail.length === 2) {
          if (method === 'GET') {
            const issue = issueOr404(repo, number);
            return { status: 200, body: issueJsonCached(repo, issue), contentType: 'application/json; charset=utf-8' };
          }
          if (method === 'PATCH') return patchIssue(req, repo, number);
          throw new HttpError(404, 'Not Found');
        }
        if (tail.length === 3 && tail[2] === 'comments') {
          if (method === 'POST') return createComment(req, repo, number);
          if (method === 'GET') return listComments(repo, number);
          throw new HttpError(404, 'Not Found');
        }
        throw new HttpError(404, 'Not Found');
      }
      if (tail[0] === 'pulls') {
        if (tail.length === 1) {
          if (method === 'POST') return createPull(req, repo);
          if (method === 'GET') return listPulls(req, repo);
          throw new HttpError(404, 'Not Found');
        }
        const number = parseNumber(tail[1]);
        if (number === -1) throw new HttpError(404, 'Not Found');
        if (tail.length === 2) {
          if (method === 'GET') return jsonResponse(200, pullJsonObject(repo, pullOr404(repo, number)));
          throw new HttpError(404, 'Not Found');
        }
        if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
          const pull = pullOr404(repo, number);
          return jsonResponse(200, pullChangedFiles(repo, pull));
        }
        if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
          return mergePullRequest(req, repo, number);
        }
        throw new HttpError(404, 'Not Found');
      }
      throw new HttpError(404, 'Not Found');
    }
    throw new HttpError(404, 'Not Found');
  } catch (err) {
    if (err instanceof HttpError) return errorResponse(err.status, err.message);
    throw err;
  }
}
