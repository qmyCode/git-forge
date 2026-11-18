// store.ts — the forge's entire state and git object model.
//
// Everything lives in memory: one Map of repositories for the single token owner (the
// trial's viewer), and inside each repository a content-addressed object store
// (Map<oid, {t, d}>), a refs map, labels, issues, pull requests and comments. There is
// no disk and no git binary; object ids are SHA-1 over "<type> <size>\0" + bytes,
// exactly as git computes them.
//
// Determinism: wall-clock time never enters state. Timestamps come from a logical
// clock seeded by MAKEFUN_TRIAL_NOW (+1 second per stamp), so a replayed trial
// produces byte-identical exports.

import { createHash } from 'node:crypto';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  t: ObjType;
  d: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

// ---------------------------------------------------------------------------
// logical clock

function trialNowSeconds(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    const text = raw.trim();
    if (/^\d+$/.test(text)) {
      const n = Number(text);
      return Math.floor(n > 1e12 ? n / 1000 : n);
    }
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return 1735689600; // 2025-01-01T00:00:00Z, the scenario epoch
}

let clockSec = trialNowSeconds();

/** The next logical timestamp (seconds since epoch); strictly increasing. */
export function stamp(): number {
  clockSec += 1;
  return clockSec;
}

export function iso(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// object hashing and (de)serialisation

export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export interface CommitHead {
  tree: string;
  parents: string[];
}

/** Parse just the tree/parent headers of a commit object. */
export function parseCommitHead(data: Buffer): CommitHead {
  let tree = '';
  const parents: string[] = [];
  let pos = 0;
  while (pos < data.length) {
    const nl = data.indexOf(0x0a, pos);
    if (nl === -1 || nl === pos) break; // blank line: headers end
    const line = data.subarray(pos, nl).toString('utf8');
    if (line.startsWith('tree ')) tree = line.slice(5, 45);
    else if (line.startsWith('parent ')) parents.push(line.slice(7, 47));
    else if (line.startsWith('author ')) break;
    pos = nl + 1;
  }
  return { tree, parents };
}

/** The commit message (everything after the blank line). */
export function commitMessage(data: Buffer): string {
  const blank = data.indexOf('\n\n');
  return blank === -1 ? '' : data.subarray(blank + 2).toString('utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const sp = data.indexOf(0x20, pos);
    const nul = data.indexOf(0x00, sp + 1);
    entries.push({
      mode: data.subarray(pos, sp).toString('ascii'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    pos = nul + 21;
  }
  return entries;
}

/** git's tree sort: byte order of the name, directories as if suffixed with '/'. */
function treeEntryCompare(a: TreeEntry, b: TreeEntry): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  return Buffer.compare(Buffer.from(an, 'utf8'), Buffer.from(bn, 'utf8'));
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(treeEntryCompare);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  message: string;
  authorName: string;
  authorEmail: string;
  sec: number;
}): Buffer {
  const who = `${fields.authorName} <${fields.authorEmail}> ${fields.sec} +0000`;
  let text = `tree ${fields.tree}\n`;
  for (const parent of fields.parents) text += `parent ${parent}\n`;
  text += `author ${who}\ncommitter ${who}\n\n${fields.message}`;
  return Buffer.from(text, 'utf8');
}

/** The target oid of an annotated tag object. */
export function parseTagTarget(data: Buffer): string {
  const nl = data.indexOf(0x0a);
  const first = data.subarray(0, nl === -1 ? data.length : nl).toString('utf8');
  return first.startsWith('object ') ? first.slice(7, 47) : '';
}

/** Peel an oid through tag objects until a non-tag object; null when unresolvable. */
export function peel(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let guard = 0; guard < 16; guard += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined) return null;
    if (obj.t !== 'tag') return current;
    current = parseTagTarget(obj.d);
  }
  return null;
}

// ---------------------------------------------------------------------------
// repository state

export interface CommentRec {
  numId: number;
  body: string;
  sec: number;
}

export interface IssueRec {
  numId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  sec: number;
  comments: CommentRec[];
}

export interface PullRec {
  numId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  sec: number;
  mergedSec: number | null;
  mergeSha: string | null;
}

