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
surface (`setup --port`; a server also accepts `--admin-port`). Gateway ports
are stored in `gateway/gateway.json`, and the admin listener always binds loopback.

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

## Getting started

Install once. The installer prepares the app and its dependencies, asks for
connection details, then starts and verifies all required services:

```sh
curl -fsSL https://raw.githubusercontent.com/Lettucech/anything-obsidian/main/install.sh | sh
```

For unattended client setup, supply the gateway URL and the user token issued
by its administrator (members can index; readers can search):

```sh
curl -fsSL https://raw.githubusercontent.com/Lettucech/anything-obsidian/main/install.sh | sh -s -- \
  --vaults-root "$HOME/.anything-obsidian/vaults" \
  --url http://<gateway-host>:21500 --api-key <user-token> --no-browser
```

A solo client can use an AnythingLLM URL and developer key directly. AnythingLLM
is always an external dependency, operated by the user.

The normal commands are the same on clients and gateways:

```sh
anything-obsidian start          # all configured services, in the background
anything-obsidian stop           # stop now; preserve autostart preference
anything-obsidian restart        # restart and verify readiness
anything-obsidian status         # service readiness, startup and indexing health
anything-obsidian status --json  # exit 0 and ok:true only when healthy
anything-obsidian logs -f        # follow the primary role's log
anything-obsidian logs mcp       # inspect a particular service
```

`start` is idempotent: repeating it leaves healthy services running. There is
no `--bg`, `start-bg`, separate gateway start command, or detached PID-file
lifecycle. `run dashboard|scheduler|mcp|mcp-lan|gateway` is a foreground diagnostic
entry point; it uses the same configuration and rejects a second instance.

Setup enables autostart for a new installation. Reconfiguration preserves the
existing startup preference. Services restart after crashes:

- macOS LaunchAgents start **after the user logs in**, not before login.
- Linux clients use systemd user services. A gateway must have linger enabled
  to run **at boot without a login**: run `loginctl enable-linger <user>` once
  (the OS may require administrator authorization). Status checks and reports
  this; setup cannot report success with an unfulfilled gateway startup guarantee.

`autostart on|off|status` changes or inspects startup preference. Turning it off
leaves running services alone. To stop now and prevent future automatic starts,
run `anything-obsidian autostart off`, then `anything-obsidian stop`.

