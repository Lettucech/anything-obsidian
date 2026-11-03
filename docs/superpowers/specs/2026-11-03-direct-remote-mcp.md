# Direct Remote MCP (zero-install agents)

Date: 2026-11-03
Status: implemented

## Goal

Until now an agent had two ways to use any-obs: install a client and talk
to local AnythingLLM, or install a client joined to a server. Both required
an install. The third way makes the install optional: a coding agent on a
machine without any-obs connects straight to the server's MCP endpoint
(`http://<host>:21500/mcp`, Streamable HTTP, `Authorization: Bearer
<user-token>`) and gets the RAG-only surface.

The endpoint itself already existed (`POST /mcp` on the server's public
plane, per-request stateless `StreamableHTTPServerTransport`, token-gated).
What was missing was productization:

1. the coding-agent plugin was hard-coded to loopback, so the plugin system
   could not carry a remote connection;
2. the server surface had no discovery tool — a zero-install agent could
   not see which workspaces it may search;
3. docs treated the remote MCP as a hand-configured footnote ("add headers
   by hand"), and the console showed only the bare URL.

## Decisions

- **One plugin, configurable (v1.3.0), reviving userConfig with a reason.**
  The 2026-11-03 revert (`72a04c4`) removed `userConfig.mcp_url` because
  configurability had no valid use — join-server clients still get a local
  21503, and a URL alone could never satisfy the remote case. The valid use
  now exists: Claude Code's manifest interpolates `${user_config.*}` into
  `mcpServers.headers` values (verified against the official plugin
  reference), so `mcp_url` (default: loopback 21503) plus a `sensitive`
  `mcp_token` cover both profiles in one plugin. An empty token degrades to
  `Authorization: Bearer ` which the loopback listener treats as the
  anonymous owner-trusted caller — local behavior is unchanged.
- **Codex stays local-only in the plugin.** Interpolation of headers in
  Codex's plugin `.mcp.json` is unconfirmed, so its manifest keeps the
  fixed loopback registration. Codex direct-server agents configure
  `~/.codex/config.toml` with `url` + `bearer_token_env_var` (token from
  the environment, never a literal in the file).
- **Tool surface 3 → 4.** The server MCP gains `any_obs_vault_list`
  (entitlement-scoped workspace names + slugs from the upstream
  `/api/v1/workspaces` call, admin-role callers see all) and
  `any_obs_rag_search` gains an optional `workspace` filter (parity with
  the client profile's `vaultId`; a non-granted slug is a 403). Still no
  filesystem tools — the boundary is metadata and attributed chunks only.
- **Docs become first-class.** `docs/agent-mcp.md` names the three ways to
  use the two endpoints and carries per-harness connect commands (Claude
  Code `claude mcp add --header`, Codex TOML, generic JSON `headers`).
  README gains a "Direct remote MCP (no install)" section.
- **Transport security is documented, not implemented.** 21500 speaks
  plain HTTP by design inside a trusted LAN; crossing the public internet
  means terminating TLS in a reverse proxy first. Tokens are read access
  to granted workspace content — keep them private.
- **`connect` stays local-only.** The zero-install scenario has no CLI on
  the agent machine by definition; extending `lib/agent-connect.mjs`
  writers with header support is deferred until a real case appears
  (e.g. an installed client that prefers direct remote over the joined
  profile).

## Surface

- `server/gateway.mjs`: `buildMcpServer(identity)` — `any_obs_vault_list`,
  `any_obs_rag_search` `workspace` filter.
- `plugins/anything-obsidian/.claude-plugin/plugin.json` (v1.3.0):
  `userConfig` (`mcp_url`, `mcp_token` sensitive) + interpolated
  `mcpServers` headers; `.codex-plugin/plugin.json` version/description
  sync; `.claude-plugin/marketplace.json` version sync.
- `server/dashboard/app.js`: console instructions card shows ready-to-paste
  Claude Code / Codex connect snippets.
- `lib/plugin-skills.test.mjs`: drift-guard extended to lock the
  configurable-manifest shape and Codex's fixed loopback.
- `server/gateway.test.mjs`: four-tool assertion, entitlement-scoped
  `vault_list`, `workspace` filter grant/deny.