export class Repo {
  readonly name: string;
  description = '';
  isPrivate = false;
  readonly createdSec: number;
  /** Numeric database id (also the REST `id`); unique across all entities. */
  readonly numId: number;
  readonly objects = new Map<string, GitObj>();
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, { name: string; color: string }>();
  readonly issues = new Map<number, IssueRec>();
  readonly pulls = new Map<number, PullRec>();
  /** Issues and pull requests share one per-repo number sequence (GitHub semantics). */
  nextNumber = 1;
  /** Bumped on any object/ref mutation; invalidates the fetch caches below. */
  version = 0;
  /** Serialised REST issue bodies, keyed by issue number; dropped on mutation. */
  readonly issueJsonCache = new Map<number, string>();
  /** Memoised upload-pack responses (framed bytes), keyed by request shape. */
  packCache = new Map<string, Buffer>();
  /** Memoised ls-refs response bodies, keyed by argument shape. */
  lsRefsCache = new Map<string, Buffer>();
  /** Parsed commit headers, memoised per oid (objects are immutable). */
  readonly commitHeads = new Map<string, CommitHead>();
  /** Parsed tree entries, memoised per oid. */
  readonly treeEntries = new Map<string, TreeEntry[]>();
  /** Mergeability verdicts keyed by `${baseSha}|${headSha}`. */
  readonly mergeableCache = new Map<string, boolean>();

  constructor(name: string, numId: number) {
    this.name = name;
    this.numId = numId;
    this.createdSec = stamp();
  }

  get defaultBranch(): string {
    return 'main';
  }

  headOf(ref: string): CommitHead | undefined {
    let head = this.commitHeads.get(ref);
    if (head === undefined) {
      const obj = this.objects.get(ref);
      if (obj === undefined || obj.t !== 'commit') return undefined;
      head = parseCommitHead(obj.d);
      this.commitHeads.set(ref, head);
    }
    return head;
  }

  treeOf(oid: string): TreeEntry[] | undefined {
    let entries = this.treeEntries.get(oid);
    if (entries === undefined) {
      const obj = this.objects.get(oid);
      if (obj === undefined || obj.t !== 'tree') return undefined;
      entries = parseTree(obj.d);
      this.treeEntries.set(oid, entries);
    }
    return entries;
  }

  store(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) {
      this.objects.set(oid, { t: type, d: data });
      this.version += 1;
      this.packCache = new Map();
      this.lsRefsCache = new Map();
    }
    return oid;
  }

  setRef(ref: string, oid: string): void {
    if (this.refs.get(ref) !== oid) {
      this.refs.set(ref, oid);
      this.version += 1;
      this.packCache = new Map();
      this.lsRefsCache = new Map();
      this.mergeableCache.clear();
    }
  }

  deleteRef(ref: string): void {
    if (this.refs.delete(ref)) {
      this.version += 1;
      this.packCache = new Map();
      this.lsRefsCache = new Map();
      this.mergeableCache.clear();
    }
  }

  branchTip(branch: string): string | undefined {
    return this.refs.get(`refs/heads/${branch}`);
  }

  /** Resolve a revision: branch name, tag name, full ref, or raw oid. */
  resolveRef(rev: string): string | undefined {
    if (this.refs.has(rev)) return this.refs.get(rev);
    const branch = this.refs.get(`refs/heads/${rev}`);
    if (branch !== undefined) return branch;
    const tag = this.refs.get(`refs/tags/${rev}`);
    if (tag !== undefined) return tag;
    if (/^[0-9a-f]{40}$/.test(rev) && this.objects.has(rev)) return rev;
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// the forge

let nextEntityId = 1;

export class Forge {
  readonly repos = new Map<string, Repo>();

  createRepo(name: string): Repo {
    const repo = new Repo(name, nextEntityId);
    nextEntityId += 1;
    this.repos.set(name, repo);
    return repo;
  }

  entityId(): number {
    const id = nextEntityId;
    nextEntityId += 1;
    return id;
  }
}

/** The process-wide forge instance every surface shares. */
export const forge = new Forge();

// ---------------------------------------------------------------------------
// reachability

/** Every oid reachable from `roots` (commit → tree + parents, tree → entries, tag → target). */
export function closure(repo: Repo, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const root of roots) if (root !== ZERO_OID) stack.push(root);
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    seen.add(oid);
    if (obj.t === 'commit') {
      const head = repo.headOf(oid);
      if (head !== undefined) {
        stack.push(head.tree);
        for (const parent of head.parents) stack.push(parent);
      }
    } else if (obj.t === 'tree') {
      const entries = repo.treeOf(oid);
      if (entries !== undefined) {
        for (const entry of entries) if (entry.mode !== '160000') stack.push(entry.oid);
      }
    } else if (obj.t === 'tag') {
      stack.push(parseTagTarget(obj.d));
    }
  }
  return seen;
}