The client dashboard is at [localhost:21502](http://localhost:21502). It manages
vaults, sync policy, index rebuilds and agent access. Managed vaults live beneath
the configured root; imported directories stay where their owner keeps them.

Configuration lives under one absolute data root:

- macOS: `~/Library/Application Support/anything-obsidian/`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/anything-obsidian/`
- Override: `ANYTHING_OBSIDIAN_HOME`

The installer pins the resolved root in its CLI launcher. Every service also
records that root explicitly, so shell environment changes and login sessions
cannot select another configuration accidentally. `status` prints the root.
`installation.json` records installed roles and startup preference; `config.json`
holds client settings; `gateway/gateway.json` holds gateway settings. Client and
gateway can coexist without sharing upstream credentials.

Update with `anything-obsidian update`. Dependencies and entry points validate in
staging before the running release is replaced. Activation restarts installed
services and checks readiness; a failed activation restores and verifies the
previous release. Configuration and source files stay in the data/vault roots.

**Breaking operations release:** old CLI commands are removed. Existing installs
must run `anything-obsidian setup` (and `setup --server` for a gateway) to record
their roles. Existing registries and source files are kept. Embedding manifests
now record their target and are verified against the remote workspace; the first
run may re-upload files whose old manifest cannot establish that identity.

Uninstall keeps data and vault directories by default:

```sh
curl -fsSL https://raw.githubusercontent.com/Lettucech/anything-obsidian/main/uninstall.sh | sh
```

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
anything-obsidian lan on --allowed-hosts obsidian-host.local,192.168.1.10
```

The allowed host list is saved in client configuration and reused after restart.
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

1. **Install on the server** with the server entry point — it configures
   for the gateway, registers and verifies the gateway service. A client role can be
   configured separately on the same machine:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/Lettucech/anything-obsidian/main/install-server.sh | sh -s -- \
     --url http://localhost:21501 --api-key <developer-key>
   ```

   (Same installer underneath: `install.sh --server`. The vault-root
   question is skipped — a gateway doesn't manage local vaults.)

   The CLI installs as `anything-obsidian`, with `any-obs` as a short form —
   `any-obs start`, `any-obs status`, same thing.
   The gateway reads the URL from this config; the key you paste here is
   only a starting point and can be rotated later in the dashboard. No
   Docker is needed — and because the gateway is native, **directory
   sources work on any path the server can read** (git sources clone into
   the data directory as usual).

2. **Services start as part of setup.** Use `anything-obsidian start`,
   `stop`, `restart`, `status` and `logs -f` for subsequent operation. To
   reconfigure a gateway, use `anything-obsidian setup --server --url <url>
   --api-key <developer-key>`. This never rewrites client configuration.

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
   the **Overview** with client and MCP connection snippets, plus **Operations**
   with persistent job history, progress, redacted logs, cancellation and retry.
   **Refresh changed** performs an incremental refresh; **Rebuild all** uploads
   every eligible file and verifies replacements before removing old copies.
   A source removal queues a tracked cleanup job and preserves its source files.
   Failed cleanup stays visible and retryable. Full API
   surface: `docs/superpowers/specs/2026-10-28-iam-middleware.md`.

- **Onboarding a user** (admin): create them in the gateway dashboard
  (they default to reader — promote to member when they should index their
  own vaults) and hand them two things: the gateway URL
  `http://<server>:21500` and their token. That is all a user ever needs.
- **any-obs clients** connect exactly as before —
  `--url http://<server>:21500 --api-key <user-token>`; `anything-obsidian
  status` shows whose token the machine holds ("via gateway, as 'brian'
  (member)"). The unified workspace
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

Use the dashboard for registration and indexing policy; CLI and dashboard use
the same OS service controller. Client scheduler/manual workers share a
cross-process vault lock. Gateway jobs are accepted only after being persisted,
coalesce concurrent refreshes for the same source, carry deadlines, and retain
interrupted jobs for retry after restart. Active jobs are retained while bounded
terminal history and log tails prevent unbounded growth.

The source directory is authoritative. Indexing checks remote document presence,
repairs missing documents even when source hashes are unchanged, and commits an
atomic manifest only after remote verification. Rebuild bypasses the local hash
cache. If an embedding provider fails behind an HTTP 200, verification fails and
the last good manifest remains available for recovery. Uploads from failed jobs
are derived data; a later successful refresh reconciles stale indexed copies.

```sh
anything-obsidian status --json
anything-obsidian logs scheduler --follow
anything-obsidian logs gateway --follow
```

Gateway source discovery and job metadata respect workspace grants. Refresh
requires a granted member or an administrator; force rebuild, retry, cancellation,
full logs and source configuration require administration. Loopback administration
also rejects cross-origin browser requests and DNS rebinding hostnames.

### AnythingLLM compatibility

any-obs uploads documents into a **single-segment** folder
(`anything-obsidian-vault-<vaultId>`) via
`POST /api/v1/document/upload/{folder}`. AnythingLLM builds of 2026-10-04 and
later reject folder names containing path separators; the URL-encoded nested
folder (`anything-obsidian-vault/<vaultId>`) an earlier any-obs sent was never
documented behaviour and now fails with `Folder name cannot contain path
separators`. AnythingLLM ships on `:latest` and may tighten other endpoints
without a version gate, so after upgrading either side run
**Run doctor** in the client dashboard (or the `any_obs_vault_doctor` MCP tool) — it probes the real upload path, not just workspace reachability,
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
