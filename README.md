# Anything Obsidian (any-obs)

any-obs is a local bridge between your Obsidian vault directories and a
provided AnythingLLM instance. It owns the vault side — registration
(managed clones under a vaults root, or directories imported from anywhere
on your disk) and optional Git-based sync — and mirrors vault content into
the RAG index of an AnythingLLM instance you provide and run yourself
(Docker, AnythingLLM Desktop, or a remote server). It never hosts
AnythingLLM.

The vault repository is the source of truth; the RAG index is rebuildable
derived data. Over MCP, agents never write vault source files; the local
profile's management tools run the same configured sync and embedding flows
the dashboard offers, never arbitrary Git commands.

## Ports

The whole project owns the range **21500–21510**. Everything listens on
loopback unless marked otherwise:

| Port | Surface | Where |
|---|---|---|
| 21500 | IAM gateway public plane (MCP + user API) | server, published on the LAN |
| 21501 | AnythingLLM UI (wherever you host it) | host loopback only (first-boot setup) |
| 21502 | Client dashboard | loopback only |
| 21503 | Client local MCP | loopback only |
| 21504 | Client LAN MCP | opt-in, LAN, Bearer token required |
| 21505 | Gateway admin dashboard | server loopback only |
| 21506–21510 | Reserved for future any-obs surfaces | — |

AnythingLLM itself keeps its container port 3001 and is never published
beyond the host loopback of the machine it runs on. Ports are overridable per
surface (`--port` at init, `MCP_PORT`, `MCP_LAN_PORT`, `GATEWAY_PORT`);
installs configured before the 21500-range defaults keep their recorded
`dashboardPort` until `anything-obsidian init` is re-run.

## Boundaries

- **Vault management:** the dashboard clones a managed vault beneath the
  user-selected `HOST_VAULTS_ROOT` or imports an existing directory from
  anywhere on disk, and stores only validated registry metadata. All vaults
  of one instance embed into a single shared AnythingLLM workspace created
  on first use.
- **Agent-scoped MCP access:** dashboard-issued agent tokens limit a client's
  MCP visibility to the vaults whose allowlist names it. Tokenless local
  connections keep their existing access to open vaults.
- **Optional Git sync:** the scheduler (or an agent via `any_obs_vault_sync`)
  may pull, commit, and push according to a vault's dashboard configuration.
  Sync follows the configured policy; no MCP tool accepts arbitrary Git
  commands or edits note content.
- **Derived RAG:** the worker updates a vault's AnythingLLM index after the
  configured sync workflow. It never becomes the source for vault files.
  The same rule holds server-side: the only path that writes into the RAG
  index is the vault/source pipeline — user tokens can never upload
  documents or edit embeddings directly, so the index is always a
  rebuildable view of a source directory.
- **No vault ownership:** removing a vault from management does not delete its
  repository or the user's files. Its derived chunks leave the shared index
  (so they stop appearing in searches); the workspace itself stays.

## Getting started (one command)

any-obs runs as a plain Node app — there is no Docker stack to run for it.
The installer bootstraps everything: if the machine has no supported Node.js
(>= 22; Node 18 and 20 are end-of-life) it downloads a portable runtime
automatically (no Homebrew, no sudo), and the CLI itself refuses to run on
anything older. You provide the AnythingLLM instance (shared Docker
deployment, AnythingLLM Desktop, or a remote server); any-obs talks to its
API and never hosts it.

1. Install and set up in one command:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/Lettucech/anything-obsidian/main/install.sh | sh
   ```

   The installer checks prerequisites, installs the app under
   `~/.anything-obsidian/`, puts `anything-obsidian` on your PATH, then asks
   a few setup questions: a vault root (default `~/.anything-obsidian/vaults`,
   inside the app's own home so nothing touches Documents or Desktop), the
   AnythingLLM base URL and Developer API key, and it tests the
   connection before saving a 0600 config under
   `~/Library/Application Support/anything-obsidian/`. When it finishes, the
   dashboard is running and your browser opens at `http://localhost:21502`.

   Prefer no prompts? Pass everything up front (also how agents install it):

   ```bash
   curl -fsSL https://raw.githubusercontent.com/Lettucech/anything-obsidian/main/install.sh | sh -s -- \
     --vaults-root ~/.anything-obsidian/vaults --url http://localhost:3001 --api-key <key> --no-browser
   ```

   Or let your AI agent do it: agents can load the
   `anything-obsidian-setup` skill from this repo
   (`npx skills add Lettucech/anything-obsidian --skill anything-obsidian-setup`)
   and handle the whole flow — install, setup, and health checks.

2. Manage everything in the browser at `http://localhost:21502`. The
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
override with `ANYTHING_OBSIDIAN_HOME`).

Update in place any time (data and settings are kept):

```bash
anything-obsidian update
```

Installs configured before the unified-workspace release (0.3.0) migrate
automatically: on the first sync or embed after updating, every vault
re-embeds once into the shared workspace. That first run is slow and
uploads everything — expected, not a fault.

