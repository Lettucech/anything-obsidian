# Code Agent MCP Setup

Anything Obsidian exposes AnythingLLM through the MCP server in Docker.

Start the stack from the tooling repo root:

```bash
docker compose up -d
```

This starts AnythingLLM, MCP, and the default background syncer. The syncer reads `.env` on each interval, pulls and pushes the vault Git repo, and incrementally embeds after successful sync.

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

Use the worker service for manual index maintenance:

```bash
docker compose logs -f syncer
docker compose run --rm worker sync
docker compose run --rm worker embed --all
docker compose run --rm worker doctor
```

The default syncer handles normal updates. `sync` runs one sync immediately, `embed --all` rebuilds the vault index, and `doctor` checks Docker-visible config and service reachability.

Syncer logs use the `anything-obsidian-worker` prefix and show autosync rounds, Git sync result, embedding progress, failures, and the next wait interval.

For private GitHub vault repos, set `KB_GIT_AUTH_TOKEN` in `.env`. The worker uses it for both `git pull` and `git push` through Git askpass, without putting the token in the remote URL.

## Tools

- `anythingllm_workspaces`: list available workspaces.
- `anythingllm_vector_search`: search the workspace vector index directly.
- `anythingllm_query`: ask the configured workspace through AnythingLLM.

Use `anythingllm_vector_search` when the agent should inspect source chunks and reason itself. Use `anythingllm_query` only when you want AnythingLLM to produce the answer itself.
