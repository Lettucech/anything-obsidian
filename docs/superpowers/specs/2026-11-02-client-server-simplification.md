# Client–Server Simplification (two connection kinds, "gateway" → "server")

Date: 2026-11-02
Status: proposed

## Goal

Collapse the connection model to exactly two kinds — **local** (loopback,
owner-trusted, full tool surface) and **remote** (anything else: token-gated,
RAG-only) — and rename the public-facing component from "gateway" to
"server". The IAM concept is demoted from a peer component to the server's
internal auth subsystem. This removes the historical accident of two
parallel remote surfaces (LAN MCP 21504 + agent tokens, gateway 21500 +
user tokens) that answer the same security question twice with different
answers.

Design decisions settled in discussion (2026-11-02):

- LAN vs public is a bind address, not a trust model. Everything off
  loopback is zero-trust: token authN + grant authZ + RAG-only.
- The server plane fronts an AnythingLLM-compatible API only. Raw vault
  files never leave loopback — enforced by construction (the remote MCP
  profile never registers file/management tools), not by convention.
- Fan-out/multi-workspace search is a shared library concern, not a
  gateway feature (extracted separately, see the per-vault spec).
- Admin UI belongs to the dashboard control plane (loopback-protected),
  not to the server plane. "Server" names the opt-in public listener.
- One token system: every remote identity is a server user with grants.
  Owner needs no token; loopback is the owner's credential.

## Scope

### 1. Rename gateway → server (user-facing only)

- CLI: `anything-obsidian server on|off|status` replaces `gateway …`;
  `gateway …` remains a deprecated alias for two release cycles that prints
  a deprecation line and forwards. `setup --server` becomes the real name
  (it already exists as an alias for "setup + enable").
- `installation.json`: `roles` entry `"gateway"` → `"server"`. First
  start/restart after upgrade migrates in place (same mechanism as the
  single-process merge migration); the `lan` flag is consumed by the LAN
  retirement below.
- Dashboard: Gateway card and console labels say **Server**. URL paths
  `/gateway/` and `/api/gateway/*` are **kept unchanged** (bookmark and
  test compatibility); docs refer to them as the server console.
- On-disk `gateway/gateway.json` keeps its filename this round
  (credential-file migration is risk without benefit); recorded as
  follow-up debt. Docs describe it as the server's config file.
- `docs/` and README updated to the 3-component model: AnythingLLM
  (external upstream) / client (local + remote) / server (opt-in public
  plane with an auth subsystem).

### 2. Retire the LAN MCP (21504) and agent tokens

- The 21504 listener and `lib/agent-tokens.mjs` are removed. `lan on|off`
  becomes a no-op that prints: LAN access is now a server feature — run
  `anything-obsidian server on` and issue user tokens.
- Migration: both token systems store SHA-256 hex hashes, so on first
  start after upgrade, an install whose `installation.json` carried the
  `lan` flag copies each agent entry (name, tokenHash) into the server
  user store with a default grant set (read all vault workspaces — the
  visibility LAN agents had). Token holders keep working without
  re-issuance. The old `agent-tokens/` directory is left on disk, never
  deleted.
- Failure mode: if the copy fails (corrupt store, name collision), log a
  warning and continue; `server status` reports migration outcome.

### 3. Server plane contract (unchanged behavior, now a promise)

- AuthN: Bearer user token. AuthZ: grants → the workspace list the façade
  may search. Server holds the only admin key.
- Remote MCP profile registers RAG tools only (`any_obs_vault_list`,
  `any_obs_rag_search`) — no file, directory, or management tools.
- No passthrough upload; the pipeline remains the only writer.

## Out of scope

- The unified → per-vault workspace migration (separate spec, same date).
- Renaming on-disk files/dirs (`gateway.json`, `agent-tokens/`).
- Docker flavor alignment (Docker keeps its own model per AGENTS.md).

## Migration / verification

1. Upgrade an install with `roles: ["client", "lan"]` → expect roles
   rewritten, tokens copied, `status --json` ok, 21504 absent.
2. Upgrade a gateway install → roles `["server", …]`, gateway.json
   untouched, 21500 serving with existing user tokens.
3. Fresh standalone install (server off) → no server listener, local MCP
   full tool surface unchanged.
4. `npm test` green across bin/ dashboard/ lib/ server/.
