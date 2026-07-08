# Code Agent MCP Setup

Anything Obsidian exposes AnythingLLM through the MCP server in `mcp/anythingllm`.

The user-facing server setup path is Docker Compose. The helper scripts are optional maintainer conveniences.

## Docker HTTP Server

Start core AnythingLLM:

```bash
cd docker/anythingllm
docker compose --env-file ../../.env up -d
```

After creating an AnythingLLM API key and adding it to `.env`, start the optional MCP service:

```bash
cd docker/mcp
docker compose --env-file ../../.env up -d --build mcp
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

If `ANYTHINGLLM_API_KEY` changes, recreate MCP:

```bash
cd docker/mcp
docker compose --env-file ../../.env up -d --build --force-recreate mcp
```

## Docker Embed Job

The normal path is the auto sync watcher. It waits for a quiet edit window, commits/pushes vault changes, then re-embeds:

```bash
cd docker/mcp
docker compose --env-file ../../.env up -d --build sync
```

Watch logs:

```bash
docker compose --env-file ../../.env logs -f sync
```

Git is the source of truth. AnythingLLM is a local derived index. If `KB_GIT_AUTO_PUSH=true` and push fails, the watcher keeps the local commit but skips re-embedding until the push succeeds.

Manual embed is available for repair or first-run checks:

```bash
cd docker/mcp
docker compose --env-file ../../.env run --rm embed
```

Re-embed all tracked file types:

```bash
cd docker/mcp
docker compose --env-file ../../.env run --rm embed node scripts/embed-vault.mjs --all
```

## Local Stdio Server

Some clients prefer local stdio MCP servers:

```bash
cd mcp/anythingllm
npm install
npm run build
node dist/index.js
```

The stdio server reads `.env` from the tooling repo root.

## Tools

- `anythingllm_workspaces`: list available workspaces.
- `anythingllm_vector_search`: directly search the workspace vector index. Prefer this for code agents.
- `anythingllm_query`: ask the configured workspace through AnythingLLM.

Use `anythingllm_vector_search` when the agent should inspect source chunks and reason itself. Use `anythingllm_query` with `mode=query` or `mode=chat` only when you want AnythingLLM to produce the answer.

AnythingLLM documents its live API for your instance at:

```text
http://localhost:11301/api/docs
```

If you changed `HOST_ANYTHINGLLM_PORT` in `.env`, use that port instead.
