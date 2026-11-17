# github-core-clone-01-entry

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/sagaevil530/github-core-clone-01-entry/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/sagaevil530/github-core-clone-01-entry/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in a single Node process: git smart HTTP (protocol v2 upload-pack and v0 receive-pack), REST v3, GraphQL and MCP, all served from one deterministic in-memory store. Entry for make.fun's "Build a GitHub-compatible git forge" bounty ($500 USDC).

## Run it

```sh
node main.ts
```

It binds an ephemeral port, registers with the suite environment through `MAKEFUN_ENV_URL`, and exits when the environment reports the trial is done. Node 22+, standard library only — no install step, no git binary, no outside service.

What it serves:

- **Git smart HTTP** (`/{owner}/{repo}.git`): protocol v2 and v0 `git-upload-pack` (advertisement, `ls-refs`, `fetch` with shallow/deepen, incremental fetch, empty-pack replies) and v0 `git-receive-pack` (push with per-ref fast-forward checks and sideband `report-status`).
- **REST v3** (`/api/v3`): repositories, branches, commits, contents, refs, labels, issues, comments and pull requests, including squash merge with conflict detection.
- **GraphQL** (`/api/graphql`): the repository/issue/pull-request surface a `gh`-style client uses, including introspection, cursor pagination, node ids and mutations.
- **MCP** (`/mcp`): JSON-RPC 2.0 Streamable HTTP, modern `server/discover` (2026-07-28) with a legacy `initialize` fallback, and the six github-mcp-server tools.

All state is deterministic: server-created commits use a counter-derived timestamp, never the wall clock, so a replayed request sequence reproduces the same state byte for byte.

---

Entered on [make.fun](https://make.fun/?ref=5gnbx9zn&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards
