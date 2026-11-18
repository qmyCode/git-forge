// graphql.ts — a compact GraphQL executor for the forge's v4 surface.
//
// It implements exactly the slice of GraphQL the GitHub clients (gh,
// github-mcp-server) exercise: query/mutation operations with names and variable
// definitions, aliases, arguments (variables, strings, ints, booleans, null,
// enums, lists, input objects), inline fragments, batched operation arrays, and
// __type introspection for the types the clients feature-detect. Anything else
// is answered the way GitHub answers it: HTTP 200 with an errors array naming
// the offending field.
//
// The schema is a resolver table over the same store the REST and MCP surfaces
// use, so an object created on one surface reads identically on the others.
// Global ids are the store's base64 "<letter><numeric id>" form.

import {
  Repo,
  VIEWER,
  createIssueRec,
  createPullRec,
  forge,
  globalId,
  issueByNumId,
  mergePull,
  mergeWouldConflict,
  parseGlobalId,
  pullByNumId,
  repoByNumId,
  stamp,
  type IssueRec,
  type PullRec,
} from './store.ts';
import { pullChangedFiles } from './rest.ts';
import { HttpError, type WebRequest, type WebResponse } from './web.ts';

// ---------------------------------------------------------------------------
// lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        const text = source.slice(i + 3, end === -1 ? source.length : end);
        tokens.push({ kind: 'string', value: text });
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let text = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"' };
          if (esc === 'u') {
            text += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            text += escapes[esc] ?? esc;
            j += 2;
          }
        } else {
          text += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: text });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j += 1;
      const text = source.slice(i, j);
      const value = Number(text);
      tokens.push(text.includes('.') || text.includes('e') || text.includes('E') ? { kind: 'float', value } : { kind: 'int', value });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------
// parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: Value }>;
  selection: SelectionNode[] | null;
}

interface FragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selection: SelectionNode[];
}

interface SpreadNode {
  kind: 'spread';
  name: string;
}

type SelectionNode = FieldNode | FragmentNode | SpreadNode;

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
}

