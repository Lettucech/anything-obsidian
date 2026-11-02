# AGENTS.md

Guidance for AI agents working in this repository, or helping a user install
and operate Anything Obsidian on their machine.

## What this project is

Anything Obsidian (short name: any-obs) is a local bridge between Obsidian
vault directories and a provided AnythingLLM instance: it manages vault
registration and optional Git sync, and mirrors vault content into the
AnythingLLM RAG index. AnythingLLM is always an external, user-provided
dependency (URL + API key in config) — the app never hosts it.

It ships as a plain Node app, installed by `install.sh`, managed by the
`anything-obsidian` CLI and a browser dashboard on port 21502. MCP endpoints:
loopback 21503, optional LAN 21504 (`lan on`, Bearer token required).

**One install, one process, one dashboard.** A single supervised service
(`anything-obsidian run app`, launchd/systemd label
`app.anything-obsidian.app`) hosts the dashboard, the local MCP listener and
the sync scheduler in one process. The IAM **gateway** is an opt-in feature
of that same process — off by default: enable it with
`anything-obsidian gateway on` or the dashboard Gateway card, and it opens
the public plane on 21500 (token-gated) while its admin surface mounts on
the dashboard (`/api/gateway/*`) with its console at `/gateway/`. Toggling
features never restarts the service; listeners open and close in-process
(`lib/features.mjs`). `setup --server` survives only as an alias for
"setup, then enable the gateway". The gateway is the sole holder of the
AnythingLLM admin key (in `gateway/gateway.json`, never in env), scopes
every client with per-user tokens, and its shared-source pipeline is the
only writer to shared workspaces. Disabling the gateway keeps its users,
workspaces and sources on disk. AnythingLLM itself is never bundled
or hosted — it is always an external dependency the user provides (an
optional reference compose for running it ships at
`server/anythingllm.compose.yml`, but the operator starts it and any-obs
never manages its lifecycle). See
`docs/superpowers/specs/2026-10-28-iam-middleware.md`.

Native Node remains the default; an optional Docker flavor keeps the older
one-role-per-container model (`Dockerfile`, `compose.yaml`,
`docs/docker.md`) and has **not** migrated to the merged process yet. No
Electron/desktop-shell or npm-publish plan. Docker uses separate named
volumes, Git sources only, and token-protected admin dashboards. Never mount
the host filesystem, Docker socket, or native data directories into these
containers. Docker owns service restart, startup policy and image updates; no
launchd/systemd runs inside the image.

The root `package.json` now
carries real dependencies (MCP SDK, zod, proper-lockfile); `install.sh` runs `npm ci --omit=dev`
and `anything-obsidian update` refreshes both app and dependencies.

## Helping a user install and set up

Use the `skills/anything-obsidian-setup/SKILL.md` playbook. Short version:

```sh
curl -fsSL https://raw.githubusercontent.com/Lettucech/anything-obsidian/main/install.sh | sh -s -- \
  --vaults-root ~/.anything-obsidian/vaults --url <anythingllm-url> --api-key <key>
anything-obsidian status --json   # exit 0 + "ok": true == done
```

For a client, setup asks the mode explicitly: local (AnythingLLM URL +
developer key, the default) or join a gateway (gateway URL + issued user
token). For serving others, enable the gateway feature after a local setup
(`gateway on` or `setup --server`); collect the external AnythingLLM URL
and developer API key (Settings → Developer API). Never invent a credential. Verify with `status --json` after every change.

The installer calls `setup`, which configures the installation, starts the
single app service and verifies readiness. `start` is idempotent and
backgrounded through the platform supervisor. `stop` preserves autostart;
`autostart off` changes startup preference without stopping running services.
Use both to stop permanently. `restart`, `status --json`, and
`logs [app] --follow` work on every install; pre-merge log names
(`dashboard`, `scheduler`, `mcp`, `mcp-lan`, `gateway`) are still readable.

macOS starts after login. Linux installs need `loginctl enable-linger <user>`
for boot without login; status must not claim that guarantee unless verified.
Service definitions pin the absolute data root. Client config is `config.json`;
gateway upstream credentials and ports are exclusively `gateway/gateway.json`.
`installation.json` records roles, the `lan` flag and autostart preference
(gateway enabled ⇔ `roles` contains `"gateway"`). First `start`/`restart`
after an upgrade migrates automatically: legacy per-role launchd/systemd
definitions are removed, and a gateway-only install gains a `config.json`
synthesized from `gateway.json`. No legacy command
aliases or environment overrides of gateway credentials are supported.

## Repo conventions

- Pure Node ESM (`type: module`) with a minimal dependency set (the MCP SDK,
  zod, and proper-lockfile, installed by `install.sh`); reach for `node:` builtins and the
  global `fetch` first, and think twice before adding anything else.
- Tests: `npm test` runs `node --test` over `mcp/ dashboard/ lib/ scripts/
  bin/ server/` (the MCP server is plain JS now).
- Network boundaries: native dashboard and local MCP bind `127.0.0.1` only (21502 /
  21503); the LAN MCP (21504) is opt-in, RAG-only, and token-gated. Secrets
  never appear in API responses or logs (`redactSecretsText` /
  `redactSecretsObject`).
  Docker binds these listeners inside its network namespace, publishes host
  loopback ports by default, requires an admin token/session for dashboards and
  a Bearer/agent token for client MCP. Keep native loopback trust unchanged.
- Vault locations come in two flavours, and the registry records which:
  `managed` entries live beneath `VAULTS_ROOT` and must be direct children of
  it — any-obs owns that area; `imported` entries store an absolute
  `importPath` to a directory the user already owns, never auto-sync unless
  they ask, and that directory is the boundary every raw-file tool anchors
  its traversal checks to. Never collapse the two: a managed resolve must not
  accept an absolute path, and an imported resolve must not be re-joined onto
  the root.
- One unified AnythingLLM workspace per instance (registry top-level
  `workspace`), namespaced `any-obs-<host>-<suffix>` so instances sharing one
  AnythingLLM never collide. All vaults embed into it; upload chunk sources
  carry `<vaultId>/<vault-relative path>` so unified RAG results map back to
  the owning vault. Document folders stay per vault
  (`anything-obsidian-vault-<vaultId>`, single segment).
- Removing a vault from management never deletes its repository, the unified
  workspace, or the user's files — preserve this rule everywhere, including
  scripts. Its derived chunks and document folder do leave the unified index
  (manifest-driven purge on removal); that is required to keep the shared
  index truthful.

## Data directories (never delete casually)

- App + portable runtime: `~/.anything-obsidian/`
- Data (config.json 0600, secrets/, registry/, agent-tokens/, state/, logs/,
  run/ PID files): `~/Library/Application Support/anything-obsidian/`
  (override with `ANYTHING_OBSIDIAN_HOME`)
- User vaults: the configured vaults root (default
  `~/.anything-obsidian/vaults`) holds managed vaults; imported vaults live
  wherever the user's directory is (e.g. `~/Workspace/my-vault`). Both are
  the user's actual notes — never delete either.

`uninstall.sh` already follows the safe-by-default rules; do not "improve"
it into deleting user data implicitly.