Sync failures surface in the dashboard (a red banner plus a per-vault
"Last sync" line) and as an OS notification; set `AO_NOTIFY=0` in the
service environment to silence the notifications.

Uninstall in one command — it stops everything (including the LaunchAgents),
removes the app and CLI, and keeps your data and vault folders by default:

```bash
curl -fsSL https://raw.githubusercontent.com/Lettucech/anything-obsidian/main/uninstall.sh | sh
```

See `docs/superpowers/specs/2026-10-07-native-app.md` for the design notes.

## MCP access

### Local MCP

The endpoint is bound to loopback only and starts with autostart:

```text
http://localhost:21503/mcp
```

Every tool is prefixed `any_obs_` — they all belong to this system. The
second segment names the domain:

| Domain | Meaning | Tools |
|---|---|---|
| `any_obs_vault_*` / `any_obs_file_*` | Read the vault source of truth | vault list (with last-sync state)/context/directory, file list/read |
| `any_obs_rag_*` | Query the derived RAG index (verify against source) | search, answer |
| `any_obs_*` (management verbs) | Manage any-obs itself | vault add/update/remove/sync/embed/doctor, job status, agent tokens, status, autostart, LAN |

Loopback callers may use management tools without a token: a local agent
acts as the user's delegate. The LAN endpoint (below) never registers the
management tools.

- `any_obs_vault_list` returns only vault id and name.
- `any_obs_vault_context` is local-only and returns the selected vault's host
  directory, root policy files, non-secret sync settings, and edit boundaries.
- `any_obs_vault_directory` returns the configured host directory for one
  vault, so a local agent with filesystem authority can edit it directly.
- `any_obs_file_list` and `any_obs_file_read` inspect raw Markdown and
  Canvas source files with vault-relative paths and bounded reads.
- `any_obs_rag_search` and `any_obs_rag_answer` query the unified RAG index
  across every managed vault at once — no need to know which vault holds the
  answer first. Search results are tagged with their `vaultId` and
  vault-relative path (map straight to `any_obs_file_read`), and `vaultId`
  optionally filters results to one vault.

Vault file content stays read-only over MCP — there are no tools for
writing, patching, or uploading notes. Management tools change how the
system runs (registration, jobs, tokens, services), never vault source
files.

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

LAN access is opt-in, RAG-only (`any_obs_vault_list`,
`any_obs_rag_search`, `any_obs_rag_answer` — no filesystem tools), and
always requires a Bearer token. Turn it on with one command:

```bash
anything-obsidian lan on          # generates and prints an admin token once
anything-obsidian lan token <t>   # or set your own token
anything-obsidian lan off
```

Remote clients connect to `http://<host>:21504/mcp` and must send:

```text
Authorization: Bearer <lan-token>
```

Dashboard-issued per-agent tokens also work on the LAN endpoint; those callers
see only open vaults plus the vaults that allowlist them. If a remote client
resolves this machine by a LAN hostname or IP, register it first:

```bash
export MCP_ALLOWED_HOSTS=obsidian-host.local,192.168.1.10
```

(put it in the service environment, or re-run `lan on` after setting it).
Keep the dashboard and AnythingLLM management UI on loopback. A LAN bearer
token grants access to RAG results, which may contain source content.

## Shared deployments (the gateway)

For one AnythingLLM shared by several people or agents, run the **gateway**
on the server — the same native app, one command. It holds the single admin
API key, issues per-user tokens, filters every proxied call to the
workspaces each user may read, fans searches out across all of them in one
query, and runs the source pipeline (git pull or directory re-read, then
reindex into the workspace its source targets). Nothing is pre-created:
admins make shared workspaces and grant users onto them (space A to one
team, space B to another), and each user's personal workspace is minted by
their own client.

AnythingLLM itself is never bundled or hosted by any-obs — point the
gateway at whatever instance you already run (official Docker image on the
same server, Desktop, or a remote host). Don't have one yet? A ready-made
reference compose ships with the project — one command, project-reserved
ports, data in its own volume:

```bash
docker compose -p any-obs -f server/anythingllm.compose.yml up -d
```

It publishes AnythingLLM on the server's loopback only (`127.0.0.1:21501`);
your AnythingLLM's URL is then `http://localhost:21501`.

