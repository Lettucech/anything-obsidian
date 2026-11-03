# Agent MCP setup

Anything Obsidian (short name: any-obs) serves two MCP endpoints, and an
agent can use them three ways:

1. **Local install** — the owner's machine talks to its own loopback MCP
   (port 21503): RAG plus raw vault reads and `any_obs_*` management
   tools (vault lifecycle, sync/embed jobs, service control) that proxy
   the dashboard API.
2. **Local install joined to a server** — same loopback endpoint; the
   install is configured with a server URL and user token, so RAG comes
   from the server's index and shared workspaces.
3. **Zero-install direct remote MCP** — no any-obs install at all: an
   agent connects straight to the server's `:21500/mcp` endpoint with a
   user token (RAG-only; see below).

Neither endpoint offers tools that write vault source files.

## Local agent

Start the default stack and connect to:

```text
http://localhost:21503/mcp
```

### Register coding agents (one command)

`anything-obsidian connect` writes this endpoint into each coding agent's
own config — every writer is idempotent, touches exactly one key, and
preserves every other entry:

```bash
anything-obsidian connect                 # every detected agent
anything-obsidian connect codex cursor    # or an explicit list
anything-obsidian connect --list          # show what is detected
anything-obsidian connect --remove [agent...]   # unregister again
```

| Agent | Config | Entry |
|---|---|---|
| Claude Code | `~/.claude.json` | `mcpServers` → `{type: "http", url}` |
| Cursor | `~/.cursor/mcp.json` | `mcpServers` → `{url}` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` → `{serverUrl}` |
| Codex CLI | `~/.codex/config.toml` | `[mcp_servers.anything-obsidian]` |
| Gemini CLI | `~/.gemini/settings.json` | `mcpServers` → `{httpUrl}` |
| VS Code (Copilot) | `~/.vscode/mcp.json` | `servers` → `{type: "http", url}` |
| ZCode | — | no user-global MCP config; prints the project `.mcp.json` snippet instead |

The repository also ships a plugin for the agents that have a plugin
system (one directory, two manifests — `plugins/anything-obsidian/`).
Claude Code's manifest asks for the endpoint and an optional Bearer token
at install time — leave the defaults for the local profile below, or enter
a server's `:21500/mcp` plus a user token for the zero-install path
(below). The Codex manifest carries the fixed local registration:

```text
# Claude Code
/plugin marketplace add Lettucech/anything-obsidian
/plugin install anything-obsidian@anything-obsidian
```

```bash
# Codex CLI (v0.117.0+)
codex plugin marketplace add Lettucech/anything-obsidian
codex plugin add anything-obsidian@anything-obsidian
```

After connecting, the command probes the endpoint's `/health` and points at
`anything-obsidian start` when the app is not running. It wires the local
profile only; the zero-install direct remote MCP setup is below.

The local profile provides RAG plus raw-vault discovery and bounded source
reads. `any_obs_vault_directory` is local-only and returns the configured
host path of a selected vault, allowing an agent that already has local
filesystem authority to make edits outside this project's MCP scope.
`any_obs_vault_context` adds the selected vault's root policy files,
non-secret sync settings, source-of-truth status, and RAG freshness boundary so
the agent can assess the edit surface before opening that directory.

RAG is one query across every workspace this instance can see — one
workspace per managed vault, plus any server-granted shared workspaces — so
an agent never has to know which vault holds the answer before searching.
Search results carry each chunk's `vaultId` and vault-relative path (mapping
straight to `any_obs_file_read` in the owning vault), every vault's best
chunk is guaranteed a slot in the merged results, and the optional `vaultId`
argument filters to one vault.

Read and RAG tools:

- `any_obs_vault_list` (includes each vault's last-sync state)
- `any_obs_vault_context`
- `any_obs_vault_directory`
- `any_obs_file_list`
- `any_obs_file_read`
- `any_obs_rag_search`

Management tools (local profile only): `any_obs_vault_add`,
`any_obs_vault_update`, `any_obs_vault_remove`, `any_obs_vault_sync`,
`any_obs_vault_embed`, `any_obs_vault_doctor`, `any_obs_job_get`,
`any_obs_status`, `any_obs_autostart`.

**Search-first, no chat tool:** `any_obs_rag_answer` was retired with the
unified workspace (2026-11) — a chat call answers from exactly one
workspace, and the per-vault model has one per vault. Retrieve attributed
chunks with `any_obs_rag_search` and synthesize yourself, where the
conversation context lives. Two behaviors follow from that: when chunks from
different vaults disagree (same information, different versions), point both
versions out and ask which is current; and when every score looks weak, say
so instead of forcing an answer. AnythingLLM is a pure RAG index engine for
any-obs — no any-obs code path touches its LLM.

`any_obs_rag_search` is a raw vector search: with an explicit low
`scoreThreshold` it returns the nearest chunks regardless of quality, so a
weak retrieval is visible in the scores rather than hidden behind a refusal
or a confident paragraph. Chunks from workspaces outside the local registry
— for example shared team knowledge — carry only their `workspace` tag, no
`vaultId`, because they cannot be resolved to a locally readable file.

For a reusable retrieval and edit workflow, install the repository skill —
the coding-agent plugin bundles it, so this is only needed for agents
connected through `anything-obsidian connect` or hand-written configs:

```bash
npx skills add Lettucech/anything-obsidian --skill anything-obsidian-vault-workflow --agent codex
```

Its context-first flow is:

1. List vaults with `any_obs_vault_list`; file operations and edits always
   target one explicit `vaultId`.
2. Call `any_obs_vault_context` and read the returned policy files.
3. Use RAG search to discover candidates (results name the owning
   vault) and raw file reads to verify source truth.
4. For an approved edit, open the returned local directory and use normal
   filesystem and Git checks under the vault's own rules.

The skill never treats an MCP write tool as authorized: there are none, and a
stale runtime advertising write or patch tools for vault content is
deployment drift — report it and align the service with the current source.

## Remote agent (the server feature)

Every non-loopback caller — same LAN or across the internet — uses the
opt-in server. Turn it on and issue a user token in the server console:

```bash
anything-obsidian server on       # then open the dashboard → Server → console
```

### Connect an agent directly (no install)

The server's MCP endpoint is `http://<host>:21500/mcp` — Streamable HTTP,
`Authorization: Bearer <user-token>`.

