// The forge's single store: every surface (git smart HTTP, REST v3, GraphQL v4, MCP) reads and
// writes the objects kept here, so an object made on one surface is the same object on all of
// them. Everything lives in memory: a trial is one process and a fresh pod.
//
// Determinism: timestamps come from a logical clock seeded by MAKEFUN_TRIAL_NOW (the trial's
// opening time) and advanced one second per stamp, never from the wall clock, so two runs that
// receive the same requests produce the same bytes.

import { createHash } from 'node:crypto';

// --------------------------------------------------------------------------- identity and clock

/** The token the suite presents; in a trial it is MAKEFUN_SHOP_TOKEN in this process's env. */
export const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/**
 * The login the bearer token names. The suite's scenario is fixed-seeded, and its viewer is this
 * user; a repository belongs to this login, and the same name under any other owner is a 404.
 */
export const VIEWER = Object.freeze({
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
});

const CLOCK_BASE_MS = ((): number => {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  const parsed = raw === undefined ? Number.NaN : Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : Date.UTC(2025, 0, 1, 0, 0, 0);
})();
let clockTick = 0;

/** The next logical timestamp as an ISO string; every call advances the clock one second. */
export function nowIso(): string {
  const ms = CLOCK_BASE_MS + clockTick * 1000;
  clockTick += 1;
  return new Date(ms).toISOString();
}

/** The next logical timestamp as unix seconds (git author/committer lines). */
export function nowEpochSec(): number {
  const sec = Math.floor(CLOCK_BASE_MS / 1000) + clockTick;
  clockTick += 1;
  return sec;
}

/** The identity git commits made through the API carry. */
export function viewerIdent(): string {
  return `${VIEWER.name} <${VIEWER.email}>`;
}

// --------------------------------------------------------------------------- global ids

export type GidKind = 'R' | 'I' | 'P' | 'C' | 'U';

/** An opaque, stable GraphQL global id for one stored object (never the plain numeric id). */
export function gid(kind: GidKind, id: number): string {
  return Buffer.from(`${kind}${id}`, 'utf8').toString('base64');
}