/**
 * Depth-limited closure for shallow fetches. A commit's depth is 1 + the shortest
 * distance from any want; a commit is included when its depth ≤ `depth`, and the
 * boundary commits (included commits whose parents are cut) are reported. Non-commit
 * objects follow their owning commit: a commit's tree and blobs come with the commit.
 */
export function depthClosure(
  repo: Repo,
  wants: readonly string[],
  depth: number,
): { objects: Set<string>; boundary: string[] } {
  const objects = new Set<string>();
  const depthOf = new Map<string, number>();
  const queue: string[] = [];
  for (const want of wants) {
    const commit = peel(repo, want);
    if (commit !== null && !depthOf.has(commit)) {
      depthOf.set(commit, 1);
      queue.push(commit);
    }
    // A wanted tag object itself is always delivered.
    if (repo.objects.has(want)) objects.add(want);
  }
  const boundary: string[] = [];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    const d = depthOf.get(oid) as number;
    const head = repo.headOf(oid);
    if (head === undefined) continue;
    objects.add(oid);
    addTreeRecursive(repo, head.tree, objects);
    if (d < depth) {
      for (const parent of head.parents) {
        if (!depthOf.has(parent)) {
          depthOf.set(parent, d + 1);
          queue.push(parent);
        }
      }
    } else if (head.parents.length > 0) {
      // At the depth limit with parents left behind: this commit is the boundary.
      boundary.push(oid);
    }
  }
  return { objects, boundary };
}

function addTreeRecursive(repo: Repo, treeOid: string, into: Set<string>): void {
  if (into.has(treeOid)) return;
  const entries = repo.treeOf(treeOid);
  if (entries === undefined) return;
  into.add(treeOid);
  for (const entry of entries) {
    if (entry.mode === '40000') addTreeRecursive(repo, entry.oid, into);
    else if (entry.mode !== '160000') into.add(entry.oid);
  }
}

/** True when `ancestor` is reachable from `descendant` through parent links. */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const head = repo.headOf(oid);
    if (head !== undefined) for (const parent of head.parents) stack.push(parent);
  }
  return false;
}

/** The best common ancestor of two commits, or null when unrelated. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsOfA = new Map<string, number>();
  let frontier: Array<[string, number]> = [[a, 0]];
  while (frontier.length > 0) {
    const next: Array<[string, number]> = [];
    for (const [oid, depth] of frontier) {
      if (ancestorsOfA.has(oid)) continue;
      ancestorsOfA.set(oid, depth);
      const head = repo.headOf(oid);
      if (head !== undefined) for (const parent of head.parents) next.push([parent, depth + 1]);
    }
    frontier = next;
  }
  const seen = new Set<string>();
  let queue: Array<[string, number]> = [[b, 0]];
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  while (queue.length > 0) {
    const next: Array<[string, number]> = [];
    for (const [oid, depth] of queue) {
      if (seen.has(oid)) continue;
      seen.add(oid);
      const depthA = ancestorsOfA.get(oid);
      if (depthA !== undefined && depthA + depth < bestScore) {
        best = oid;
        bestScore = depthA + depth;
      }
      const head = repo.headOf(oid);
      if (head !== undefined) for (const parent of head.parents) next.push([parent, depth + 1]);
    }
    queue = next;
  }
  return best;
}

// ---------------------------------------------------------------------------
// trees as flat path maps, three-way merge, and tree rebuilding

export interface FlatEntry {
  oid: string;
  mode: string;
}

/** Flatten a tree (by oid) into a Map of path → blob entry. */
export function flattenTree(repo: Repo, treeOid: string, prefix = '', into = new Map<string, FlatEntry>()): Map<string, FlatEntry> {
  const entries = repo.treeOf(treeOid);
  if (entries === undefined) return into;
  for (const entry of entries) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, into);
    else into.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return into;
}

/** Rebuild nested tree objects from a flat path map; returns the root tree oid. */
export function buildTreeFromFlat(repo: Repo, flat: ReadonlyMap<string, FlatEntry>): string {
  interface Dir {
    files: Map<string, FlatEntry>;
    dirs: Map<string, Dir>;
  }
  const make = (): Dir => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i] as string;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name) as Dir;
    }
    node.files.set(segments[segments.length - 1] as string, entry);
  }
  const build = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of dir.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of dir.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return repo.store('tree', buildTree(entries));
  };
  return build(root);
}

export interface MergeOutcome {
  tree: string;
  conflict: boolean;
}

