# Agent MCP setup

Anything Obsidian provides two read-only MCP profiles. Use the endpoint that
matches where the agent runs; neither profile writes vault source files.

## Local agent

Start the default stack and connect to:

```text
http://localhost:11333/mcp
```

The local profile provides RAG plus raw-vault discovery and bounded source
reads. `obsidian_vault_directory` is local-only and returns the configured
host path of a selected vault, allowing an agent that already has local
filesystem authority to make edits outside this project's MCP scope.
`obsidian_vault_context` adds the selected vault's root policy files,
non-secret sync settings, source-of-truth status, and RAG freshness boundary so
the agent can assess the edit surface before opening that directory.

Available tools:

- `obsidian_vault_list`
- `obsidian_vault_context`
- `obsidian_vault_directory`
- `obsidian_file_list`
- `obsidian_file_read`
- `anythingllm_search_chunks`
- `anythingllm_answer`

For a reusable retrieval and edit workflow, install the repository skill:

```bash
npx skills add Lettucech/anything-obsidian --skill anything-obsidian-vault-workflow --agent codex
```

Its context-first flow is:

1. Select one explicit vault with `obsidian_vault_list`.
2. Call `obsidian_vault_context` and read the returned policy files.
3. Use RAG to discover candidates and raw file reads to verify source truth.
4. For an approved edit, open the returned local directory and use normal
   filesystem and Git checks under the vault's own rules.

The skill never treats an MCP write tool as authorized. If a stale MCP runtime
advertises write, patch, upload, sync, or reindex tools, do not call them;
report deployment drift and align the running service with the current source.

## Agent tokens

By default every MCP caller sees all open vaults. To scope a client to specific
vaults, create a named agent token in the dashboard's **Agent access** section,
then add that agent name to the allowlist of each vault it should reach
(vault → Edit → Access policy). The MCP client sends:

```text
Authorization: Bearer <agent-token>
```

With a valid agent token, `obsidian_vault_list` returns only open vaults plus
the restricted vaults whose allowlist names that agent, and every tool enforces
the same boundary. A tokenless local connection keeps its current access to
open vaults only. The LAN profile's `MCP_LAN_TOKEN` stays an administrator
token with full access including restricted vaults; agent tokens are also
accepted on the LAN profile. Tokens are shown once at creation and stored only
as SHA-256 hashes; revoking a token cuts that agent's MCP access immediately.

## LAN agent

Set `HOST_MCP_LAN_PORT`, `MCP_LAN_TOKEN`, and `MCP_LAN_ALLOWED_HOSTS` in the
host's `.env`, then start the optional profile:

```bash
docker compose --profile lan up -d mcp-lan
```

Connect to `http://<host>:<HOST_MCP_LAN_PORT>/mcp` and configure the MCP client
to send `Authorization: Bearer <MCP_LAN_TOKEN>` for administrator access, or a
scoped agent token as described under Agent tokens. The URL hostname or IP must
also appear in `MCP_LAN_ALLOWED_HOSTS`.

The LAN profile deliberately exposes only:

- `obsidian_vault_list`
- `anythingllm_search_chunks`
- `anythingllm_answer`

It does not mount the vault root and cannot return vault directories or raw
source files. Keep the bearer token private: RAG results may contain source
content.

## Maintenance boundary

MCP does not run Git sync or RAG indexing. Configure optional Git sync in the
dashboard, and use the dashboard or worker commands for explicit reindexing
and recovery. The vault Git repository remains the source of truth; AnythingLLM
remains a derived index.
