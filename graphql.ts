// The GraphQL v4 surface: just enough of the language (operations, variables, fragments,
// directives, inline input values) and of GitHub's schema to serve the documents gh and
// github-mcp-server send — repository/issue/pullRequest queries, connections with cursors,
// the five mutations the suite performs, and the introspection it reads. Unknown fields answer
// the way GitHub answers: HTTP 200, the field null, and an error naming the field and its type,
// with every sibling field still resolved.

import type { ServerResponse } from 'node:http';
import {
  type Repo,
  type Issue,
  type Pull,
  type Comment,
  VIEWER,
  gid,
  parseGid,
  getRepo,
  repoById,
  listRepos,
  createIssue,
  createPull,
  mergePull,
  addComment,
  pullMergeable,
  pullFiles,
  branchTip,
  nowIso,
} from './store.ts';

// --------------------------------------------------------------------------- tokenizer

interface Tok {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread' | 'eof';
  value: string;
}

function tokenize(source: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(c)) {
      i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      toks.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(c)) {
      toks.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        const text = end < 0 ? source.slice(i + 3) : source.slice(i + 3, end);
        toks.push({ kind: 'string', value: text });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      toks.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      let isFloat = false;
      while (j < source.length && /[0-9.]/.test(source[j] as string)) {
        if (source[j] === '.') isFloat = true;
        j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      toks.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      toks.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  toks.push({ kind: 'eof', value: '' });
  return toks;
}

// --------------------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'scalar'; value: unknown }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: [string, ValueNode][] };

interface DirectiveNode {
  name: string;
  args: Map<string, ValueNode>;
}

interface FieldNode {
  kind: 'field';
  alias: string | undefined;
  name: string;
  args: Map<string, ValueNode>;
  directives: DirectiveNode[];
  selectionSet: SelectionNode[] | undefined;
}

type SelectionNode =
  | FieldNode
  | { kind: 'spread'; name: string; directives: DirectiveNode[] }
  | { kind: 'inline'; typeCondition: string | undefined; directives: DirectiveNode[]; selectionSet: SelectionNode[] };

interface OperationNode {
  opType: 'query' | 'mutation';
  name: string | undefined;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>;
}

class Parser {
  private toks: Tok[];
  private pos = 0;

  constructor(source: string) {
    this.toks = tokenize(source);
  }

  private peek(): Tok {
    return this.toks[this.pos] as Tok;
  }

  private next(): Tok {
    const tok = this.toks[this.pos] as Tok;
    this.pos += 1;
    return tok;
  }

  private expectPunct(value: string): void {
    const tok = this.next();
    if (tok.kind !== 'punct' || tok.value !== value) throw new Error(`expected '${value}', got '${tok.value}'`);
  }

  private skipPunct(value: string): boolean {
    const tok = this.peek();
    if (tok.kind === 'punct' && tok.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const tok = this.next();
    if (tok.kind !== 'name') throw new Error(`expected a name, got '${tok.value}'`);
    return tok.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      const tok = this.peek();
      if (tok.kind === 'punct' && tok.value === '{') {
        operations.push({ opType: 'query', name: undefined, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (tok.kind !== 'name') throw new Error(`unexpected token '${tok.value}'`);
      if (tok.value === 'query' || tok.value === 'mutation' || tok.value === 'subscription') {
        this.next();
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseVariableDefinitions();
        this.parseDirectives();
        operations.push({
          opType: tok.value === 'mutation' ? 'mutation' : 'query',
          name,
          selectionSet: this.parseSelectionSet(),
        });
        continue;
      }
      if (tok.value === 'fragment') {
        this.next();
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error(`expected 'on' in fragment definition`);
        const typeCondition = this.expectName();
        this.parseDirectives();
        fragments.set(name, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected definition '${tok.value}'`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.skipPunct('=')) this.parseValue();
      this.parseDirectives();
    }
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private parseDirectives(): DirectiveNode[] {
    const directives: DirectiveNode[] = [];
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      const name = this.expectName();
      const args = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseArguments() : new Map();
      directives.push({ name, args });
    }
    return directives;
  }

  private parseArguments(): Map<string, ValueNode> {
    const args = new Map<string, ValueNode>();
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.set(name, this.parseValue());
    }
    return args;
  }

  private parseValue(): ValueNode {
    const tok = this.peek();
    if (tok.kind === 'punct' && tok.value === '$') {
      this.next();
      return { kind: 'var', name: this.expectName() };
    }
    if (tok.kind === 'punct' && tok.value === '[') {
      this.next();
      const items: ValueNode[] = [];
      while (!this.skipPunct(']')) items.push(this.parseValue());
      return { kind: 'list', items };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      this.next();
      const fields: [string, ValueNode][] = [];
      while (!this.skipPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push([name, this.parseValue()]);
      }
      return { kind: 'object', fields };
    }
    if (tok.kind === 'string') {
      this.next();
      return { kind: 'scalar', value: tok.value };
    }
    if (tok.kind === 'int') {
      this.next();
      return { kind: 'scalar', value: parseInt(tok.value, 10) };
    }
    if (tok.kind === 'float') {
      this.next();
      return { kind: 'scalar', value: parseFloat(tok.value) };
    }
    if (tok.kind === 'name') {
      this.next();
      if (tok.value === 'true') return { kind: 'scalar', value: true };
      if (tok.value === 'false') return { kind: 'scalar', value: false };
      if (tok.value === 'null') return { kind: 'scalar', value: null };
      return { kind: 'scalar', value: tok.value }; // an enum value
    }
    throw new Error(`unexpected value token '${tok.value}'`);
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) selections.push(this.parseSelection());
    return selections;
  }

  private parseSelection(): SelectionNode {
    const tok = this.peek();
    if (tok.kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        const directives = this.parseDirectives();
        return { kind: 'inline', typeCondition, directives, selectionSet: this.parseSelectionSet() };
      }
      const name = this.expectName();
      const directives = this.parseDirectives();
      return { kind: 'spread', name, directives };
    }
    let name = this.expectName();
    let alias: string | undefined;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseArguments() : new Map<string, ValueNode>();
    const directives = this.parseDirectives();
    const selectionSet = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : undefined;
    return { kind: 'field', alias, name, args, directives, selectionSet };
  }
}

// --------------------------------------------------------------------------- values and wrappers

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'var':
      return variables[node.name];
    case 'scalar':
      return node.value;
    case 'list':
      return node.items.map((item) => valueOf(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of node.fields) out[key] = valueOf(value, variables);
      return out;
    }
  }
}

interface Wrap {
  __type: string;
  [key: string]: unknown;
}

const wrap = (type: string, fields: Record<string, unknown>): Wrap => ({ __type: type, ...fields });

function userWrap(login: string, id: number): Wrap {
  return wrap('User', { login, id });
}

function repoWrap(repo: Repo): Wrap {
  return wrap('Repository', { repo });
}

function issueWrap(repo: Repo, issue: Issue): Wrap {
  return wrap('Issue', { repo, issue });
}

function pullWrap(repo: Repo, pull: Pull): Wrap {
  return wrap('PullRequest', { repo, pull });
}

function commentWrap(repo: Repo, number: number, comment: Comment): Wrap {
  return wrap('Comment', { repo, number, comment });
}

/** Find an issue or pull by its global numeric id, across repositories. */
function findIssueByGlobalId(id: number): { repo: Repo; issue: Issue } | null {
  for (const repo of listRepos()) {
    for (const issue of repo.issues.values()) if (issue.id === id) return { repo, issue };
  }
  return null;
}

function findPullByGlobalId(id: number): { repo: Repo; pull: Pull } | null {
  for (const repo of listRepos()) {
    for (const pull of repo.pulls.values()) if (pull.id === id) return { repo, pull };
  }
  return null;
}

function nodeByGid(value: string): Wrap | null {
  const parsed = parseGid(value);
  if (parsed === null) return null;
  switch (parsed.kind) {
    case 'R': {
      const repo = repoById(parsed.id);
      return repo === undefined ? null : repoWrap(repo);
    }
    case 'I': {
      const found = findIssueByGlobalId(parsed.id);
      return found === null ? null : issueWrap(found.repo, found.issue);
    }
    case 'P': {
      const found = findPullByGlobalId(parsed.id);
      return found === null ? null : pullWrap(found.repo, found.pull);
    }
    case 'U':
      return parsed.id === VIEWER.id ? userWrap(VIEWER.login, VIEWER.id) : null;
    case 'C': {
      for (const repo of listRepos()) {
        for (const issue of repo.issues.values()) {
          const comment = issue.comments.find((c) => c.id === parsed.id);
          if (comment !== undefined) return commentWrap(repo, issue.number, comment);
        }
        for (const pull of repo.pulls.values()) {
          const comment = pull.comments.find((c) => c.id === parsed.id);
          if (comment !== undefined) return commentWrap(repo, pull.number, comment);
        }
      }
      return null;
    }
  }
}

// --------------------------------------------------------------------------- schema metadata (introspection)

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'rateLimit', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'reopenIssue'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'description', 'isPrivate', 'visibility', 'owner',
    'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'hasPullRequestsEnabled', 'url', 'htmlUrl',
    'createdAt', 'updatedAt', 'issue', 'issues', 'pullRequest', 'pullRequests', 'label', 'labels',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'closed', 'url', 'htmlUrl', 'repository',
    'author', 'createdAt', 'updatedAt', 'closedAt', 'labels', 'comments',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'closed', 'closedAt',
    'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeCommit', 'repository',
    'author', 'createdAt', 'updatedAt', 'files', 'url', 'htmlUrl', 'isDraft', 'additions', 'deletions', 'changedFiles',
  ],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'url'],
  Ref: ['id', 'name', 'prefix', 'target'],
  Comment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  Commit: ['id', 'oid', 'message', 'url'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'pageInfo', 'totalCount'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  RepositoryVisibility: ['PUBLIC', 'PRIVATE', 'INTERNAL'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  FileChangeType: ['ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'COPIED', 'CHANGED'],
};

const KNOWN_TYPES = new Set([...Object.keys(TYPE_FIELDS), ...Object.keys(ENUM_VALUES), '__Type', '__Field', '__EnumValue', '__Schema', '__InputValue', '__Directive']);

// --------------------------------------------------------------------------- connections

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexAfter(cursor: unknown): number {
  if (typeof cursor !== 'string') return 0;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? 0 : Number(match[1]) + 1;
  } catch {
    return 0;
  }
}

interface ConnectionResult {
  items: Wrap[];
  totalCount: number;
  hasNextPage: boolean;
  endCursor: string | null;
  startIndex: number;
}

function connect(items: readonly Wrap[], args: Map<string, unknown>): ConnectionResult {
  const start = indexAfter(args.get('after'));
  const firstRaw = args.get('first');
  const first = typeof firstRaw === 'number' ? Math.max(0, Math.floor(firstRaw)) : items.length;
  const slice = items.slice(start, start + first);
  return {
    items: slice,
    totalCount: items.length,
    hasNextPage: start + slice.length < items.length,
    endCursor: slice.length > 0 ? cursorFor(start + slice.length - 1) : null,
    startIndex: start,
  };
}

function connectionWrap(type: string, result: ConnectionResult): Wrap {
  return wrap(type, { result });
}

// --------------------------------------------------------------------------- field resolution

interface ExecCtx {
  variables: Record<string, unknown>;
  fragments: DocumentNode['fragments'];
  errors: { message: string; path?: (string | number)[] }[];
}

class UnknownField extends Error {
  constructor(field: string, type: string) {
    super(`Field '${field}' doesn't exist on type '${type}'`);
  }
}

function argsOf(field: FieldNode, ctx: ExecCtx): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [key, node] of field.args) out.set(key, valueOf(node, ctx.variables));
  return out;
}

function sortDirection(args: Map<string, unknown>): 'ASC' | 'DESC' {
  const orderBy = args.get('orderBy');
  if (typeof orderBy === 'object' && orderBy !== null) {
    const direction = (orderBy as Record<string, unknown>)['direction'];
    if (direction === 'ASC') return 'ASC';
    if (direction === 'DESC') return 'DESC';
  }
  return 'DESC';
}

function resolveField(target: Wrap, field: FieldNode, ctx: ExecCtx): unknown {
  const name = field.name;
  if (name === '__typename') return target.__type;
  const args = argsOf(field, ctx);
  switch (target.__type) {
    case 'Query': {
      if (name === 'viewer') return userWrap(VIEWER.login, VIEWER.id);
      if (name === 'repository') {
        const repo = getRepo(String(args.get('owner') ?? ''), String(args.get('name') ?? ''));
        return repo === undefined ? null : repoWrap(repo);
      }
      if (name === 'node') return nodeByGid(String(args.get('id') ?? ''));
      if (name === '__type') {
        const typeName = String(args.get('name') ?? '');
        return KNOWN_TYPES.has(typeName) ? wrap('__Type', { name: typeName }) : null;
      }
      if (name === '__schema') return wrap('__Schema', {});
      throw new UnknownField(name, 'Query');
    }
    case 'Mutation': {
      return resolveMutation(name, args);
    }
    case '__Type': {
      const typeName = target['name'] as string;
      if (name === 'name') return typeName;
      if (name === 'kind') return ENUM_VALUES[typeName] !== undefined ? 'ENUM' : 'OBJECT';
      if (name === 'description') return null;
      if (name === 'fields') {
        const fields = TYPE_FIELDS[typeName];
        return fields === undefined ? null : fields.map((fieldName) => wrap('__Field', { name: fieldName }));
      }
      if (name === 'enumValues') {
        const values = ENUM_VALUES[typeName];
        return values === undefined ? null : values.map((value) => wrap('__EnumValue', { name: value }));
      }
      if (name === 'possibleTypes' || name === 'interfaces' || name === 'inputFields' || name === 'ofType') return null;
      throw new UnknownField(name, '__Type');
    }
    case '__Field': {
      if (name === 'name') return target['name'];
      if (name === 'description') return null;
      if (name === 'args') return [];
      if (name === 'type') return wrap('__Type', { name: 'String' });
      if (name === 'isDeprecated') return false;
      if (name === 'deprecationReason') return null;
      throw new UnknownField(name, '__Field');
    }
    case '__EnumValue': {
      if (name === 'name') return target['name'];
      if (name === 'description') return null;
      if (name === 'isDeprecated') return false;
      if (name === 'deprecationReason') return null;
      throw new UnknownField(name, '__EnumValue');
    }
    case '__Schema': {
      if (name === 'types') return [...KNOWN_TYPES].map((typeName) => wrap('__Type', { name: typeName }));
      if (name === 'queryType') return wrap('__Type', { name: 'Query' });
      if (name === 'mutationType') return wrap('__Type', { name: 'Mutation' });
      if (name === 'directives') return [];
      throw new UnknownField(name, '__Schema');
    }
    case 'User': {
      if (name === 'login') return target['login'];
      if (name === 'id') return gid('U', target['id'] as number);
      if (name === 'databaseId') return target['id'];
      if (name === 'name') return target['login'] === VIEWER.login ? VIEWER.name : null;
      if (name === 'email') return target['login'] === VIEWER.login ? VIEWER.email : null;
      throw new UnknownField(name, 'User');
    }
    case 'Repository': {
      const repo = target['repo'] as Repo;
      switch (name) {
        case 'id': return gid('R', repo.id);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'description': return repo.description;
        case 'isPrivate': return repo.isPrivate;
        case 'visibility': return repo.isPrivate ? 'PRIVATE' : 'PUBLIC';
        case 'owner': return userWrap(repo.owner, repo.owner === VIEWER.login ? VIEWER.id : 0);
        case 'defaultBranchRef': {
          const tip = branchTip(repo, repo.defaultBranch);
          return tip === null ? null : wrap('Ref', { name: repo.defaultBranch, oid: tip });
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'hasPullRequestsEnabled': return true;
        case 'createdAt': return repo.createdAt;
        case 'updatedAt': return repo.updatedAt;
        case 'url': return '';
        case 'htmlUrl': return '';
        case 'issue': {
          const number = Number(args.get('number'));
          const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
          return issue === undefined ? null : issueWrap(repo, issue);
        }
        case 'issues': {
          let issues = [...repo.issues.values()];
          const states = args.get('states');
          if (Array.isArray(states) && states.length > 0) {
            const wanted = new Set(states.map((s) => String(s).toLowerCase()));
            issues = issues.filter((issue) => wanted.has(issue.state));
          }
          const direction = sortDirection(args);
          issues.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
          return connectionWrap('IssueConnection', connect(issues.map((issue) => issueWrap(repo, issue)), args));
        }
        case 'pullRequest': {
          const number = Number(args.get('number'));
          const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
          return pull === undefined ? null : pullWrap(repo, pull);
        }
        case 'pullRequests': {
          let pulls = [...repo.pulls.values()];
          const states = args.get('states');
          if (Array.isArray(states) && states.length > 0) {
            const wanted = new Set(states.map((s) => String(s)));
            pulls = pulls.filter((pull) => {
              const state = pull.merged ? 'MERGED' : pull.state.toUpperCase();
              return wanted.has(state);
            });
          }
          const direction = sortDirection(args);
          pulls.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
          return connectionWrap('PullRequestConnection', connect(pulls.map((pull) => pullWrap(repo, pull)), args));
        }
        default: throw new UnknownField(name, 'Repository');
      }
    }
    case 'Issue': {
      const repo = target['repo'] as Repo;
      const issue = target['issue'] as Issue;
      switch (name) {
        case 'id': return gid('I', issue.id);
        case 'databaseId': return issue.id;
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issue.state.toUpperCase();
        case 'closed': return issue.state === 'closed';
        case 'repository': return repoWrap(repo);
        case 'author': return userWrap(VIEWER.login, VIEWER.id);
        case 'createdAt': return issue.createdAt;
        case 'updatedAt': return issue.updatedAt;
        case 'closedAt': return issue.closedAt;
        case 'url': return '';
        case 'htmlUrl': return '';
        default: throw new UnknownField(name, 'Issue');
      }
    }
    case 'PullRequest': {
      const repo = target['repo'] as Repo;
      const pull = target['pull'] as Pull;
      switch (name) {
        case 'id': return gid('P', pull.id);
        case 'databaseId': return pull.id;
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'mergedAt': return pull.mergedAt;
        case 'closed': return pull.state === 'closed';
        case 'closedAt': return pull.closedAt;
        case 'isDraft': return false;
        case 'mergeable': {
          if (pull.merged) return 'MERGEABLE';
          if (pull.state !== 'open') return 'UNKNOWN';
          return pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
        }
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'headRefOid': return branchTip(repo, pull.headRef);
        case 'baseRefOid': return branchTip(repo, pull.baseRef);
        case 'mergeCommit': return pull.mergeCommitSha === null ? null : wrap('Commit', { oid: pull.mergeCommitSha });
        case 'repository': return repoWrap(repo);
        case 'author': return userWrap(VIEWER.login, VIEWER.id);
        case 'createdAt': return pull.createdAt;
        case 'updatedAt': return pull.updatedAt;
        case 'url': return '';
        case 'htmlUrl': return '';
        case 'files': {
          const files = pullFiles(repo, pull).map((file) =>
            wrap('PullRequestChangedFile', {
              path: file.filename,
              additions: file.additions,
              deletions: file.deletions,
              changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
            }),
          );
          return connectionWrap('PullRequestChangedFileConnection', connect(files, args));
        }
        case 'additions': return pullFiles(repo, pull).reduce((sum, f) => sum + f.additions, 0);
        case 'deletions': return pullFiles(repo, pull).reduce((sum, f) => sum + f.deletions, 0);
        case 'changedFiles': return pullFiles(repo, pull).length;
        default: throw new UnknownField(name, 'PullRequest');
      }
    }
    case 'Ref': {
      if (name === 'name') return target['name'];
      if (name === 'prefix') return 'refs/heads/';
      if (name === 'id') return gid('C', 0);
      if (name === 'target') return wrap('Commit', { oid: target['oid'] });
      throw new UnknownField(name, 'Ref');
    }
    case 'Commit': {
      if (name === 'oid') return target['oid'];
      if (name === 'id') return gid('C', 0);
      if (name === 'message') return '';
      if (name === 'url') return '';
      throw new UnknownField(name, 'Commit');
    }
    case 'Comment': {
      const comment = target['comment'] as Comment;
      if (name === 'id') return gid('C', comment.id);
      if (name === 'databaseId') return comment.id;
      if (name === 'body') return comment.body;
      if (name === 'author') return userWrap(VIEWER.login, VIEWER.id);
      if (name === 'createdAt') return comment.createdAt;
      if (name === 'updatedAt') return comment.updatedAt;
      if (name === 'url') return '';
      throw new UnknownField(name, 'Comment');
    }
    case 'PullRequestChangedFile': {
      if (name === 'path' || name === 'additions' || name === 'deletions' || name === 'changeType') return target[name];
      throw new UnknownField(name, 'PullRequestChangedFile');
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection':
    case 'LabelConnection': {
      const result = target['result'] as ConnectionResult;
      if (name === 'nodes') return result.items;
      if (name === 'totalCount') return result.totalCount;
      if (name === 'pageInfo') {
        return wrap('PageInfo', {
          hasNextPage: result.hasNextPage,
          hasPreviousPage: result.startIndex > 0,
          startCursor: result.items.length > 0 ? cursorFor(result.startIndex) : null,
          endCursor: result.endCursor,
        });
      }
      if (name === 'edges') {
        return result.items.map((item, i) =>
          wrap('Edge', { node: item, cursor: cursorFor(result.startIndex + i) }),
        );
      }
      throw new UnknownField(name, target.__type);
    }
    case 'PageInfo': {
      if (name === 'hasNextPage' || name === 'hasPreviousPage' || name === 'startCursor' || name === 'endCursor') return target[name];
      throw new UnknownField(name, 'PageInfo');
    }
    case 'Edge': {
      if (name === 'node' || name === 'cursor') return target[name];
      throw new UnknownField(name, 'Edge');
    }
    default: {
      // Payloads and other wrappers carry their fields directly.
      if (name in target && name !== '__type') return target[name];
      throw new UnknownField(name, target.__type);
    }
  }
}

function resolveMutation(name: string, args: Map<string, unknown>): Wrap {
  const input = (args.get('input') ?? {}) as Record<string, unknown>;
  const clientMutationId = typeof input['clientMutationId'] === 'string' ? (input['clientMutationId'] as string) : null;
  switch (name) {
    case 'createIssue': {
      const parsed = parseGid(String(input['repositoryId'] ?? ''));
      const repo = parsed !== null && parsed.kind === 'R' ? repoById(parsed.id) : undefined;
      if (repo === undefined) throw new Error('repository not found for createIssue');
      const issue = createIssue(repo, {
        title: String(input['title'] ?? ''),
        body: typeof input['body'] === 'string' ? (input['body'] as string) : '',
      });
      return wrap('CreateIssuePayload', { issue: issueWrap(repo, issue), clientMutationId });
    }
    case 'closeIssue': {
      const parsed = parseGid(String(input['issueId'] ?? ''));
      const found = parsed !== null && parsed.kind === 'I' ? findIssueByGlobalId(parsed.id) : null;
      if (found === null) throw new Error('issue not found for closeIssue');
      if (found.issue.state === 'open') {
        found.issue.state = 'closed';
        found.issue.closedAt = nowIso();
        found.issue.updatedAt = nowIso();
      }
      return wrap('CloseIssuePayload', { issue: issueWrap(found.repo, found.issue), clientMutationId });
    }
    case 'createPullRequest': {
      const parsed = parseGid(String(input['repositoryId'] ?? ''));
      const repo = parsed !== null && parsed.kind === 'R' ? repoById(parsed.id) : undefined;
      if (repo === undefined) throw new Error('repository not found for createPullRequest');
      const created = createPull(repo, {
        title: String(input['title'] ?? ''),
        body: typeof input['body'] === 'string' ? (input['body'] as string) : '',
        head: String(input['headRefName'] ?? ''),
        base: String(input['baseRefName'] ?? ''),
      });
      if (typeof created === 'string') throw new Error(`createPullRequest failed: ${created}`);
      return wrap('CreatePullRequestPayload', { pullRequest: pullWrap(repo, created), clientMutationId });
    }
    case 'mergePullRequest': {
      const parsed = parseGid(String(input['pullRequestId'] ?? ''));
      const found = parsed !== null && parsed.kind === 'P' ? findPullByGlobalId(parsed.id) : null;
      if (found === null) throw new Error('pull request not found for mergePullRequest');
      const methodRaw = String(input['mergeMethod'] ?? 'MERGE').toUpperCase();
      if (found.pull.state === 'open') {
        mergePull(found.repo, found.pull, methodRaw === 'MERGE' ? 'merge' : 'squash');
      }
      return wrap('MergePullRequestPayload', { pullRequest: pullWrap(found.repo, found.pull), clientMutationId });
    }
    case 'addComment': {
      const parsed = parseGid(String(input['subjectId'] ?? ''));
      if (parsed === null) throw new Error('subject not found for addComment');
      const body = String(input['body'] ?? '');
      if (parsed.kind === 'I') {
        const found = findIssueByGlobalId(parsed.id);
        if (found === null) throw new Error('subject not found for addComment');
        const comment = addComment(found.issue, body);
        const node = commentWrap(found.repo, found.issue.number, comment);
        return wrap('AddCommentPayload', {
          commentEdge: wrap('CommentEdge', { node, cursor: cursorFor(0) }),
          subject: issueWrap(found.repo, found.issue),
          clientMutationId,
        });
      }
      if (parsed.kind === 'P') {
        const found = findPullByGlobalId(parsed.id);
        if (found === null) throw new Error('subject not found for addComment');
        const comment = addComment(found.pull, body);
        const node = commentWrap(found.repo, found.pull.number, comment);
        return wrap('AddCommentPayload', {
          commentEdge: wrap('CommentEdge', { node, cursor: cursorFor(0) }),
          subject: pullWrap(found.repo, found.pull),
          clientMutationId,
        });
      }
      throw new Error('subject not found for addComment');
    }
    default:
      throw new UnknownField(name, 'Mutation');
  }
}

// --------------------------------------------------------------------------- execution

function directivesAllow(directives: readonly DirectiveNode[], ctx: ExecCtx): boolean {
  for (const directive of directives) {
    if (directive.name === 'include' || directive.name === 'skip') {
      const ifNode = directive.args.get('if');
      const flag = ifNode === undefined ? undefined : valueOf(ifNode, ctx.variables);
      if (directive.name === 'include' && flag === false) return false;
      if (directive.name === 'skip' && flag === true) return false;
    }
  }
  return true;
}

function executeSelectionSet(target: Wrap, selections: readonly SelectionNode[], ctx: ExecCtx, path: (string | number)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      if (!directivesAllow(selection.directives, ctx)) continue;
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) continue;
      Object.assign(out, executeSelectionSet(target, fragment.selectionSet, ctx, path));
      continue;
    }
    if (selection.kind === 'inline') {
      if (!directivesAllow(selection.directives, ctx)) continue;
      if (selection.typeCondition !== undefined && selection.typeCondition !== target.__type) continue;
      Object.assign(out, executeSelectionSet(target, selection.selectionSet, ctx, path));
      continue;
    }
    if (!directivesAllow(selection.directives, ctx)) continue;
    const key = selection.alias ?? selection.name;
    try {
      const value = resolveField(target, selection, ctx);
      out[key] = completeValue(value, selection, ctx, [...path, key]);
    } catch (error) {
      out[key] = null;
      ctx.errors.push({
        message: error instanceof Error ? error.message : String(error),
        path: [...path, key],
      });
    }
  }
  return out;
}

function completeValue(value: unknown, field: FieldNode, ctx: ExecCtx, path: (string | number)[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item, index) => completeValue(item, field, ctx, [...path, index]));
  }
  if (typeof value === 'object') {
    const wrapper = value as Wrap;
    if (typeof wrapper.__type === 'string') {
      if (field.selectionSet === undefined) return null;
      return executeSelectionSet(wrapper, field.selectionSet, ctx, path);
    }
    return value;
  }
  return value;
}

/** Execute one GraphQL operation object ({query, variables, operationName}) and answer the result. */
export function executeGraphQL(payload: Record<string, unknown>): Record<string, unknown> {
  const query = typeof payload['query'] === 'string' ? (payload['query'] as string) : '';
  const variables = (typeof payload['variables'] === 'object' && payload['variables'] !== null
    ? payload['variables']
    : {}) as Record<string, unknown>;
  const operationName = typeof payload['operationName'] === 'string' ? (payload['operationName'] as string) : undefined;
  let document: DocumentNode;
  try {
    document = new Parser(query).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  const operation =
    document.operations.find((op) => operationName === undefined || op.name === operationName) ?? document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'no operation in document' }] };
  const ctx: ExecCtx = { variables, fragments: document.fragments, errors: [] };
  const root = wrap(operation.opType === 'mutation' ? 'Mutation' : 'Query', {});
  const data = executeSelectionSet(root, operation.selectionSet, ctx, []);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result['errors'] = ctx.errors;
  return result;
}

/** Handle POST /api/graphql (single operation or a batch array). */
export function handleGraphQL(res: ServerResponse, rawBody: unknown): void {
  const reply = (status: number, value: unknown): void => {
    const body = Buffer.from(JSON.stringify(value), 'utf8');
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
    res.end(body);
  };
  if (Array.isArray(rawBody)) {
    reply(200, rawBody.map((item) => executeGraphQL((item ?? {}) as Record<string, unknown>)));
    return;
  }
  if (typeof rawBody !== 'object' || rawBody === null) {
    reply(400, { errors: [{ message: 'invalid request body' }] });
    return;
  }
  reply(200, executeGraphQL(rawBody as Record<string, unknown>));
}
