# Agent MCP setup

Anything Obsidian (short name: any-obs) provides one MCP profile per
connection kind: **local** (loopback, the owner's machine) and **remote**
(the server feature, token-gated). Neither profile offers tools that write
vault source files; the local profile additionally exposes `any_obs_*`
management tools (vault lifecycle, sync/embed jobs, service control) that
proxy the dashboard API.

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

Claude Code users can alternatively install the repository's plugin, which
carries the same registration:

```text
/plugin marketplace add Lettucech/anything-obsidian
/plugin install anything-obsidian@anything-obsidian
```

After connecting, the command probes the endpoint's `/health` and points at
`anything-obsidian start` when the app is not running. It wires the local
profile only; remote agents (below) add `Authorization: Bearer <user-token>`
headers by hand for now.

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

For a reusable retrieval and edit workflow, install the repository skill:

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

Remote clients connect to `http://<host>:21500/mcp` with
`Authorization: Bearer <user-token>`. The server exposes only:

- `any_obs_rag_search` (workspaces the token's grants permit)
- `any_obs_shared_refresh` (queue refresh + reindex of shared sources)
- `any_obs_job_get` (status of shared-source pipeline jobs)

It does not mount the vault root and cannot return vault directories or raw
source files — that boundary is by construction, not convention. What a
token can read is decided by the grants its user holds (the server's
workspace registry), and tokens are stored only as SHA-256 hashes. Keep them
private: RAG results may contain source content.

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