/** Decode a global id this forge issued; null for anything else. */
export function parseGid(value: string): { kind: GidKind; id: number } | null {
  try {
    const text = Buffer.from(value, 'base64').toString('utf8');
    const match = /^([RIPCU])(\d+)$/.exec(text);
    if (match === null) return null;
    return { kind: match[1] as GidKind, id: Number(match[2]) };
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------- git object model

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GObj {
  readonly type: ObjType;
  readonly data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
const TYPE_CODE: Readonly<Record<ObjType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const CODE_TYPE: Readonly<Record<number, ObjType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
export function typeCode(type: ObjType): number {
  return TYPE_CODE[type];
}

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry order: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object from entries (sorted the way git sorts them). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object. */
export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object's bytes. `ident` is a full `Name <email>`; the timestamp is appended. */
export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  ident: string;
  timestamp: number;
  message: string;
}): Buffer {
  const who = `${fields.ident} ${fields.timestamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const out: TagView = { object: '', type: '', tag: '', tagger: '', message: blank < 0 ? '' : text.slice(blank + 2) };
  for (const line of header.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'object') out.object = value;
    else if (key === 'type') out.type = value;
    else if (key === 'tag') out.tag = value;
    else if (key === 'tagger') out.tagger = value;
  }
  return out;
}

// --------------------------------------------------------------------------- the store

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  /** Global numeric id (REST `id`, and the GraphQL id's payload). */
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labelNames: string[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GObj>;
  refs: Map<string, string>;
  /** Memoized fetch packs for repeat full clones (keyed by store size + want set). */
  packCache: Map<string, Buffer>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  /** One counter for issue and pull numbers alike (GitHub semantics). */
  nextNumber: number;
  createdAt: string;
  updatedAt: string;
}

const reposByKey = new Map<string, Repo>();
let nextRepoId = 1;
let nextIssueId = 1;
let nextPullId = 1;
let nextCommentId = 1;
let nextLabelId = 1;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

/** Create a repository owned by the viewer; null when the name is taken. */
export function createRepo(name: string, options: { description?: string; isPrivate?: boolean; defaultBranch?: string }): Repo | null {
  const key = repoKey(VIEWER.login, name);
  if (reposByKey.has(key)) return null;
  const stamp = nowIso();
  const repo: Repo = {
    id: nextRepoId,
    owner: VIEWER.login,
    name,
    description: options.description ?? '',
    isPrivate: options.isPrivate ?? false,
    defaultBranch: options.defaultBranch ?? 'main',
    objects: new Map(),
    refs: new Map(),
    packCache: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    createdAt: stamp,
    updatedAt: stamp,
  };
  nextRepoId += 1;
  reposByKey.set(key, repo);
  return repo;
}

/** The repository at owner/name, or undefined (any owner but the viewer's reads as absent). */
export function getRepo(owner: string, name: string): Repo | undefined {
  return reposByKey.get(repoKey(owner, name));
}

/** Every repository the viewer owns, in creation order. */
export function listRepos(): Repo[] {
  return [...reposByKey.values()].sort((a, b) => a.id - b.id);
}

/** Delete a repository; false when it does not exist. */
export function deleteRepo(owner: string, name: string): boolean {
  return reposByKey.delete(repoKey(owner, name));
}

/** Find a repository by its numeric id (GraphQL mutation inputs name repositories by global id). */
export function repoById(id: number): Repo | undefined {
  for (const repo of reposByKey.values()) if (repo.id === id) return repo;
  return undefined;
}

// --------------------------------------------------------------------------- object access on a repo

/** Store an object in a repo and answer its id. */
export function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): GObj | undefined {
  return repo.objects.get(oid);
}

/** Follow tag objects until a commit; null when the chain does not end at a commit. */
export function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    current = parseTag(object.data).object;
  }
  return null;
}

/** Every commit reachable from `tip`, tip included (empty set for an unknown tip). */
export function commitAncestors(repo: Repo, tip: string): Set<string> {
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return seen;
}

/** Whether `ancestor` is `tip` itself or one of its ancestors. */
export function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  return commitAncestors(repo, tip).has(ancestor);
}

/** The best common ancestor of two commits, or null when they share no history. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsOfA = commitAncestors(repo, a);
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsOfA.has(oid)) return oid;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return null;
}

/** Flatten a tree (recursively) into path -> blob oid. */
export function treeToFiles(repo: Repo, treeOid: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (oid: string, prefix: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000') walk(entry.oid, `${prefix}${entry.name}/`);
      else out.set(`${prefix}${entry.name}`, entry.oid);
    }
  };
  walk(treeOid, '');
  return out;
}

/** The files at a commit (an empty map for an unknown commit). */
export function commitFiles(repo: Repo, commitOid: string): Map<string, string> {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return new Map();
  return treeToFiles(repo, parseCommit(object.data).tree);
}

/** Build (and store) the nested trees for a flat path -> blob oid map; answers the root tree id. */
export function filesToTree(repo: Repo, files: ReadonlyMap<string, string>): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, oid] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i] as string;
      if (!node.dirs.has(segment)) node.dirs.set(segment, make());
      node = node.dirs.get(segment) as Node;
    }
    node.files.set(segments[segments.length - 1] as string, oid);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** The tree id of a commit. */
export function commitTree(repo: Repo, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/**
 * Every object reachable from `tips`: commits (with their ancestry), their trees and blobs, and
 * tag objects on the way. `exclude` objects are left out. With `depth`, a commit's generation
 * counts from the tips (a tip is generation 1) and commits past it are left out; commits named in
 * `parentless` are treated as having no parents (the client's shallow boundary).
 */
export function collectObjects(
  repo: Repo,
  tips: readonly string[],
  options: { exclude?: ReadonlySet<string>; depth?: number; parentless?: ReadonlySet<string> } = {},
): Set<string> {
  const exclude = options.exclude ?? new Set<string>();
  const depth = options.depth;
  const parentless = options.parentless ?? new Set<string>();
  const out = new Set<string>();
  const addTree = (treeOid: string): void => {
    if (out.has(treeOid) || exclude.has(treeOid)) return;
    const object = repo.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return;
    out.add(treeOid);
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000') addTree(entry.oid);
      else if (!exclude.has(entry.oid) && repo.objects.has(entry.oid)) out.add(entry.oid);
    }
  };
  // Resolve the tips to commits (through tags), remembering the tag objects themselves.
  const generations = new Map<string, number>();
  const queue: string[] = [];
  for (const tip of tips) {
    let current = tip;
    for (let hops = 0; hops < 16; hops += 1) {
      const object = repo.objects.get(current);
      if (object === undefined) break;
      if (!exclude.has(current)) out.add(current);
      if (object.type === 'commit') {
        if (!generations.has(current)) {
          generations.set(current, 1);
          queue.push(current);
        }
        break;
      }
      if (object.type !== 'tag') break;
      current = parseTag(object.data).object;
    }
  }
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    const generation = generations.get(oid) as number;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    out.add(oid);
    const commit = parseCommit(object.data);
    addTree(commit.tree);
    if (parentless.has(oid)) continue;
    if (depth !== undefined && generation >= depth) continue;
    for (const parent of commit.parents) {
      if (!generations.has(parent)) {
        generations.set(parent, generation + 1);
        queue.push(parent);
      }
    }
  }
  for (const oid of exclude) out.delete(oid);
  return out;
}

/** The generation of each commit in a depth-limited walk from `tips` (tip = 1), for shallow-info. */
export function commitGenerations(repo: Repo, tips: readonly string[]): Map<string, number> {
  const generations = new Map<string, number>();
  const queue: string[] = [];
  for (const tip of tips) {
    const commit = peelToCommit(repo, tip);
    if (commit !== null && !generations.has(commit)) {
      generations.set(commit, 1);
      queue.push(commit);
    }
  }
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    const generation = generations.get(oid) as number;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!generations.has(parent)) {
        generations.set(parent, generation + 1);
        queue.push(parent);
      }
    }
  }
  return generations;
}

// --------------------------------------------------------------------------- domain operations

/** Create a label on a repo; null when the name is taken. */
export function createLabel(repo: Repo, name: string, color: string, description: string | null): Label | null {
  if (repo.labels.has(name)) return null;
  const label: Label = { id: nextLabelId, name, color, description };
  nextLabelId += 1;
  repo.labels.set(name, label);
  return label;
}

export type IssueError = 'unknown-label';

/** Create an issue; throws an IssueError string for a label the repo does not hold. */
export function createIssue(repo: Repo, input: { title: string; body: string; labelNames?: readonly string[] }): Issue {
  const labelNames = input.labelNames ?? [];
  for (const name of labelNames) {
    if (!repo.labels.has(name)) throw 'unknown-label' as IssueError;
  }
  const stamp = nowIso();
  const issue: Issue = {
    id: nextIssueId,
    number: repo.nextNumber,
    title: input.title,
    body: input.body,
    state: 'open',
    labelNames: [...labelNames],
    comments: [],
    createdAt: stamp,
    updatedAt: stamp,
    closedAt: null,
  };
  nextIssueId += 1;
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

/** Add a comment to an issue or a pull request. */
export function addComment(target: Issue | Pull, body: string): Comment {
  const stamp = nowIso();
  const comment: Comment = { id: nextCommentId, body, createdAt: stamp, updatedAt: stamp };
  nextCommentId += 1;
  target.comments.push(comment);
  return comment;
}

/** The current tip of a branch ref, or null when the branch does not exist. */
export function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** Create a pull request; an error string when the refs do not support one. */
export function createPull(
  repo: Repo,
  input: { title: string; body: string; head: string; base: string },
): Pull | 'head-missing' | 'base-missing' | 'duplicate' {
  if (branchTip(repo, input.head) === null) return 'head-missing';
  if (branchTip(repo, input.base) === null) return 'base-missing';
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.headRef === input.head && pull.baseRef === input.base) return 'duplicate';
  }
  const stamp = nowIso();
  const pull: Pull = {
    id: nextPullId,
    number: repo.nextNumber,
    title: input.title,
    body: input.body,
    state: 'open',
    merged: false,
    headRef: input.head,
    baseRef: input.base,
    mergeCommitSha: null,
    mergedAt: null,
    comments: [],
    createdAt: stamp,
    updatedAt: stamp,
    closedAt: null,
  };
  nextPullId += 1;
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

/** The three-way file merge of head into base: the merged files, or the conflicting paths. */
export function mergeAnalysis(
  repo: Repo,
  baseTip: string,
  headTip: string,
): { files: Map<string, string>; conflicts: string[] } {
  const base = mergeBase(repo, baseTip, headTip);
  const atBase = base === null ? new Map<string, string>() : commitFiles(repo, base);
  const atBaseTip = commitFiles(repo, baseTip);
  const atHeadTip = commitFiles(repo, headTip);
  const files = new Map<string, string>();
  const conflicts: string[] = [];
  const paths = new Set([...atBase.keys(), ...atBaseTip.keys(), ...atHeadTip.keys()]);
  for (const path of paths) {
    const merged = atBase.get(path);
    const ours = atBaseTip.get(path);
    const theirs = atHeadTip.get(path);
    if (theirs === ours) {
      if (ours !== undefined) files.set(path, ours);
    } else if (merged === ours) {
      if (theirs !== undefined) files.set(path, theirs);
    } else if (merged === theirs) {
      if (ours !== undefined) files.set(path, ours);
    } else {
      conflicts.push(path);
    }
  }
  return { files, conflicts };
}

/** Whether a pull request can merge cleanly right now. */
export function pullMergeable(repo: Repo, pull: Pull): boolean {
  if (pull.state !== 'open') return false;
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return false;
  return mergeAnalysis(repo, baseTip, headTip).conflicts.length === 0;
}

/**
 * Merge a pull request into its base branch. `squash` lands one commit (parent: the base tip);
 * `merge` lands a two-parent merge commit. Answers the new commit's sha, or an error string.
 */
export function mergePull(repo: Repo, pull: Pull, method: 'squash' | 'merge'): string | 'conflict' | 'not-open' {
  if (pull.state !== 'open') return 'not-open';
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return 'conflict';
  const { files, conflicts } = mergeAnalysis(repo, baseTip, headTip);
  if (conflicts.length > 0) return 'conflict';
  const tree = filesToTree(repo, files);
  const timestamp = nowEpochSec();
  const message =
    method === 'squash'
      ? `${pull.title} (#${pull.number})\n\n${pull.body}`
      : `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
  const commit = buildCommit({
    tree,
    parents: method === 'squash' ? [baseTip] : [baseTip, headTip],
    ident: viewerIdent(),
    timestamp,
    message,
  });
  const sha = putObject(repo, 'commit', commit);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  const stamp = nowIso();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.mergedAt = stamp;
  pull.closedAt = stamp;
  pull.updatedAt = stamp;
  return sha;
}

/** Line counts of a change between two blob contents (LCS diff; blobs here are small). */
export function lineDiff(oldText: string | null, newText: string | null): { additions: number; deletions: number } {
  if (oldText === newText) return { additions: 0, deletions: 0 };
  if (oldText === null) return { additions: newText === '' ? 0 : (newText as string).split('\n').length, deletions: 0 };
  if (newText === null) return { additions: 0, deletions: oldText === '' ? 0 : oldText.split('\n').length };
  const a = oldText.split('\n');
  const b = newText.split('\n');
  if (a.length * b.length > 4_000_000) {
    // Too large for a quadratic diff; count every line as changed (the checks' files are small).
    return { additions: b.length, deletions: a.length };
  }
  const dp = new Uint32Array((a.length + 1) * (b.length + 1));
  const width = b.length + 1;
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i * width + j] = a[i] === b[j] ? (dp[(i + 1) * width + j + 1] as number) + 1 : Math.max(dp[(i + 1) * width + j] as number, dp[i * width + j + 1] as number);
    }
  }
  const common = dp[0] as number;
  return { additions: b.length - common, deletions: a.length - common };
}

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  sha: string | null;
}

/** The changed files of a pull request: merge-base tree against head tree. */
export function pullFiles(repo: Repo, pull: Pull): FileChange[] {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return [];
  const base = mergeBase(repo, baseTip, headTip);
  const atBase = base === null ? new Map<string, string>() : commitFiles(repo, base);
  const atHead = commitFiles(repo, headTip);
  const out: FileChange[] = [];
  const paths = new Set([...atBase.keys(), ...atHead.keys()]);
  for (const path of [...paths].sort()) {
    const before = atBase.get(path);
    const after = atHead.get(path);
    if (before === after) continue;
    const oldText = before === undefined ? null : (repo.objects.get(before)?.data.toString('utf8') ?? null);
    const newText = after === undefined ? null : (repo.objects.get(after)?.data.toString('utf8') ?? null);
    const { additions, deletions } = lineDiff(oldText, newText);
    out.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      sha: after ?? null,
    });
  }
  return out;
}

// --------------------------------------------------------------------------- serializers (REST shapes)

export interface UrlBase {
  /** `http://host:port` of this server, from the request's Host header. */
  origin: string;
}

export function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: gid('U', VIEWER.id),
    name: VIEWER.name,
    email: VIEWER.email,
    type: 'User',
    site_admin: false,
    avatar_url: '',
    html_url: '',
    url: '',
  };
}

