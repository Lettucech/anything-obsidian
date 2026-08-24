# Code Agent MCP Setup

Anything Obsidian exposes AnythingLLM through the MCP server in Docker.

Start the stack from the tooling repo root:

```bash
docker compose up -d
```

This starts AnythingLLM, MCP, the dashboard, and the multi-vault scheduler. It
is healthy even before the dashboard has managed its first vault.

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

Use the worker service for manual, vault-scoped index maintenance:

```bash
docker compose logs -f syncer
docker compose run --rm worker sync --vault work
docker compose run --rm worker embed --vault work --all
docker compose run --rm worker doctor --vault work
```

The scheduler handles normal updates. `sync` runs one vault sync immediately,
`embed --all` rebuilds that vault index, and `doctor` checks its Docker-visible
config and service reachability.

Syncer logs use the `anything-obsidian-worker` prefix and show vault-specific
Git sync results, embedding progress, failures, and the next scheduled run.

For a private HTTPS remote, configure its username and token in that vault's
clone form. The dashboard uses it to clone that vault, then the worker reads
only that vault's local runtime secret and
uses Git askpass without putting the token in the remote URL. Different vaults
may use different GitHub, GitLab, or other HTTPS credentials.

The registry is also the source of each vault's Git pull/push behavior, commit
identity and message prefix, sync interval, post-sync embedding choice, and
embedding include/exclude filters. Do not supply a `KB_*` environment setting:
workers always resolve those policies from the selected vault id.

## Tools

- `obsidian_vault_list`: list managed Obsidian vaults.
- `anythingllm_search_chunks`: search one vault's derived index and return source chunks.
- `anythingllm_answer`: ask AnythingLLM to answer from one vault.

The tools accept an optional `vaultId`; omit it only when there is exactly one
accessible vault, otherwise callers must specify it. Use `anythingllm_search_chunks` when the
agent should inspect source chunks and reason itself. Use `anythingllm_answer`
only when you want AnythingLLM to produce the answer itself.
