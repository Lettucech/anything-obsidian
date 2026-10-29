# IAM Middleware / Server Stack (any-obs gateway)

Date: 2026-10-28
Status: implemented (v1)

## Goal

A shared AnythingLLM instance needs an access-control front door: the
developer API key is effectively global-admin and cannot be handed to every
user's client. The gateway is that front door — a lightweight IAM proxy that
holds the single admin key, issues per-user tokens, and lets each user reach
the shared workspace plus their own personal workspace. It is the server half
of any-obs: one repo, two deployables (client stays native via `install.sh`;
the server stack ships as Docker compose: AnythingLLM + gateway).

Design decisions settled in discussion (2026-10-28):

- Middleware is core, not optional; every client connects to it.
- Git is one refresh mechanism, not the data source — shared sources may be
  git clones or plain server directories.
- The only path that writes into RAG is the vault pipeline; the gateway
  opens no passthrough upload endpoint.
- The shared workspace's feeding is the gateway's own pipeline (the old
  "feeder instance" concept is dissolved into it).
- AnythingLLM's chat UI is not exposed to users; IAM covers API/MCP traffic
  only.
- Private vaults never live on the server — the server holds only derived
  RAG data. Personal workspaces are owned by the user whose client created
  them through the proxy.

## Identity model

There is **no gateway admin token**: the gateway runs two planes with the
client's own trust model (loopback dashboard, LAN service).

- **Public plane** (21500, published on the LAN): MCP endpoint, fan-out
  search, and the user-token-authenticated AnythingLLM proxy. Every call
  needs a **user token** (named principals, `lowercase-dash`, shown once,
  stored SHA-256). Entitlements come from the gateway's own workspace
  registry — **nothing is pre-created** (no default shared workspace):
  - shared workspaces (created by an admin, any number of them) carry a
    grants list; a user reads one only when granted, so space A can go to
    one team and space B to another. Sources targeting a shared workspace
    feed it regardless of grants (the pipeline writes with the admin key).
  - personal workspaces carry exactly one owner — minted by that user's
    client through the proxy (a user token creating a workspace records the
    ownership), or pre-provisioned by an admin. Read + write for the owner;
    the shared workspaces are never user-writable — the pipeline is the
    only writer.
  A user with neither searches an empty world, which is the honest default.
- **Admin plane** (21505, host loopback only): the dashboard, its setup
  wizard, user/source/workspace management, and a full passthrough proxy
  for recovery. Reaching it requires server access (SSH/physical), which is
  the credential — the same "loopback caller is the user's delegate" rule
  the client dashboard has always used. The dashboard has four tabs —
  Overview, **Workspaces** (create shared or personal; per-shared-workspace
  grant/revoke of users; delete any), Users, and **Shared sources** (each
  source names the workspace it feeds).

### Roles

Users carry a role, set at creation and changeable any time
(`PATCH /api/gateway/users/{name}`); tokens can be replaced
(`POST /api/gateway/users/{name}/reset-token` — the old token dies on the
spot, for lost-token recovery).

- **member** (default): read shared + owned workspaces, write own. The
  regular any-obs client user.
- **admin**: member powers plus delegated administration — over the
  *public* plane their token opens the user/source management routes and
  full proxy passthrough (operations without SSH, still gated by a token
  the operator issued). Break-glass remains the loopback admin plane.
- **reader**: search/answer only. No workspace creation, no uploads, no
  embedding writes — the LAN consumer agent with the smallest blast
  radius if the token leaks.

## Proxy rules (`server/proxy-rules.mjs`)

Pure decisions per request; the gateway enforces them:

- `GET /api/v1/workspaces` → allowed, but answered from the gateway with the
  caller's entitled workspaces only (never the full list).
- `POST /api/v1/workspace/new` → allowed for user tokens; the created slug is
  recorded as owned by the caller.
- `POST /api/v1/workspace/{slug}/vector-search` and `/chat` → allowed iff the
  slug is readable by the caller.
- `POST /api/v1/document/upload/{folder}` and
  `DELETE /api/v1/document/remove-folder` → allowed iff the folder is one the
  caller may write (own `anything-obsidian-vault-*` folders).
- `POST /api/v1/workspace/{slug}/update-embeddings` → allowed iff the slug is
  writable by the caller.
- Everything else → user tokens are denied (conservative v1); the admin
  plane's passthrough identity carries recovery traffic.

## Fan-out search (`server/fanout.mjs`, `/api/gateway/search`)

One query fans out to every readable workspace, merges chunks by score, and
tags each result with its `workspace` slug — the caller never needs to know
which workspace holds the answer (same philosophy as the client's unified
workspace, one level up). Cross-workspace synthesized answers stay v2;
`rag_answer` targets one workspace (default shared).

## Shared sources pipeline (`server/sources.mjs`)

- Sources: `{id, kind: git|dir, ref, branch, intervalSeconds, enabled}`.
  `git` clones/pulls (`--ff-only`) into the data volume; `dir` reads a
  server-local directory as-is. Refresh + reindex reuses the client's
  `embedVault` pipeline unchanged (workspace = shared, `vaultId` = source id,
  per-source document folder and manifest).
- Refresh is a **job**: serialized in-process queue, auto-scheduled by
  interval, and requestable over the API/MCP — an agent's request queues an
  early run, it is never a synchronous heavy call.

## Gateway surface

- Public plane (default port 21500, published):
  - `GET /health` — no auth.
  - `POST /api/gateway/search` — user token, fan-out search.
  - `POST /api/gateway/sources/{id}/refresh`, `GET /api/gateway/jobs/{id}` —
    user token, queue a pipeline job / watch it.
  - `/mcp` — token-gated MCP (streamable HTTP): `any_obs_rag_search`
    (fan-out), `any_obs_rag_answer` (one workspace), `any_obs_shared_refresh`
    (queue job), `any_obs_job_get`. No filesystem tools, ever.
  - Everything else under `/api/` — proxied to AnythingLLM under the proxy
    rules with the admin key.
- Admin plane (default port 21505, host loopback only): the dashboard, the
  setup wizard (`/api/setup/api-key` — exists only while unconfigured),
  users and sources CRUD, and full-proxy passthrough for recovery.

## Deployment (`server/docker-compose.yml`)

- `anythingllm` (official image): published on the host **loopback only**
  (`127.0.0.1:21501`) so an admin can finish first-boot setup and mint the
  developer API key on the server itself or over an SSH tunnel; never on the
  LAN.
- `gateway`: builds from `server/Dockerfile`; the public plane publishes on
  the LAN (21500), the admin plane publishes on the host loopback only
  (21505). Volumes for AnythingLLM storage, gateway data
  (key/users/sources/jobs/manifests), and shared-source clones.

## Known v1 limits

- Gateway search tags workspace only — vault-level attribution inside
  personal workspaces stays a client-side concern (the chunks still carry
  `vaultId/path` sources).
- No chat-UI proxying, no cross-workspace answers, no per-user rate limits.