export function repoJson(repo: Repo, origin: string): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    node_id: gid('R', repo.id),
    name: repo.name,
    full_name: fullName,
    private: repo.isPrivate,
    owner: userJson(),
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    language: null,
    fork: false,
    archived: false,
    disabled: false,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    html_url: `${origin}/${fullName}`,
    clone_url: `${origin}/${fullName}.git`,
    git_url: `${origin}/${fullName}.git`,
    ssh_url: `${origin}/${fullName}.git`,
    url: `${origin}/api/v3/repos/${fullName}`,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: gid('C', label.id),
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
    url: '',
  };
}

export function issueJson(repo: Repo, issue: Issue, origin: string): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    id: issue.id,
    node_id: gid('I', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labelNames
      .map((name) => repo.labels.get(name))
      .filter((label): label is Label => label !== undefined)
      .map(labelJson),
    user: userJson(),
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    url: `${origin}/api/v3/repos/${fullName}/issues/${issue.number}`,
    html_url: `${origin}/${fullName}/issues/${issue.number}`,
    repository_url: `${origin}/api/v3/repos/${fullName}`,
  };
}

export function commentJson(repo: Repo, issueNumber: number, comment: Comment, origin: string): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    id: comment.id,
    node_id: gid('C', comment.id),
    body: comment.body,
    user: userJson(),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    url: `${origin}/api/v3/repos/${fullName}/issues/comments/${comment.id}`,
    html_url: `${origin}/${fullName}/issues/${issueNumber}#issuecomment-${comment.id}`,
    issue_url: `${origin}/api/v3/repos/${fullName}/issues/${issueNumber}`,
  };
}