/**
 * File-level three-way merge of two tips against their merge base. A path both
 * sides changed to different contents conflicts; anything else resolves.
 */
export function threeWayMerge(repo: Repo, baseTip: string, headTip: string): MergeOutcome {
  const base = mergeBase(repo, baseTip, headTip);
  const baseTree = base === null ? null : (repo.headOf(base)?.tree ?? null);
  const oursTree = repo.headOf(baseTip)?.tree;
  const theirsTree = repo.headOf(headTip)?.tree;
  if (oursTree === undefined || theirsTree === undefined) return { tree: oursTree ?? '', conflict: true };
  const baseFlat = baseTree === null ? new Map<string, FlatEntry>() : flattenTree(repo, baseTree);
  const oursFlat = flattenTree(repo, oursTree);
  const theirsFlat = flattenTree(repo, theirsTree);
  const merged = new Map<string, FlatEntry>();
  let conflict = false;
  const paths = new Set<string>([...baseFlat.keys(), ...oursFlat.keys(), ...theirsFlat.keys()]);
  for (const path of paths) {
    const b = baseFlat.get(path);
    const o = oursFlat.get(path);
    const t = theirsFlat.get(path);
    const sameOT = o?.oid === t?.oid && o?.mode === t?.mode;
    if (sameOT) {
      if (o !== undefined) merged.set(path, o);
      continue;
    }
    const oursChanged = o?.oid !== b?.oid || o?.mode !== b?.mode;
    const theirsChanged = t?.oid !== b?.oid || t?.mode !== b?.mode;
    if (oursChanged && theirsChanged) {
      conflict = true;
      if (o !== undefined) merged.set(path, o);
    } else if (theirsChanged) {
      if (t !== undefined) merged.set(path, t);
    } else if (o !== undefined) {
      merged.set(path, o);
    }
  }
  return { tree: buildTreeFromFlat(repo, merged), conflict };
}

/** Whether merging `headTip` into `baseTip` would conflict (memoised per repo). */
export function mergeWouldConflict(repo: Repo, baseTip: string, headTip: string): boolean {
  const key = `${baseTip}|${headTip}`;
  let verdict = repo.mergeableCache.get(key);
  if (verdict === undefined) {
    verdict = threeWayMerge(repo, baseTip, headTip).conflict;
    repo.mergeableCache.set(key, verdict);
  }
  return verdict;
}

// ---------------------------------------------------------------------------
// global ids (GraphQL Relay-style): base64 of "<letter><numeric id>"

