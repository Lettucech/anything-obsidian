# Anything Obsidian

Anything Obsidian is a local Docker runtime for Git-backed Obsidian vaults.
One Compose stack runs the dashboard, AnythingLLM, MCP, and workers; the
dashboard creates or imports any number of managed vaults after the stack has
started.

Your Git repositories remain the source of truth. AnythingLLM is a derived,
rebuildable index. The tooling repository never owns or deletes a vault
repository.

## Getting started

1. Clone the tooling repository, create the local configuration, and choose a
shared parent directory for managed vaults. It may be empty.

```bash
git clone https://github.com/pingkiuho/anything-obsidian.git
cd anything-obsidian
cp .env.example .env
```

Set `HOST_VAULTS_ROOT` in `.env` to a directory Docker Desktop can access, for
example:

```text
HOST_VAULTS_ROOT=/Users/you/.anything-obsidian/vaults
```

This is a parent directory, not a vault path. Each dashboard-managed vault is a
direct child of it. Change the three `HOST_*_PORT` values only if a port is in
use. You do **not** need a Git token at this stage.

2. Start the shared services.

```bash
docker compose up -d
```

The dashboard, AnythingLLM, MCP, and scheduler start successfully with zero
vaults. Open the dashboard at `http://localhost:11300`.

3. Finish the one-time AnythingLLM setup at `http://localhost:11301`.

Configure the model and embedder, then create an AnythingLLM API key. Save it
locally in `.env`:

```text
ANYTHINGLLM_API_KEY=your-api-key-here
```

Recreate the dashboard and MCP so they receive the key:

```bash
docker compose up -d --force-recreate dashboard mcp
```

4. In the dashboard, select **Add vault**.

Choose one of the following:

- **Create a new Git repository** creates `<HOST_VAULTS_ROOT>/<directory>` and
  initialises it as a Git repository.
- **Import an existing Git repository** registers a direct child of
  `HOST_VAULTS_ROOT`. Move, copy, or link the repository below that root first.

Then choose whether to create an AnythingLLM workspace or attach one that
already exists, and set that vault's Git remote, branch, pull/push policy,
commit identity, embedding filters, schedule, access policy, and (when needed)
HTTPS username and token. The dashboard stores vault mapping and operational
policy in the registry; credentials live separately in the local runtime secret
volume and are never returned by the API.

5. Configure Git credentials only for vaults that need them.

Choose **HTTPS username and token** in that vault's dashboard form and enter
the credential appropriate for its own remote (for example, a GitHub PAT with
`x-access-token`, or a GitLab token with its matching username). Each vault has
an isolated credential record; no `.env` token is shared across vaults. Public
or local-only repositories need no credential.

## How vault management works

The dashboard stores a registry in a Docker volume. Each record has a stable
vault id, a direct-child directory under `/vaults`, an AnythingLLM workspace,
all Git/sync/embedding policy, a schedule, and an `open` or `restricted` policy.

- Each vault has its own embedding manifest and optional HTTPS credential at a
  namespaced runtime path.
- Sync, embedding, rebuild, and doctor actions are scoped to one vault. Jobs
  for different vaults can run independently; a duplicate job for the same
  vault is rejected.
- Removing a vault from management only removes its registry entry. Its local
  repository, AnythingLLM workspace, and embedding data remain until separately
  deleted by the user.
- `restricted` policy is persisted but cannot enforce caller identities yet.
  MCP explicitly reports that boundary instead of treating dashboard visibility
  as security.

## MCP clients

Connect coding agents to:

```text
http://localhost:11333/mcp
```

Use `anythingllm_vaults` to list managed vaults. Query and vector-search tools
take an optional `vaultId`; it is inferred only when exactly one open vault is
available. With several accessible vaults, callers must specify a vault id, so
MCP never silently searches across vaults.

## Operations

The dashboard is the normal interface for vault creation, import, vault-scoped
sync, embedding, rebuild, edit, removal, and service health. The CLI remains
available for recovery or automation:

```bash
docker compose ps
docker compose logs -f syncer
docker compose run --rm worker sync --vault work
docker compose run --rm worker embed --vault work
docker compose run --rm worker embed --vault work --all
docker compose run --rm worker doctor --vault work
docker compose down
```

The scheduler runs all enabled vaults according to their individual intervals.
A failed vault is recorded and retried later without stopping other vaults.

## Safety notes

- Keep `.env` local and do not commit API keys or Git tokens.
- Docker runtime data is stored in named volumes, not in the tooling repository.
- The dashboard binds to `127.0.0.1` by default. Its Docker socket access is
  limited to fixed project containers and worker commands; it does not expose a
  generic Docker command surface.
- The dashboard accepts only stable vault ids and validates every vault
  directory beneath the fixed `/vaults` root. It does not accept arbitrary host
  paths or Docker bind mounts.
- AnythingLLM API documentation is available locally at
  `http://localhost:11301/api/docs`.