interface FragmentDef {
  typeCondition: string;
  selection: SelectionNode[];
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = lex(source);
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected '${value}'`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentDef> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        this.next();
        const type = token.value === 'mutation' ? 'mutation' : 'query';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.expectName();
        if (this.peek().kind === 'punct' && this.peek().value === '(') this.skipBalancedParens();
        // Directives after variable definitions are not used by the clients; skip simple ones.
        while (this.peek().kind === 'punct' && this.peek().value === '@') {
          this.next();
          this.expectName();
          if (this.peek().kind === 'punct' && this.peek().value === '(') this.skipBalancedParens();
        }
        operations.push({ type, name, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const onToken = this.next();
        if (onToken.kind !== 'name' || onToken.value !== 'on') throw new Error('expected on in fragment');
        const typeCondition = this.expectName();
        fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
        continue;
      }
      throw new Error('unexpected token in document');
    }
    return { operations, fragments };
  }

  private skipBalancedParens(): void {
    let depth = 0;
    for (;;) {
      const token = this.next();
      if (token.kind === 'eof') return;
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      if (token.kind === 'punct' && token.value === ')') {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    for (;;) {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        return selections;
      }
      if (token.kind === 'spread') {
        this.next();
        if (this.peek().kind === 'name' && (this.peek() as { value: string }).value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          selections.push({ kind: 'inline', typeCondition, selection: this.parseSelectionSet() });
        } else {
          selections.push({ kind: 'spread', name: this.expectName() });
        }
        continue;
      }
      selections.push(this.parseField());
    }
  }

  private parseField(): FieldNode {
    let name = this.expectName();
    let alias: string | null = null;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args: FieldNode['args'] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.next();
    }
    // Field directives are not used by the clients; skip them if present.
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.skipBalancedParens();
    }
    let selection: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selection = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selection };
  }

  private parseValue(): Value {
    const token = this.next();
    switch (token.kind) {
      case 'string':
        return { kind: 'string', value: token.value };
      case 'int':
        return { kind: 'int', value: token.value };
      case 'float':
        return { kind: 'float', value: token.value };
      case 'punct':
        if (token.value === '$') return { kind: 'variable', name: this.expectName() };
        if (token.value === '[') {
          const items: Value[] = [];
          while (!(this.peek().kind === 'punct' && this.peek().value === ']')) items.push(this.parseValue());
          this.next();
          return { kind: 'list', items };
        }
        if (token.value === '{') {
          const fields: Array<{ name: string; value: Value }> = [];
          while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
            const fieldName = this.expectName();
            this.expectPunct(':');
            fields.push({ name: fieldName, value: this.parseValue() });
          }
          this.next();
          return { kind: 'object', fields };
        }
        throw new Error(`unexpected '${token.value}' in value`);
      case 'name':
        if (token.value === 'true') return { kind: 'boolean', value: true };
        if (token.value === 'false') return { kind: 'boolean', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.value };
      default:
        throw new Error('unexpected token in value');
    }
  }
}

// ---------------------------------------------------------------------------
// value resolution

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------------------
// schema: type field lists for introspection, and resolvers

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email'],
  Repository: [
    'id',
    'databaseId',
    'name',
    'nameWithOwner',
    'owner',
    'defaultBranchRef',
    'viewerPermission',
    'hasIssuesEnabled',
    'issue',
    'issues',
    'pullRequest',
    'pullRequests',
  ],
  Ref: ['name', 'target'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'labels', 'comments', 'createdAt', 'updatedAt'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequest: [
    'id',
    'number',
    'title',
    'body',
    'state',
    'merged',
    'mergedAt',
    'headRefName',
    'baseRefName',
    'mergeable',
    'files',
    'createdAt',
    'updatedAt',
  ],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Label: ['name', 'color'],
  IssueComment: ['id', 'body', 'createdAt'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId', 'subject'],
  CommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// Runtime value wrappers: plain tagged records the resolvers switch on.
type GqlValue =
  | { type: 'User' }
  | { type: 'Repository'; repo: Repo }
  | { type: 'Ref'; name: string }
  | { type: 'Issue'; repo: Repo; issue: IssueRec }
  | { type: 'PullRequest'; repo: Repo; pull: PullRec }
  | { type: 'IssueConnection'; repo: Repo; items: IssueRec[]; pageArgs: Record<string, unknown> }
  | { type: 'PullRequestConnection'; repo: Repo; items: PullRec[]; pageArgs: Record<string, unknown> }
  | { type: 'FilesConnection'; repo: Repo; pull: PullRec; pageArgs: Record<string, unknown> }
  | { type: 'ChangedFile'; path: string; additions: number; deletions: number }
  | { type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { type: 'Label'; name: string; color: string }
  | { type: 'Comment'; id: string; body: string }
  | { type: 'Payload'; payload: Record<string, GqlValue | string | null> }
  | { type: 'Edge'; node: GqlValue; cursor: string }
  | { type: 'TypeInfo'; name: string }
  | { type: 'FieldInfo'; name: string }
  | { type: 'EnumInfo'; name: string }
  | { type: 'Scalar'; value: unknown };

interface ExecContext {
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDef>;
  errors: Array<{ message: string }>;
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

/** Apply first/after pagination to an ordered list keyed by entity number. */
function paginate<T extends { number: number }>(
  items: T[],
  args: Record<string, unknown>,
): { page: T[]; hasNextPage: boolean; endCursor: string | null } {
  let start = 0;
  const after = args.after;
  if (typeof after === 'string' && after !== '') {
    const afterNumber = numberFromCursor(after);
    if (afterNumber !== null) {
      const index = items.findIndex((item) => item.number === afterNumber);
      if (index !== -1) start = index + 1;
    }
  }
  const first = typeof args.first === 'number' ? Math.max(0, Math.floor(args.first)) : items.length;
  const page = items.slice(start, start + first);
  const hasNextPage = start + page.length < items.length;
  const last = page[page.length - 1];
  return { page, hasNextPage, endCursor: last === undefined ? null : cursorFor(last.number) };
}

function issueStateGraphql(issue: IssueRec): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullStateGraphql(pull: PullRec): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

// ---------------------------------------------------------------------------
// field resolution

function resolveField(parentType: string, parent: GqlValue | null, field: FieldNode, ctx: ExecContext): unknown {
  const args = argsOf(field, ctx.variables);
  const name = field.name;

  if (name === '__type' && parentType === 'Query') {
    const typeName = typeof args.name === 'string' ? args.name : '';
    if (TYPE_FIELDS[typeName] !== undefined || ENUM_VALUES[typeName] !== undefined) {
      return { type: 'TypeInfo', name: typeName } satisfies GqlValue;
    }
    return null;
  }

  switch (parentType) {
    case 'Query': {
      if (name === 'viewer') return { type: 'User' } satisfies GqlValue;
      if (name === 'repository') {
        const owner = args.owner;
        const repoName = args.name;
        if (owner !== VIEWER.login || typeof repoName !== 'string') return null;
        const repo = forge.repos.get(repoName);
        return repo === undefined ? null : ({ type: 'Repository', repo } satisfies GqlValue);
      }
      if (name === 'node') {
        const id = typeof args.id === 'string' ? args.id : '';
        const parsed = parseGlobalId(id);
        if (parsed === null) return null;
        if (parsed.letter === 'R') {
          const repo = repoByNumId(parsed.numId);
          return repo === undefined ? null : ({ type: 'Repository', repo } satisfies GqlValue);
        }
        if (parsed.letter === 'I') {
          const found = issueByNumId(parsed.numId);
          return found === undefined ? null : ({ type: 'Issue', repo: found.repo, issue: found.issue } satisfies GqlValue);
        }
        if (parsed.letter === 'P') {
          const found = pullByNumId(parsed.numId);
          return found === undefined ? null : ({ type: 'PullRequest', repo: found.repo, pull: found.pull } satisfies GqlValue);
        }
        return null;
      }
      break;
    }
    case 'Mutation': {
      return resolveMutation(name, args, ctx);
    }
    case 'User': {
      if (name === 'login') return VIEWER.login;
      if (name === 'id') return globalId('U', VIEWER.id);
      if (name === 'name') return VIEWER.name;
      if (name === 'email') return VIEWER.email;
      break;
    }
    case 'Repository': {
      const repo = (parent as { type: 'Repository'; repo: Repo }).repo;
      switch (name) {
        case 'id':
          return globalId('R', repo.numId);
        case 'databaseId':
          return repo.numId;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${VIEWER.login}/${repo.name}`;
        case 'owner':
          return { type: 'User' } satisfies GqlValue;
        case 'defaultBranchRef':
          return { type: 'Ref', name: repo.defaultBranch } satisfies GqlValue;
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const number = typeof args.number === 'number' ? args.number : -1;
          const issue = repo.issues.get(number);
          return issue === undefined ? null : ({ type: 'Issue', repo, issue } satisfies GqlValue);
        }
        case 'issues': {
          let items = [...repo.issues.values()];
          const states = args.states;
          if (Array.isArray(states) && states.length > 0) {
            const wanted = new Set(states.map((state) => String(state).toLowerCase()));
            items = items.filter((issue) => wanted.has(issue.state));
          }
          const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
          const direction = orderBy?.direction === 'ASC' ? 'asc' : 'desc';
          items.sort((a, b) => {
            const byTime = a.sec - b.sec || a.number - b.number;
            return direction === 'asc' ? byTime : -byTime;
          });
          return { type: 'IssueConnection', repo, items, pageArgs: args } satisfies GqlValue;
        }
        case 'pullRequest': {
          const number = typeof args.number === 'number' ? args.number : -1;
          const pull = repo.pulls.get(number);
          return pull === undefined ? null : ({ type: 'PullRequest', repo, pull } satisfies GqlValue);
        }
        case 'pullRequests': {
          const items = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
          return { type: 'PullRequestConnection', repo, items, pageArgs: args } satisfies GqlValue;
        }
      }
      break;
    }
    case 'Ref': {
      if (name === 'name') return (parent as { type: 'Ref'; name: string }).name;
      break;
    }
    case 'Issue': {
      const { issue } = parent as { type: 'Issue'; issue: IssueRec };
      switch (name) {
        case 'id':
          return globalId('I', issue.numId);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issueStateGraphql(issue);
      }
      break;
    }
    case 'PullRequest': {
      const { repo, pull } = parent as { type: 'PullRequest'; repo: Repo; pull: PullRec };
      switch (name) {
        case 'id':
          return globalId('P', pull.numId);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pullStateGraphql(pull);
        case 'merged':
          return pull.merged;
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'mergeable': {
          if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
          const baseTip = repo.branchTip(pull.baseRef);
          const headTip = repo.branchTip(pull.headRef);
          if (baseTip === undefined || headTip === undefined) return 'UNKNOWN';
          return mergeWouldConflict(repo, baseTip, headTip) ? 'CONFLICTING' : 'MERGEABLE';
        }
        case 'files':
          return { type: 'FilesConnection', repo, pull, pageArgs: args } satisfies GqlValue;
      }
      break;
    }
    case 'IssueConnection': {
      const { repo, items, pageArgs } = parent as { type: 'IssueConnection'; repo: Repo; items: IssueRec[]; pageArgs: Record<string, unknown> };
      const { page, hasNextPage, endCursor } = paginate(items, pageArgs);
      if (name === 'nodes') return page.map((issue) => ({ type: 'Issue', repo, issue }) satisfies GqlValue);
      if (name === 'pageInfo') return { type: 'PageInfo', hasNextPage, endCursor } satisfies GqlValue;
      if (name === 'totalCount') return items.length;
      break;
    }
    case 'PullRequestConnection': {
      const { repo, items, pageArgs } = parent as { type: 'PullRequestConnection'; repo: Repo; items: PullRec[]; pageArgs: Record<string, unknown> };
      const { page, hasNextPage, endCursor } = paginate(items, pageArgs);
      if (name === 'nodes') return page.map((pull) => ({ type: 'PullRequest', repo, pull }) satisfies GqlValue);
      if (name === 'pageInfo') return { type: 'PageInfo', hasNextPage, endCursor } satisfies GqlValue;
      if (name === 'totalCount') return items.length;
      break;
    }
    case 'PullRequestChangedFileConnection': {
      const { repo, pull, pageArgs } = parent as { type: 'FilesConnection'; repo: Repo; pull: PullRec; pageArgs: Record<string, unknown> };
      if (name === 'nodes') {
        const files = pullChangedFiles(repo, pull);
        const first = typeof pageArgs.first === 'number' ? Math.max(0, Math.floor(pageArgs.first)) : files.length;
        return files
          .slice(0, first)
          .map((file) => ({ type: 'ChangedFile', path: file.filename, additions: file.additions, deletions: file.deletions }) satisfies GqlValue);
      }
      break;
    }
    case 'PullRequestChangedFile': {
      const file = parent as { type: 'ChangedFile'; path: string; additions: number; deletions: number };
      if (name === 'path') return file.path;
      if (name === 'additions') return file.additions;
      if (name === 'deletions') return file.deletions;
      break;
    }
    case 'PageInfo': {
      const info = parent as { type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null };
      if (name === 'hasNextPage') return info.hasNextPage;
      if (name === 'hasPreviousPage') return false;
      if (name === 'endCursor') return info.endCursor;
      if (name === 'startCursor') return info.endCursor;
      break;
    }
    case '__Type': {
      const info = parent as { type: 'TypeInfo'; name: string };
      if (name === 'name') return info.name;
      if (name === 'kind') return ENUM_VALUES[info.name] !== undefined ? 'ENUM' : 'OBJECT';
      if (name === 'fields') {
        return (TYPE_FIELDS[info.name] ?? []).map((fieldName) => ({ type: 'FieldInfo', name: fieldName }) satisfies GqlValue);
      }
      if (name === 'enumValues') {
        return (ENUM_VALUES[info.name] ?? []).map((value) => ({ type: 'EnumInfo', name: value }) satisfies GqlValue);
      }
      if (name === 'description') return null;
      if (name === 'possibleTypes') return [];
      if (name === 'inputFields') return [];
      if (name === 'ofType') return null;
      break;
    }
    case '__Field': {
      if (name === 'name') return (parent as { type: 'FieldInfo'; name: string }).name;
      if (name === 'description') return null;
      if (name === 'args') return [];
      if (name === 'isDeprecated') return false;
      if (name === 'deprecationReason') return null;
      break;
    }
    case '__EnumValue': {
      if (name === 'name') return (parent as { type: 'EnumInfo'; name: string }).name;
      if (name === 'description') return null;
      if (name === 'isDeprecated') return false;
      if (name === 'deprecationReason') return null;
      break;
    }
    default: {
      // Mutation payloads and other record-shaped values.
      if (parent !== null && parent.type === 'Payload') {
        const value = parent.payload[name];
        return value === undefined ? null : value;
      }
      break;
    }
  }

  ctx.errors.push({ message: `Field '${name}' doesn't exist on type '${parentType}'` });
  return null;
}