1. **Install on the server** (same one-command installer as any client) and
   point it at your AnythingLLM:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/Lettucech/anything-obsidian/main/install.sh | sh -s -- \
     --vaults-root ~/.anything-obsidian/vaults --url http://localhost:21501 --api-key <developer-key> --no-browser
   ```

   The CLI installs as `anything-obsidian`, with `any-obs` as a short form —
   `any-obs gateway --bg`, `any-obs status`, same thing.
   The gateway reads the URL from this config; the key you paste here is
   only a starting point and can be rotated later in the dashboard. No
   Docker is needed — and because the gateway is native, **directory
   sources work on any path the server can read** (git sources clone into
   the data directory as usual).

2. **Start it and keep it running:**

   ```bash
   anything-obsidian gateway --bg       # one-off background start
   anything-obsidian autostart gateway on   # start at login, restart on crash
   ```

   On a headless Linux server, run `sudo loginctl enable-linger $USER` once
   so the gateway (like every other any-obs service) keeps running without
   an active login session.

3. **Open the admin dashboard** — it is loopback-only
   (`http://localhost:21505` on the server, or
   `ssh -L 21505:127.0.0.1:21505 <server>` from your machine). Reaching it
   is the admin credential — same trust model as the client dashboard.
   Follow the two-step wizard:

   - **Step 1 — initialize AnythingLLM:** its own UI is wherever you host
     it — with the reference compose that is `http://localhost:21501` on
     the server (tunnel `ssh -L 21501:127.0.0.1:21501 <server>` from your
     machine). Finish AnythingLLM's first-boot wizard and generate the
     developer API key (Settings → Developer API).
   - **Step 2 — connect:** paste the key. The gateway verifies it, becomes
     its only holder (it never lives on any user's machine), and you can
     rotate it any time in the Settings tab.

   After setup, the dashboard's tabs manage everything day to day:
   **Workspaces** (create shared or personal workspaces — shared ones start
   with an empty grants list; grant and revoke users per workspace; workspaces
   that exist in AnythingLLM but not in the gateway show up as untracked for
   you to adopt or delete), **Users** (create with a role — `member` runs
   an any-obs client, `admin` may also manage the gateway with their token,
   `reader` is search-only, and new users default to reader — change roles
   later, reset a lost token), **Shared sources** (register the git repos or
   server directories that feed a workspace; each source targets one), and
   the **Overview** with client and MCP connection snippets. Full API
   surface: `docs/superpowers/specs/2026-10-28-iam-middleware.md`.

- **any-obs clients** connect exactly as before —
  `--url http://<server>:21500 --api-key <user-token>`. The unified workspace
  their client creates is recorded as that user's personal workspace, and
  granted shared workspaces are first-class on the client too: its
  `any_obs_rag_search` fans out across everything the token can see and the
  client dashboard shows the visible workspaces. (Grant a user a shared
  workspace in the gateway's Workspaces tab first — a shared workspace with
  an empty grants list is invisible by design.)
- **Agents without a local any-obs** use the token-gated MCP endpoint at
  `http://<server>:21500/mcp`: `any_obs_rag_search` (fan-out),
  `any_obs_rag_answer`, `any_obs_shared_refresh`, `any_obs_job_get`.
- **Shared knowledge** enters the index only through registered sources
  (git repositories or server directories) refreshed by the pipeline —
  schedule them with an interval or queue a refresh on demand.
- **Gateway state** (key, users, sources, manifests, git clones) lives
  under the data directory too, in `gateway/` next to the client's
  registry and secrets — same backup and `ANYTHING_OBSIDIAN_HOME` rules as
  everything else. Migrating from an early Docker install? Copy the
  container's `/data` contents into that `gateway/` directory.

## Operations

The dashboard is the normal interface for vault registration, per-vault sync
policy, embedding policy, and service health. For recovery or explicitly
requested maintenance, use the worker commands:

```bash
anything-obsidian status
tail -f "$HOME/Library/Application Support/anything-obsidian/logs/scheduler.log"
```

These operations are outside the MCP surface. They can modify Git or derived
RAG state according to the selected vault configuration.

### AnythingLLM compatibility

any-obs uploads documents into a **single-segment** folder
(`anything-obsidian-vault-<vaultId>`) via
`POST /api/v1/document/upload/{folder}`. AnythingLLM builds of 2026-10-04 and
later reject folder names containing path separators; the URL-encoded nested
folder (`anything-obsidian-vault/<vaultId>`) an earlier any-obs sent was never
documented behaviour and now fails with `Folder name cannot contain path
separators`. AnythingLLM ships on `:latest` and may tighten other endpoints
without a version gate, so after upgrading either side run
`node scripts/worker.mjs doctor --vault <id>` (or the `any_obs_vault_doctor`
MCP tool) — it probes the real upload path, not just workspace reachability,
and fails loudly if the endpoint no longer accepts the configured folder.

## Safety notes

- Keep secrets out of Git: the API key and LAN token live only in the local
  config file (`~/Library/Application Support/anything-obsidian/config.json`,
  mode 0600), never in the repository.
- Two ways to add a vault: **managed** (a directory the installer created
  under the vaults root — any-obs owns its location) or **imported** (any
  existing directory you point at, e.g. `~/Workspace/my-vault` — you own the
  location and any-obs never moves or auto-syncs it). Managed entries must be
  direct children of the vaults root; an imported entry stores its absolute
  path and that directory becomes its own boundary for every raw-file tool.
- Local raw-vault tools reject traversal, symlinks, Git metadata, unsupported
  file types, and unbounded reads.
- LAN MCP is read-only and token-protected, but it is still an information
  access boundary; expose it only on a trusted network.
