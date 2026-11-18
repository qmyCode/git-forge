# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/qmyCode/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/qmyCode/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

An in-memory GitHub-core forge in a single Node process, built for the
[make.fun](https://make.fun) `github-core-clone-01` bounty ("Git Forge").
Standard library only — no dependencies, no install step, no disk state.

## What it serves

- **REST v3** (`/api/v3`) — repositories, branches, git refs, commits, the
  contents API, labels, issues + comments, pull requests + files + merge, with
  `Link`-header pagination and GitHub's `{message}` error shape.
- **GraphQL v4** (`/api/graphql`) — viewer/repository/issue/pull-request reads,
  cursor pagination, the create/close/merge mutations, `node(id:)` global ids,
  `__type` introspection, and batched operations.
- **MCP** (`/mcp`) — JSON-RPC 2.0 tools (`create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`)
  over the handshake protocol revisions, acting on the same store as REST.
- **Git smart HTTP** (`/{owner}/{repo}.git`) — protocol v2 ls-refs/fetch with
  shallow support, v0 advertisements and fetch, and receive-pack with
  report-status, fast-forward enforcement and sideband framing.

All four surfaces share one content-addressed object store (SHA-1, packs read
and written in-process), so an object created through any surface reads back
identically through the others. Timestamps come from a logical clock seeded by
`MAKEFUN_TRIAL_NOW`, keeping trial replays byte-identical.

## Layout

- `main.ts` — the trial lifecycle: bind an ephemeral port, register it with
  the environment, poll for done, exit.
- `app.ts` — the HTTP shell: routing, the bearer-token gate, response writing.
- `store.ts` — state, the git object model, reachability and three-way merge.
- `git.ts` — pkt-lines, packfiles, upload-pack and receive-pack.
- `rest.ts` — the REST v3 surface.
- `graphql.ts` — a compact GraphQL parser/executor for the v4 surface.
- `mcp.ts` — the MCP endpoint and its tools.
- `web.ts` — the request/response contract between the shell and the surfaces.

## Running

The trial harness starts the entry directly:

```
node main.ts        # with MAKEFUN_ENV_URL and MAKEFUN_SHOP_TOKEN set
```
---

<sub>Entered on [make.fun](https://make.fun/?ref=wd21nvpk&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