function resolveMutation(name: string, args: Record<string, unknown>, ctx: ExecContext): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  switch (name) {
    case 'createIssue': {
      const parsed = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
      const repo = parsed !== null && parsed.letter === 'R' ? repoByNumId(parsed.numId) : undefined;
      if (repo === undefined) {
        ctx.errors.push({ message: 'Repository not found' });
        return null;
      }
      const issue = createIssueRec(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
      });
      return { type: 'Payload', payload: { issue: { type: 'Issue', repo, issue } } } satisfies GqlValue;
    }
    case 'closeIssue': {
      const parsed = typeof input.issueId === 'string' ? parseGlobalId(input.issueId) : null;
      const found = parsed !== null ? issueByNumId(parsed.numId) : undefined;
      if (found === undefined) {
        ctx.errors.push({ message: 'Issue not found' });
        return null;
      }
      found.issue.state = 'closed';
      found.repo.issueJsonCache.delete(found.issue.number);
      return { type: 'Payload', payload: { issue: { type: 'Issue', repo: found.repo, issue: found.issue } } } satisfies GqlValue;
    }
    case 'createPullRequest': {
      const parsed = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
      const repo = parsed !== null && parsed.letter === 'R' ? repoByNumId(parsed.numId) : undefined;
      if (repo === undefined) {
        ctx.errors.push({ message: 'Repository not found' });
        return null;
      }
      const headRefName = typeof input.headRefName === 'string' ? input.headRefName : '';
      const baseRefName = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      if (repo.branchTip(headRefName) === undefined || repo.branchTip(baseRefName) === undefined) {
        ctx.errors.push({ message: 'Invalid head or base branch' });
        return null;
      }
      const pull = createPullRec(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        headRef: headRefName,
        baseRef: baseRefName,
      });
      return { type: 'Payload', payload: { pullRequest: { type: 'PullRequest', repo, pull } } } satisfies GqlValue;
    }
    case 'mergePullRequest': {
      const parsed = typeof input.pullRequestId === 'string' ? parseGlobalId(input.pullRequestId) : null;
      const found = parsed !== null ? pullByNumId(parsed.numId) : undefined;
      if (found === undefined) {
        ctx.errors.push({ message: 'Pull request not found' });
        return null;
      }
      const method = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'MERGE';
      const result = mergePull(found.repo, found.pull, method === 'MERGE' ? 'merge' : 'squash');
      if (!result.ok) {
        ctx.errors.push({ message: `Pull request is not mergeable (${result.reason})` });
        return null;
      }
      return { type: 'Payload', payload: { pullRequest: { type: 'PullRequest', repo: found.repo, pull: found.pull } } } satisfies GqlValue;
    }
    case 'addComment': {
      const parsed = typeof input.subjectId === 'string' ? parseGlobalId(input.subjectId) : null;
      const found = parsed !== null ? issueByNumId(parsed.numId) : undefined;
      if (found === undefined) {
        ctx.errors.push({ message: 'Subject not found' });
        return null;
      }
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = { numId: forge.entityId(), body, sec: stamp() };
      found.issue.comments.push(comment);
      found.repo.issueJsonCache.delete(found.issue.number);
      const node: GqlValue = { type: 'Comment', id: globalId('C', comment.numId), body };
      return {
        type: 'Payload',
        payload: { commentEdge: { type: 'Payload', payload: { node, cursor: cursorFor(found.issue.number) } } },
      } satisfies GqlValue;
    }
    default: {
      ctx.errors.push({ message: `Field '${name}' doesn't exist on type 'Mutation'` });
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// execution

function typeNameOf(value: unknown): string {
  if (value !== null && typeof value === 'object' && 'type' in (value as Record<string, unknown>)) {
    const tag = (value as { type: string }).type;
    switch (tag) {
      case 'User':
        return 'User';
      case 'Repository':
        return 'Repository';
      case 'Ref':
        return 'Ref';
      case 'Issue':
        return 'Issue';
      case 'PullRequest':
        return 'PullRequest';
      case 'IssueConnection':
        return 'IssueConnection';
      case 'PullRequestConnection':
        return 'PullRequestConnection';
      case 'FilesConnection':
        return 'PullRequestChangedFileConnection';
      case 'ChangedFile':
        return 'PullRequestChangedFile';
      case 'PageInfo':
        return 'PageInfo';
      case 'Label':
        return 'Label';
      case 'Comment':
        return 'IssueComment';
      case 'TypeInfo':
        return '__Type';
      case 'FieldInfo':
        return '__Field';
      case 'EnumInfo':
        return '__EnumValue';
      case 'Payload':
        return 'Payload';
      case 'Edge':
        return 'Edge';
      default:
        return 'Unknown';
    }
  }
  return 'Unknown';
}

function completeValue(value: unknown, field: FieldNode, ctx: ExecContext, parentType: string): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item) => completeValue(item, field, ctx, parentType));
  }
  if (typeof value === 'object' && 'type' in (value as Record<string, unknown>)) {
    const tag = (value as { type: string }).type;
    if (tag === 'Comment') {
      const comment = value as { type: 'Comment'; id: string; body: string };
      if (field.selection === null) return comment.id;
      const out: Record<string, unknown> = {};
      for (const selection of field.selection) {
        if (selection.kind !== 'field') continue;
        const key = selection.alias ?? selection.name;
        if (selection.name === 'id') out[key] = comment.id;
        else if (selection.name === 'body') out[key] = comment.body;
        else ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type 'IssueComment'` });
      }
      return out;
    }
    if (tag === 'Payload') {
      // Payload subfields resolve through resolveField's Payload branch, typed by field name.
      const out: Record<string, unknown> = {};
      for (const selection of field.selection ?? []) {
        if (selection.kind !== 'field') continue;
        const key = selection.alias ?? selection.name;
        const sub = resolveField('Payload', value as GqlValue, selection, ctx);
        out[key] = completeValue(sub, selection, ctx, 'Payload');
      }
      return out;
    }
    if (field.selection === null) return null;
    return executeSelectionSet(value as GqlValue, typeNameOf(value), field.selection, ctx);
  }
  return value;
}

function executeSelectionSet(parent: GqlValue | null, parentType: string, selections: SelectionNode[], ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === parentType) {
        Object.assign(out, executeSelectionSet(parent, parentType, selection.selection, ctx));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && fragment.typeCondition === parentType) {
        Object.assign(out, executeSelectionSet(parent, parentType, fragment.selection, ctx));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    const raw = resolveField(parentType, parent, selection, ctx);
    out[key] = completeValue(raw, selection, ctx, parentType);
  }
  return out;
}

interface OperationRequest {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

function executeOperation(request: OperationRequest): Record<string, unknown> {
  const ctx: ExecContext = {
    variables: request.variables ?? {},
    fragments: new Map(),
    errors: [],
  };
  let document: { operations: OperationNode[]; fragments: Map<string, FragmentDef> };
  try {
    document = new Parser(request.query).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  ctx.fragments = document.fragments;
  let operation: OperationNode | undefined;
  if (request.operationName !== undefined && request.operationName !== '') {
    operation = document.operations.find((op) => op.name === request.operationName);
  }
  operation ??= document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'No operation in document' }] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(null, rootType, operation.selection, ctx);
  const response: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) response.errors = ctx.errors;
  return response;
}

// ---------------------------------------------------------------------------
// HTTP entry

export function handleGraphql(req: WebRequest): WebResponse {
  if (req.method !== 'POST') throw new HttpError(405, 'GraphQL only accepts POST');
  const body = req.json();
  if (Array.isArray(body)) {
    const results = body.map((entry) => {
      const operation = (entry ?? {}) as OperationRequest;
      if (typeof operation.query !== 'string') return { errors: [{ message: 'Missing query' }] };
      return executeOperation(operation);
    });
    return { status: 200, body: JSON.stringify(results), contentType: 'application/json; charset=utf-8' };
  }
  if (body === null || typeof body !== 'object' || typeof (body as OperationRequest).query !== 'string') {
    throw new HttpError(400, 'A GraphQL request needs a query string');
  }
  const result = executeOperation(body as OperationRequest);
  return { status: 200, body: JSON.stringify(result), contentType: 'application/json; charset=utf-8' };
}
