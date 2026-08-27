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

Available tools:

- `obsidian_vault_list`
- `obsidian_vault_directory`
- `obsidian_file_list`
- `obsidian_file_read`
- `anythingllm_search_chunks`
- `anythingllm_answer`

## LAN agent

Set `HOST_MCP_LAN_PORT`, `MCP_LAN_TOKEN`, and `MCP_LAN_ALLOWED_HOSTS` in the
host's `.env`, then start the optional profile:

```bash
docker compose --profile lan up -d mcp-lan
```

Connect to `http://<host>:<HOST_MCP_LAN_PORT>/mcp` and configure the MCP client
to send `Authorization: Bearer <MCP_LAN_TOKEN>`. The URL hostname or IP must
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
