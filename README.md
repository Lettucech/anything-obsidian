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
- **Agent-scoped MCP access:** dashboard-issued agent tokens limit a client's
  MCP visibility to the vaults whose allowlist names it. Tokenless local
  connections keep their existing access to open vaults.
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

## Native install (one command, no Docker)

The same control plane also runs as a plain Node app. The installer bootstraps
everything — if the machine has no Node.js >= 18 it downloads a portable
runtime automatically (no Homebrew, no sudo). It talks to an existing
AnythingLLM instance (mini shared instance, AnythingLLM Desktop, or a remote
server) and never hosts AnythingLLM itself.

1. Install and set up in one command:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/Lettucech/anything-obsidian/main/install.sh | sh
   ```

   The installer checks prerequisites, installs the app under
   `~/.anything-obsidian/`, puts `anything-obsidian` on your PATH, then asks
   a few setup questions: a vault root (default `~/ObsidianVaults` — a
   self-created folder avoids macOS permission prompts around Documents and
   Desktop), the AnythingLLM base URL and Developer API key, and it tests the
   connection before saving a 0600 config under
   `~/Library/Application Support/anything-obsidian/`. When it finishes, the
   dashboard is running and your browser opens at `http://localhost:11400`.

   Prefer no prompts? Pass everything up front (also how agents install it):

   ```bash
   curl -fsSL https://raw.githubusercontent.com/Lettucech/anything-obsidian/main/install.sh | sh -s -- \
     --vaults-root ~/ObsidianVaults --url http://localhost:11301 --api-key <key> --no-browser
   ```

   Or let your AI agent do it: agents can load the
   `anything-obsidian-setup` skill from this repo
   (`npx skills add Lettucech/anything-obsidian --skill anything-obsidian-setup`)
   and handle the whole flow — install, setup, and health checks.

2. Manage everything in the browser at `http://localhost:11400`. The
   dashboard can be stopped and restarted:

   ```bash
   anything-obsidian status       # health + setup check (--json for agents)
   anything-obsidian start        # foreground, opens the browser
   anything-obsidian start --bg --no-browser   # background, agent friendly
   anything-obsidian stop         # stops the dashboard and the scheduler
   ```

3. Vault sync and the dashboard stay running on their own. The installer
   registers per-user services (macOS LaunchAgents, or systemd user units on
   Linux — no admin needed): both start at every login and restart
   automatically if they crash. Control them any time:

   ```bash
   anything-obsidian status       # health + setup check (--json for agents)
   anything-obsidian autostart status
   anything-obsidian stop         # stop now (returns at next login/reboot)
   anything-obsidian autostart off      # stop permanently
   anything-obsidian autostart on       # turn auto-restart back on
   ```

   On a headless Linux server, run `sudo loginctl enable-linger $USER` once
   and the services keep running even without an active login session. If you
   declined autostart during install, `anything-obsidian start-bg` runs the
   sync scheduler without it.

Configuration, registry, secrets, agent tokens, state, and logs all live under
one directory (`~/Library/Application Support/anything-obsidian/` on macOS;
override with `ANYTHING_OBSIDIAN_HOME`). The Docker stack described above can
be used at the same time: the native dashboard listens on 11400 and never
touches Docker's 11300 deployment.

Uninstall in one command — it stops everything (including the LaunchAgents),
removes the app and CLI, and keeps your data and vault folders by default:

```bash
curl -fsSL https://raw.githubusercontent.com/Lettucech/anything-obsidian/main/uninstall.sh | sh
```

See `docs/superpowers/specs/2026-10-07-native-app.md` for the design notes.

## MCP access

### Local MCP

The default endpoint is bound to loopback only:

```text
http://localhost:11333/mcp
```

It exposes RAG plus read-only local vault discovery:

- `obsidian_vault_list` returns only vault id and name.
- `obsidian_vault_context` is local-only and returns the selected vault's host
  directory, root policy files, non-secret sync settings, and edit boundaries.
- `obsidian_vault_directory` returns the configured host directory for one
  vault, so a local agent with filesystem authority can edit it directly.
- `obsidian_file_list` and `obsidian_file_read` inspect raw Markdown and
  Canvas source files with vault-relative paths and bounded reads.
- `anythingllm_search_chunks` and `anythingllm_answer` query the derived RAG
  index.

There are no MCP tools for writing, patching, uploading, Git sync, or RAG
reindexing.

### Agent tokens

To scope an MCP client to specific vaults, create a named agent token in the
dashboard's **Agent access** section, then add that agent name to the
allowlist of each vault it should reach under vault **Edit → Access policy**.
Clients send `Authorization: Bearer <agent-token>`; such a caller sees only
open vaults plus the restricted vaults that allowlist it. Tokenless local
connections keep their current access to open vaults. Tokens are shown once
and stored only as SHA-256 hashes. See `docs/agent-mcp.md` for details.

### Agent workflow skill

Install the repository's workflow skill when an agent should search, verify,
assess, or locally edit managed vault knowledge:

```bash
npx skills add Lettucech/anything-obsidian --skill anything-obsidian-vault-workflow --agent codex
```

Add `--global` to install it for every Codex project. The skill keeps RAG as a
discovery layer, verifies important information against source notes, reads the
selected vault's own `AGENTS.md`, and requires local filesystem authority for
edits. It does not add MCP write capability or grant permission to commit,
sync, or push.

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