export function pullJson(repo: Repo, pull: Pull, origin: string): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  const headSha = branchTip(repo, pull.headRef);
  const baseSha = branchTip(repo, pull.baseRef);
  const refJson = (ref: string, sha: string | null): Record<string, unknown> => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: userJson(),
    repo: repoJson(repo, origin),
  });
  return {
    id: pull.id,
    node_id: gid('P', pull.id),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    draft: false,
    head: refJson(pull.headRef, headSha),
    base: refJson(pull.baseRef, baseSha),
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    closed_at: pull.closedAt,
    user: userJson(),
    comments: pull.comments.length,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    url: `${origin}/api/v3/repos/${fullName}/pulls/${pull.number}`,
    html_url: `${origin}/${fullName}/pull/${pull.number}`,
  };
}

/** A commit object in the REST shape (commits list and single-commit reads). */
export function commitJson(repo: Repo, oid: string, origin: string): Record<string, unknown> | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const ident = /^(.*?) <(.*?)> (\d+) /.exec(commit.author);
  const stamp = ident !== null ? new Date(Number(ident[3]) * 1000).toISOString() : repo.createdAt;
  const person = (line: string): Record<string, unknown> => {
    const match = /^(.*?) <(.*?)> (\d+) /.exec(line);
    return {
      name: match?.[1] ?? '',
      email: match?.[2] ?? '',
      date: match !== null ? new Date(Number(match[3]) * 1000).toISOString() : stamp,
    };
  };
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    sha: oid,
    node_id: gid('C', repo.id),
    commit: {
      message: commit.message.replace(/\n$/, ''),
      tree: { sha: commit.tree, url: '' },
      author: person(commit.author),
      committer: person(commit.committer),
      comment_count: 0,
    },
    author: userJson(),
    committer: userJson(),
    parents: commit.parents.map((parent) => ({ sha: parent, url: '' })),
    url: `${origin}/api/v3/repos/${fullName}/commits/${oid}`,
    html_url: `${origin}/${fullName}/commit/${oid}`,
  };
}
