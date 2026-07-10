# Anything Obsidian

Use Obsidian as a private Markdown vault, keep that vault in your own Git repo, and expose the derived knowledge base to agents through Docker Compose and MCP.

`anything-obsidian` is the tooling repo. Your Obsidian vault lives in a separate repo.

## Supported Docker Services

Docker Compose is the supported command surface from the tooling repo root.

- `anything-obsidian-anythingllm`: AnythingLLM server.
- `anything-obsidian-mcp`: HTTP MCP server for coding agents.
- `anything-obsidian-worker`: one-shot and maintenance worker for `embed`, `sync`, and `doctor`.

Docker-managed volumes hold runtime data:

- `anything-obsidian-anythingllm-storage`: AnythingLLM storage, API keys, uploaded documents, and vector data.
- `anything-obsidian-worker-state`: worker state such as the embedding manifest.

The Obsidian vault is still mounted from `HOST_VAULT_PATH` because it is your Git-backed vault repo, not Docker-owned storage.

## Quick Start

1. Clone the tooling repo and your vault repo side by side.

```bash
cd /Users/lettucech/Documents
git clone https://github.com/pingkiuho/anything-obsidian.git anything-obsidian
git clone https://github.com/YOUR_ACCOUNT/YOUR_VAULT_REPO.git vault
```

2. Create and edit `.env` in the tooling repo.

```bash
cd /Users/lettucech/Documents/anything-obsidian
cp .env.example .env
```

Set `HOST_VAULT_PATH` to your vault repo path. Change `HOST_ANYTHINGLLM_PORT` or `HOST_MCP_PORT` only if those host ports are already in use.

3. Start the stack from the tooling repo root.

```bash
docker compose up -d
```

4. Open AnythingLLM and finish first-run setup.

```text
http://localhost:11301
```

Create the `obsidian` workspace, configure your model and embedder, and create an AnythingLLM API key.

5. Save the API key in `.env`, then recreate MCP.

```text
ANYTHINGLLM_API_KEY=your-api-key-here
```

```bash
docker compose up -d --force-recreate mcp
```

6. Embed the vault into AnythingLLM.

```bash
docker compose run --rm worker embed --all
```

7. Run the worker health checks.

```bash
docker compose run --rm worker doctor
```

## Daily Commands

```bash
docker compose ps
docker compose logs -f mcp
docker compose run --rm worker embed
docker compose run --rm worker embed --all
docker compose run --rm worker sync
docker compose run --rm worker doctor
docker compose down
docker volume ls --filter name=anything-obsidian
```

## MCP Clients

Connect coding agents to:

```text
http://localhost:11333/mcp
```

If you change `HOST_MCP_PORT` in `.env`, use that port in the URL.

## Vault Sync

Git is the source of truth. AnythingLLM is a derived local index.

Use the worker when you want to sync or repair the index:

```bash
docker compose run --rm worker sync
docker compose run --rm worker embed --all
```

## Notes

- Keep the tooling repo and vault repo separate.
- `.env` is the local configuration file for the tooling repo.
- Docker runtime data lives in named Docker volumes, not inside the tooling repo.
- AnythingLLM API docs are available from the live server at `http://localhost:11301/api/docs`.
