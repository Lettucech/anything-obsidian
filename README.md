# Anything Obsidian

Use Obsidian as a private Markdown vault, keep each vault in its own Git
repository, and expose the derived knowledge base to agents through Docker
Compose and MCP.

`anything-obsidian` is the tooling repository. It does not own your vault
repositories or treat AnythingLLM as their source of truth: Git remains the
source of truth and AnythingLLM is a local, rebuildable index.

## Multi-vault design and rollout status

The intended runtime is one local Docker Compose stack serving zero or more
Git-backed vaults. AnythingLLM, MCP, the dashboard, and the worker image are
shared; every managed vault has its own registry record, AnythingLLM workspace,
embedding manifest, schedule, and access-policy record.

Vault management belongs in the dashboard after the stack starts. The Compose
configuration mounts one fixed host root at `/vaults`; each managed vault is a
direct child of that root. The dashboard and workers address vaults by stable
id and resolve their directories below that root, rather than accepting
arbitrary host paths or Docker bind mounts. Removing a vault from management
only removes its registry record. It does not delete the local Git repository,
AnythingLLM workspace, or embedding data.

The multi-vault migration is in progress on this branch. The dashboard backend
can persist vault records and create or attach an AnythingLLM workspace, but
the Compose configuration, worker/scheduler, MCP selector, and dashboard UI
still use the legacy single-vault flow below. In particular, do not rely on
multi-vault scheduling, vault-scoped MCP requests, or dashboard-based vault
creation in the current runtime yet.

## Designed runtime model

When the migration is complete, the stack will have these properties:

- A newly installed stack starts successfully with an empty managed-vault
  registry. AnythingLLM and MCP can remain healthy before the first vault is
  added.
- `HOST_VAULTS_ROOT` selects one host directory that Compose mounts at
  `/vaults`. A vault is either created there or imported after it has been
  moved, copied, or linked beneath that root.
- Every registered vault has a unique id, workspace, manifest, schedule, and
  job lock. A failed or rebuilt vault does not affect another vault.
- The dashboard will expose scoped actions for each vault: sync now, embed
  changed, rebuild index, edit, and non-destructive removal.
- MCP will accept a vault id, resolve it to its workspace internally, and not
  silently search across multiple vaults. Restricted access policies are a
  future MCP enforcement boundary; hiding a vault in the dashboard is not an
  access-control mechanism.

The full design, safety constraints, and migration requirements are recorded
in [the multi-vault dashboard design](docs/superpowers/specs/2026-07-27-multi-vault-dashboard-design.md).

## Current supported Docker services

Docker Compose is the supported command surface from the tooling-repository
root. The current Compose file supports one vault supplied by
`HOST_VAULT_PATH`.

- `anything-obsidian-dashboard`: local dashboard for service controls, logs,
  and worker actions.
- `anything-obsidian-anythingllm`: AnythingLLM server.
- `anything-obsidian-mcp`: HTTP MCP server for coding agents.
- `anything-obsidian-syncer`: background worker for Git pull/push and
  incremental embedding.
- `anything-obsidian-worker`: one-shot maintenance worker for `embed`, `sync`,
  and `doctor`.

Docker-managed volumes hold runtime data:

- `anything-obsidian-anythingllm-storage`: AnythingLLM storage, API keys,
  uploaded documents, and vector data.
- `anything-obsidian-worker-state`: worker state such as the embedding
  manifest.

Your vault is mounted from `HOST_VAULT_PATH`; it is your Git-backed repository,
not Docker-owned runtime storage.

## Run the current single-vault runtime

1. Clone the tooling repository and your vault repository side by side.

```bash
cd /Users/you/Documents
git clone https://github.com/pingkiuho/anything-obsidian.git anything-obsidian
git clone https://github.com/YOUR_ACCOUNT/YOUR_VAULT_REPO.git vault
```

2. Create and edit `.env` in the tooling repository.

```bash
cd /Users/you/Documents/anything-obsidian
cp .env.example .env
```

Set `HOST_VAULT_PATH` to the vault repository path. Change
`HOST_DASHBOARD_PORT`, `HOST_ANYTHINGLLM_PORT`, or `HOST_MCP_PORT` only when a
host port is already in use.

The default sync interval is 300 seconds. Change
`KB_SYNC_INTERVAL_SECONDS` only when you need a faster or slower background
sync.

For a private GitHub vault repository, create a token that can read and write
that repository and set:

```text
KB_GIT_AUTH_TOKEN=your-github-token
```

The worker uses this token for `git pull` and `git push` without storing it in
the vault remote URL.

3. Start the stack from the tooling-repository root.

```bash
docker compose up -d
```

This starts the dashboard, AnythingLLM, MCP, and the background syncer. The
syncer reads `.env` on each interval, so it can pick up the AnythingLLM API key
after first-run setup.

4. Open the dashboard.

```text
http://localhost:11300
```

The dashboard stays running when you turn the rest of the system off. Use it to
start or stop AnythingLLM, MCP, and the background syncer; inspect recent logs;
run `doctor`; sync now; or rebuild the index.

5. Open AnythingLLM and finish first-run setup.

```text
http://localhost:11301
```

Create the `obsidian` workspace, configure the model and embedder, and create
an AnythingLLM API key.

6. Save the API key in `.env`, then recreate MCP.

```text
ANYTHINGLLM_API_KEY=your-api-key-here
```

```bash
docker compose up -d --force-recreate mcp
```

7. Watch the syncer, run a manual rebuild, and check worker health.

```bash
docker compose logs -f syncer
docker compose run --rm worker embed --all
docker compose run --rm worker doctor
```

The syncer pulls remote vault changes, commits and pushes local vault changes,
then incrementally embeds after a successful Git sync.

## Daily commands

Most daily actions are available from the dashboard. These commands remain
useful when Docker itself or the dashboard is unavailable.

```bash
docker compose ps
docker compose logs -f mcp
docker compose logs -f syncer
docker compose run --rm worker embed
docker compose run --rm worker embed --all
docker compose run --rm worker sync
docker compose run --rm worker doctor
docker compose down
docker volume ls --filter name=anything-obsidian
```

## MCP clients

Connect coding agents to:

```text
http://localhost:11333/mcp
```

If you change `HOST_MCP_PORT` in `.env`, use that port in the URL. The current
MCP server selects an AnythingLLM `workspaceSlug`; vault-id selection will
replace that interface as part of the multi-vault migration.

## Sync and safety notes

- Keep the tooling repository and vault repository separate.
- `.env` is local configuration for the tooling repository. Do not commit API
  keys or Git tokens.
- Docker runtime data lives in named volumes, not in the tooling repository.
- AnythingLLM API documentation is available from the live server at
  `http://localhost:11301/api/docs`.
- The dashboard mounts the local Docker socket to control only the fixed
  project containers. It binds to `127.0.0.1` by default and does not offer a
  generic Docker command surface.
- For the completed multi-vault model, plan a one-time import: place an
  existing vault below the configured shared root (or choose its parent as the
  root), review the import preview, and then register it. The migration must
  not silently move or register a repository.
