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

- One **gateway admin token** (env `GATEWAY_ADMIN_TOKEN`) manages users,
  sources, and gets full passthrough for recovery.
- **Users** are named principals (`lowercase-dash`), each with a bearer token
  (shown once, stored SHA-256). Entitlements:
  - read: the shared workspace plus every workspace recorded as *owned* by
    that user — ownership is captured when the user's token creates a
    workspace through the proxy, which is how an any-obs client's unified
    workspace becomes the user's personal workspace with zero client changes;
  - write: owned workspaces and their vault pipeline document folders only.
    The shared workspace is never user-writable — the gateway's own pipeline
    is its only writer (it talks to AnythingLLM directly with the admin key,
    never through the proxy).
- Personal workspaces are not pre-provisioned: pure consumers (no local
  any-obs) need only the shared workspace.

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
  caller may write (own `anything-obsidian-vault-*` folders; the shared
  folder only for `sharedWriter`).
- `POST /api/v1/workspace/{slug}/update-embeddings` → allowed iff the slug is
  writable by the caller.
- Everything else → user tokens are denied (conservative v1); the admin token
  passes through.

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

## Gateway surface (`server/gateway.mjs`, default port 21500)

- `GET /health` — no auth.
- Admin API (`GATEWAY_ADMIN_TOKEN`): users create/list/delete, sources
  create/list/delete, job status.
- `POST /api/gateway/search` — token auth, fan-out search.
- `POST /api/gateway/sources/{id}/refresh` — queues a pipeline job.
- `/mcp` — token-gated MCP (streamable HTTP): `any_obs_rag_search`
  (fan-out), `any_obs_rag_answer` (one workspace), `any_obs_shared_refresh`
  (queue job), `any_obs_job_get`. No filesystem tools, ever.
- Everything else under `/api/` — proxied to AnythingLLM under the proxy
  rules with the admin key.

## Deployment (`server/docker-compose.yml`)

- `anythingllm` (official image): published on the host **loopback only**
  (`127.0.0.1:21501`) so an admin can finish first-boot setup and mint the
  developer API key on the server itself or over an SSH tunnel; never on the
  LAN.
- `gateway`: builds from `server/Dockerfile`, published on the LAN, volumes
  for AnythingLLM storage, gateway data (users/sources/jobs/manifests), and
  shared-source clones.

## Known v1 limits

- Ownership is minted only via `POST /api/v1/workspace/new`; attaching to a
  pre-existing workspace as a user needs an admin (create-through or
  hand-edit is deliberately absent).
- Gateway search tags workspace only — vault-level attribution inside
  personal workspaces stays a client-side concern (the chunks still carry
  `vaultId/path` sources).
- No chat-UI proxying, no cross-workspace answers, no per-user rate limits.
