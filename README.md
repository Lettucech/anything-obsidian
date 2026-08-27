# Anything Obsidian

Anything Obsidian is a local control plane for the connection between managed
Obsidian vaults and their derived AnythingLLM RAG indexes. It keeps the vault
repository as the source of truth; AnythingLLM is rebuildable derived data.

The project manages vault registration, optional Git-based sync, and
vault-scoped indexing. Its MCP interfaces are read-only: agents never write
vault source files, commit Git changes, or trigger indexing through MCP.

## Boundaries

- **Vault management:** the dashboard clones or imports a vault beneath the
  user-selected `HOST_VAULTS_ROOT`, creates its AnythingLLM workspace, and
  stores only validated registry metadata.
- **Optional Git sync:** the scheduler may pull, commit, and push according to
  a vault's dashboard configuration. This is an explicitly configured
  background operation, not an MCP capability.
- **Derived RAG:** the worker updates a vault's AnythingLLM index after the
  configured sync workflow. It never becomes the source for vault files.
- **No vault ownership:** removing a vault from management does not delete its
  repository, workspace, or embedding data.

## Getting started

1. Clone this repository, copy `.env.example` to `.env`, and set
   `HOST_VAULTS_ROOT` to an existing parent directory that Docker Desktop can
   access. Each managed vault becomes a direct child of that directory.

2. Start the default local services:

   ```bash
   docker compose up -d
   ```

3. Complete the one-time AnythingLLM model/embedder setup at
   `http://localhost:11301`, create a Developer API key, put it in `.env` as
   `ANYTHINGLLM_API_KEY`, then recreate the dashboard and local MCP:

   ```bash
   docker compose up -d --force-recreate dashboard mcp
   ```

4. Open the dashboard at `http://localhost:11300` and add or import a vault.
   Git credentials and a commit identity are required only when that vault's
   optional automatic Git sync needs them.

## MCP access

### Local MCP

The default endpoint is bound to loopback only:

```text
http://localhost:11333/mcp
```

It exposes RAG plus read-only local vault discovery:

- `obsidian_vault_list` returns only vault id and name.
- `obsidian_vault_directory` returns the configured host directory for one
  vault, so a local agent with filesystem authority can edit it directly.
- `obsidian_file_list` and `obsidian_file_read` inspect raw Markdown and
  Canvas source files with vault-relative paths and bounded reads.
- `anythingllm_search_chunks` and `anythingllm_answer` query the derived RAG
  index.

There are no MCP tools for writing, patching, uploading, Git sync, or RAG
reindexing.

### Optional LAN RAG MCP

LAN access is opt-in and exposes only `obsidian_vault_list`,
`anythingllm_search_chunks`, and `anythingllm_answer`. Its service has no
vault filesystem mount, so raw-vault tools cannot be enabled through a client
request.

Before starting it, set all three local `.env` values:

```text
HOST_MCP_LAN_PORT=11334
MCP_LAN_TOKEN=use-a-long-random-secret
MCP_LAN_ALLOWED_HOSTS=obsidian-host.local,192.168.1.10
```

`MCP_LAN_ALLOWED_HOSTS` must include the hostname or IP address the remote
client uses in its MCP URL. Start the profile with:

```bash
docker compose --profile lan up -d mcp-lan
```

Remote clients connect to `http://<host>:11334/mcp` and must send:

```text
Authorization: Bearer <MCP_LAN_TOKEN>
```

Keep the dashboard and AnythingLLM management UI on loopback. A LAN bearer
token grants access to RAG results, which may contain source content.

## Operations

The dashboard is the normal interface for vault registration, per-vault sync
policy, embedding policy, and service health. For recovery or explicitly
requested maintenance, use the worker commands:

```bash
docker compose logs -f syncer
docker compose run --rm worker sync --vault work
docker compose run --rm worker embed --vault work
docker compose run --rm worker embed --vault work --all
docker compose run --rm worker doctor --vault work
```

These operations are outside the MCP surface. They can modify Git or derived
RAG state according to the selected vault configuration.

## Safety notes

- Keep `.env`, API keys, and LAN tokens local and out of Git.
- The dashboard validates every vault as a direct child of the fixed `/vaults`
  mount; MCP never accepts arbitrary host paths.
- Local raw-vault tools reject traversal, symlinks, Git metadata, unsupported
  file types, and unbounded reads.
- LAN MCP is read-only and token-protected, but it is still an information
  access boundary; expose it only on a trusted network.
