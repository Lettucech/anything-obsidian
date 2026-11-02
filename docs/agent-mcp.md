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

The local profile provides RAG plus raw-vault discovery and bounded source
reads. `any_obs_vault_directory` is local-only and returns the configured
host path of a selected vault, allowing an agent that already has local
filesystem authority to make edits outside this project's MCP scope.
`any_obs_vault_context` adds the selected vault's root policy files,
non-secret sync settings, source-of-truth status, and RAG freshness boundary so
the agent can assess the edit surface before opening that directory.

RAG is unified across the instance: both `any_obs_rag_*` tools query one
shared index covering every managed vault, so an agent never has to know
which vault holds the answer before searching. Search results carry each
chunk's `vaultId` and vault-relative path (mapping straight to
`any_obs_file_read` in the owning vault), and the optional `vaultId` argument
filters results to one vault.

Read and RAG tools:

- `any_obs_vault_list` (includes each vault's last-sync state)
- `any_obs_vault_context`
- `any_obs_vault_directory`
- `any_obs_file_list`
- `any_obs_file_read`
- `any_obs_rag_search`
- `any_obs_rag_answer`

Management tools (local profile only): `any_obs_vault_add`,
`any_obs_vault_update`, `any_obs_vault_remove`, `any_obs_vault_sync`,
`any_obs_vault_embed`, `any_obs_vault_doctor`, `any_obs_job_get`,
`any_obs_status`, `any_obs_autostart`.

Search and answer apply relevance differently. `any_obs_rag_search` is a raw
vector search: with an explicit low `scoreThreshold` it returns the nearest
chunks regardless of quality. `any_obs_rag_answer` is strict RAG in AnythingLLM
query mode and refuses when nothing scores above the workspace's relevance
cutoff — generic queries can legitimately answer nothing while search still
returns chunks. Reach for search first; reserve answer for questions that
should be synthesised.

Two more things worth knowing: answer targets this instance's own unified
workspace (gateway-granted shared workspaces are search surfaces), and
chunks from workspaces outside the local registry — for example shared
team knowledge — carry only their `workspace` tag, no `vaultId`, because
they cannot be resolved to a locally readable file.

For a reusable retrieval and edit workflow, install the repository skill:

```bash
npx skills add Lettucech/anything-obsidian --skill anything-obsidian-vault-workflow --agent codex
```

Its context-first flow is:

1. List vaults with `any_obs_vault_list`; file operations and edits always
   target one explicit `vaultId`.
2. Call `any_obs_vault_context` and read the returned policy files.
3. Use unified RAG search to discover candidates (results name the owning
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

- `any_obs_vault_list`
- `any_obs_rag_search`

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
