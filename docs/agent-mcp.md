# Code Agent MCP Setup

Anything Obsidian exposes AnythingLLM through the MCP server in Docker.

Start the stack from the tooling repo root:

```bash
docker compose up -d
```

After you create an AnythingLLM API key and save it in `.env`, recreate MCP:

```bash
docker compose up -d --force-recreate mcp
```

Connect MCP clients to:

```text
http://localhost:11333/mcp
```

If you changed `HOST_MCP_PORT` in `.env`, use that port instead.

The health endpoint is:

```text
http://localhost:11333/health
```

If `ANYTHINGLLM_API_KEY` changes, recreate MCP again with the same command.

## Worker Commands

Use the worker service for index maintenance:

```bash
docker compose run --rm worker embed --all
docker compose run --rm worker doctor
```

`embed --all` rebuilds the vault index, and `doctor` checks Docker-visible config and service reachability.

## Tools

- `anythingllm_workspaces`: list available workspaces.
- `anythingllm_vector_search`: search the workspace vector index directly.
- `anythingllm_query`: ask the configured workspace through AnythingLLM.

Use `anythingllm_vector_search` when the agent should inspect source chunks and reason itself. Use `anythingllm_query` only when you want AnythingLLM to produce the answer itself.