export function globalId(letter: string, numId: number): string {
  return Buffer.from(`${letter}${numId}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { letter: string; numId: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const match = /^([A-Z])(\d+)$/.exec(text);
    if (match === null) return null;
    return { letter: match[1] as string, numId: Number(match[2]) };
  } catch {
    return null;
  }
}

/** Find a repository by its numeric id. */
export function repoByNumId(numId: number): Repo | undefined {
  for (const repo of forge.repos.values()) if (repo.numId === numId) return repo;
  return undefined;
}

/** Find an issue (repo + record) by its global numeric id. */
export function issueByNumId(numId: number): { repo: Repo; issue: IssueRec } | undefined {
  for (const repo of forge.repos.values()) {
    for (const issue of repo.issues.values()) if (issue.numId === numId) return { repo, issue };
  }
  return undefined;
}

/** Find a pull request (repo + record) by its global numeric id. */
export function pullByNumId(numId: number): { repo: Repo; pull: PullRec } | undefined {
  for (const repo of forge.repos.values()) {
    for (const pull of repo.pulls.values()) if (pull.numId === numId) return { repo, pull };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// shared domain operations (REST, GraphQL and MCP all funnel through these)

export function createIssueRec(
  repo: Repo,
  input: { title: string; body: string; labels?: string[] },
): IssueRec {
  const issue: IssueRec = {
    numId: forge.entityId(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body,
    state: 'open',
    labels: [...(input.labels ?? [])],
    sec: stamp(),
    comments: [],
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

export function createPullRec(
  repo: Repo,
  input: { title: string; body: string; headRef: string; baseRef: string },
): PullRec {
  const pull: PullRec = {
    numId: forge.entityId(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body,
    state: 'open',
    merged: false,
    headRef: input.headRef,
    baseRef: input.baseRef,
    sec: stamp(),
    mergedSec: null,
    mergeSha: null,
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

export type MergeResult =
  | { ok: true; sha: string }
  | { ok: false; reason: 'not-found' | 'conflict' | 'already-merged' | 'no-commits' };

/**
 * Merge a pull request into its base branch. `method` 'squash' lands one commit
 * whose parent is the base tip; 'merge' lands a two-parent merge commit.
 */
export function mergePull(repo: Repo, pull: PullRec, method: 'squash' | 'merge'): MergeResult {
  if (pull.merged) return { ok: false, reason: 'already-merged' };
  const baseTip = repo.branchTip(pull.baseRef);
  const headTip = repo.branchTip(pull.headRef);
  if (baseTip === undefined || headTip === undefined) return { ok: false, reason: 'no-commits' };
  const outcome = threeWayMerge(repo, baseTip, headTip);
  if (outcome.conflict) return { ok: false, reason: 'conflict' };
  const sec = stamp();
  let message: string;
  let parents: string[];
  if (method === 'merge') {
    message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`;
    parents = [baseTip, headTip];
  } else {
    message = pull.body === '' ? `${pull.title}\n` : `${pull.title}\n\n${pull.body}\n`;
    parents = [baseTip];
  }
  const commitData = buildCommit({
    tree: outcome.tree,
    parents,
    message,
    authorName: VIEWER.name,
    authorEmail: VIEWER.email,
    sec,
  });
  const sha = repo.store('commit', commitData);
  repo.setRef(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedSec = sec;
  pull.mergeSha = sha;
  repo.issueJsonCache.delete(pull.number);
  return { ok: true, sha };
}

/**
 * Commit one file change on a branch (the contents API's write path). Creates the
 * blob, rebuilds the tree chain, and lands a commit whose parent is the branch tip
 * (or no parent on an unborn branch). Returns the new commit and blob ids.
 */
export function commitFile(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): { commitSha: string; blobSha: string | null } {
  const tip = repo.branchTip(branch);
  const flat = new Map<string, FlatEntry>();
  if (tip !== undefined) {
    const head = repo.headOf(tip);
    if (head !== undefined) flattenTree(repo, head.tree, '', flat);
  }
  let blobSha: string | null = null;
  if (content === null) {
    flat.delete(path);
  } else {
    blobSha = repo.store('blob', content);
    flat.set(path, { oid: blobSha, mode: '100644' });
  }
  const tree = buildTreeFromFlat(repo, flat);
  const sec = stamp();
  const commitData = buildCommit({
    tree,
    parents: tip === undefined ? [] : [tip],
    // The message is stored verbatim: the REST commits view must read back
    // exactly what the contents call sent.
    message,
    authorName: VIEWER.name,
    authorEmail: VIEWER.email,
    sec,
  });
  const commitSha = repo.store('commit', commitData);
  repo.setRef(`refs/heads/${branch}`, commitSha);
  return { commitSha, blobSha };
}

/** Read a file's blob at a revision; null when the path or revision is absent. */
export function readFileAt(repo: Repo, rev: string, path: string): { oid: string; data: Buffer } | null {
  const tip = repo.resolveRef(rev);
  if (tip === undefined) return null;
  const commit = peel(repo, tip);
  if (commit === null) return null;
  const head = repo.headOf(commit);
  if (head === undefined) return null;
  const flat = flattenTree(repo, head.tree);
  const entry = flat.get(path);
  if (entry === undefined) return null;
  const obj = repo.objects.get(entry.oid);
  if (obj === undefined || obj.t !== 'blob') return null;
  return { oid: entry.oid, data: obj.d };
}

/** List a directory's immediate entries at a revision. */
export function listDirAt(
  repo: Repo,
  rev: string,
  dirPath: string,
): Array<{ name: string; path: string; type: 'file' | 'dir'; sha: string }> | null {
  const tip = repo.resolveRef(rev);
  if (tip === undefined) return null;
  const commit = peel(repo, tip);
  if (commit === null) return null;
  const head = repo.headOf(commit);
  if (head === undefined) return null;
  let treeOid = head.tree;
  if (dirPath !== '') {
    for (const segment of dirPath.split('/')) {
      const entries = repo.treeOf(treeOid);
      const next = entries?.find((entry) => entry.name === segment && entry.mode === '40000');
      if (next === undefined) return null;
      treeOid = next.oid;
    }
  }
  const entries = repo.treeOf(treeOid);
  if (entries === undefined) return null;
  return entries.map((entry) => ({
    name: entry.name,
    path: dirPath === '' ? entry.name : `${dirPath}/${entry.name}`,
    type: entry.mode === '40000' ? ('dir' as const) : ('file' as const),
    sha: entry.oid,
  }));
}
