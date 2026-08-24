# Anything Obsidian

Anything Obsidian is a local Docker runtime for Git-backed Obsidian vaults.
One Compose stack runs the dashboard, AnythingLLM, MCP, and workers; the
dashboard creates or imports any number of managed vaults after the stack has
started.

Your Git repositories remain the source of truth. AnythingLLM is a derived,
rebuildable index. The tooling repository never owns or deletes a vault
repository.

## Getting started

1. Clone the tooling repository and create the local configuration. Choose a
shared parent directory for the vault repositories you want this stack to
manage; it may be empty.

```bash
git clone https://github.com/pingkiuho/anything-obsidian.git
cd anything-obsidian
cp .env.example .env
```

Set `HOST_VAULTS_ROOT` in `.env` to that directory. It must exist and Docker
Desktop must be allowed to access it, for example:

```text
HOST_VAULTS_ROOT=/Users/your-user/.anything-obsidian/vaults
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

Configure the model and embedder, then create a developer API key in
**Settings → Developer API**. Copy it into your local `.env` (never commit this
file):

```text
ANYTHINGLLM_API_KEY=your-api-key-here
```

Recreate the dashboard and MCP so they receive the key. Repeat this whenever
you replace or revoke the key:

```bash
docker compose up -d --force-recreate dashboard mcp
```

Until the dashboard can verify this key, it shows only this setup guidance and
a link back to AnythingLLM; vault management does not open.

4. In the dashboard, select **Add vault**.

The dialog asks for the repository's HTTP(S) clone URL, whether it is public or
private, and the Git commit author name and email used for automatic sync
commits. Use **Test connection** to check both Git access and the configured
AnythingLLM API key before any repository or dashboard state is created. On
add, the dashboard checks the AnythingLLM connection before cloning beneath
`HOST_VAULTS_ROOT`, derives the vault name/id/directory, discovers `origin` and
the checked-out default branch, and creates a matching AnythingLLM workspace.
Git author details are required: the dashboard never invents an identity for
commits made on your behalf.

For a private HTTPS repository, select **Private repository** and enter the
provider-appropriate username and token (for example, a GitHub PAT with
`x-access-token`, or a GitLab token with its matching username). Each vault has
an isolated credential record; no `.env` token is shared across vaults.

New vaults use the normal workspace, sync, embedding, and access defaults.
After adding a vault, use its **Edit** action to override its derived identity
or change workspace, sync, embedding, or access policy.

## How vault management works

The dashboard stores a registry in a Docker volume. Each record has a stable
vault id, a direct-child directory under `/vaults`, an AnythingLLM workspace,
the cloned repository URL, all Git/sync/embedding policy, a schedule, and an
`open` or `restricted` policy.

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

Use `obsidian_vault_list` to list managed vaults. AnythingLLM answer and search
tools take an optional `vaultId`; it is inferred only when exactly one open vault is
available. With several accessible vaults, callers must specify a vault id, so
MCP never silently searches across vaults.

### Source-of-truth Obsidian tools

The same MCP endpoint also reads and writes the managed vault source files,
independently of the derived AnythingLLM index:

- `obsidian_file_list` lists vault-relative `.md` and `.canvas` files.
- `obsidian_file_read` reads a bounded line range and returns its SHA-256
  revision.
- `obsidian_file_write` creates a small file or replaces one only when its
  `expectedSha256` matches. For existing large notes, use
  `obsidian_file_patch` with one unique `oldText` fragment instead of sending
  the full file through MCP.
- `obsidian_file_upload_begin`, `obsidian_file_upload_append`, and
  `obsidian_file_upload_complete` provide resumable, 128 KiB base64 chunks for a new
  large source file. The upload is invisible until it finishes atomically.
- `anythingllm_reindex` queues an incremental index update after an out-of-band
  change. Successful writes and finished uploads queue the same update
  automatically.

The filesystem tools accept a vault id and a vault-relative path only; they do
not accept host paths, `..`, symlinks, or `.git` access. They currently support
UTF-8 Markdown and Canvas files, not binary attachments. A source write can
succeed while its asynchronous reindex cannot be queued (for example while
AnythingLLM is down); the tool reports that state explicitly, and
`anythingllm_reindex` can be retried later. These tools do not commit or push Git
changes.

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