Claude Code (or install the plugin and enter the server endpoint + token
when it asks):

```bash
claude mcp add --transport http --scope user any-obs http://<host>:21500/mcp \
  --header "Authorization: Bearer <user-token>"
```

Codex CLI — add to `~/.codex/config.toml`, token through an environment
variable so no secret lands in the file:

```toml
[mcp_servers.any-obs]
url = "http://<host>:21500/mcp"
bearer_token_env_var = "ANY_OBS_TOKEN"
```

(`export ANY_OBS_TOKEN=<user-token>` before starting Codex.)

Cursor, Windsurf, VS Code and Gemini CLI take the same shape in their own
MCP configs — a streamable-HTTP entry whose URL is the endpoint plus an
`Authorization: Bearer <user-token>` header. The server console
(dashboard → Server) shows ready-to-paste snippets.

The server exposes only:

- `any_obs_vault_list` (workspaces the token's grants permit — names and
  slugs, never file contents)
- `any_obs_rag_search` (one fan-out query across granted workspaces,
  optional `workspace` filter)
- `any_obs_shared_refresh` (queue refresh + reindex of shared sources)
- `any_obs_job_get` (status of shared-source pipeline jobs)

It does not mount the vault root and cannot return vault directories or raw
source files — that boundary is by construction, not convention. What a
token can read is decided by the grants its user holds (the server's
workspace registry), and tokens are stored only as SHA-256 hashes.

**Transport security:** 21500 speaks plain HTTP. Inside a trusted LAN that
is the designed trade-off; across the public internet, terminate TLS in
front of it (reverse proxy) — otherwise the bearer token and content are
readable in transit. Keep tokens private: RAG results may contain source
content.

### Retired: the LAN MCP endpoint

The dedicated LAN listener on port 21504 and its separate agent-token store
were retired (2026-11). `anything-obsidian lan …` is a no-op that points at
the server feature. Existing LAN agent tokens migrated automatically at the
first app start after the upgrade — each became a server user (same token,
now hash-carried in the server's user directory) granted read on the vault
workspace. The old `agent-tokens/` directory is left in place, untouched.

## Maintenance boundary

Local MCP management tools run the same configured sync/index jobs as the
dashboard. They never accept arbitrary Git commands or write note content.
Use the dashboard for policy changes and verified rebuilds; use `status` and
`logs` for service recovery. The vault Git repository remains the source of truth; AnythingLLM
remains a derived index.
