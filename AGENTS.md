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
`anything-obsidian` CLI and a browser dashboard on port 21502. MCP endpoint:
loopback 21503. There are exactly **two connection kinds**: local
(loopback, owner-trusted, full tool surface) and remote (the opt-in
**server**, token-gated, RAG-only). A remote agent needs no install at
all: it connects straight to the server's `/mcp` on 21500 with a Bearer
user token (the Claude plugin's manifest takes a server endpoint + token
for this). The former LAN MCP listener (21504)
and its agent-token store were retired 2026-11; `lan on` is a no-op and
old agent tokens migrated by hash into server users
(`lib/lan-migration.mjs`).

**One install, one process, one dashboard.** A single supervised service
(`anything-obsidian run app`, launchd/systemd label
`app.anything-obsidian.app`) hosts the dashboard, the local MCP listener and
the sync scheduler in one process. The **server** (formerly "gateway") is an
opt-in feature of that same process — off by default: enable it with
`anything-obsidian server on` or the dashboard Server card (`gateway on`
stays as a deprecated alias), and it opens the public plane on 21500
(token-gated) while its admin surface mounts on the dashboard
(`/api/gateway/*` — URL paths kept for compatibility) with its console at
`/gateway/`. Toggling features never restarts the service; listeners open
and close in-process (`lib/features.mjs`). `setup --server` is the real
name for "setup, then enable the server". The server is the sole holder of
the AnythingLLM admin key (in `gateway/gateway.json` — filename kept —
never in env), scopes every client with per-user tokens, and its
shared-source pipeline is the only writer to shared workspaces. Disabling
the server keeps its users, workspaces and sources on disk. AnythingLLM
itself is never bundled or hosted — it is always an external dependency the
user provides (an optional reference compose for running it ships at
`server/anythingllm.compose.yml`, but the operator starts it and any-obs
never manages its lifecycle). See
`docs/superpowers/specs/2026-10-28-iam-middleware.md` and
`docs/superpowers/specs/2026-11-02-client-server-simplification.md`.

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
developer key, the default) or join a server (server URL + issued user
token). For serving others, enable the server feature after a local setup
(`server on` or `setup --server`); collect the external AnythingLLM URL
and developer API key (Settings → Developer API). Never invent a credential. Verify with `status --json` after every change.
Make sure the AnythingLLM instance has an **LLM Preference** set in its UI
(Settings → AI Providers): any-obs never chats, but AnythingLLM's own
vector-search constructs an LLM connector per search and answers 500 when
none is configured.

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
server upstream credentials and ports are exclusively `gateway/gateway.json`.
`installation.json` records roles and autostart preference (server enabled ⇔
`roles` contains `"server"`). First `start`/`restart` after an upgrade
migrates automatically: legacy per-role launchd/systemd definitions are
removed, a server-only install gains a `config.json` synthesized from
`gateway.json`, a legacy `"gateway"` role token is rewritten to `"server"`,
and LAN agent tokens become server users. The only supported legacy alias
is `gateway on|off|status` → `server`; no environment overrides of server
credentials are supported.

## Repo conventions

- Pure Node ESM (`type: module`) with a minimal dependency set (the MCP SDK,
  zod, and proper-lockfile, installed by `install.sh`); reach for `node:` builtins and the
  global `fetch` first, and think twice before adding anything else.
- Tests: `npm test` runs `node --test` over `mcp/ dashboard/ lib/ scripts/
  bin/ server/` (the MCP server is plain JS now).
- Network boundaries: native dashboard and local MCP bind `127.0.0.1` only
  (21502 / 21503); the server plane (21500) is opt-in, RAG-only, and
  token-gated. Secrets never appear in API responses or logs
  (`redactSecretsText` / `redactSecretsObject`).
  Docker binds these listeners inside its network namespace, publishes host
  loopback ports by default, requires an admin token/session for dashboards and
  a Bearer token for client MCP. Keep native loopback trust unchanged.
- Vault locations come in two flavours, and the registry records which:
  `managed` entries live beneath `VAULTS_ROOT` and must be direct children of
  it — any-obs owns that area; `imported` entries store an absolute
  `importPath` to a directory the user already owns, and that directory is the
  boundary every raw-file tool anchors its traversal checks to. Location and
  git-ness are independent: an imported directory that is itself a git
  checkout defaults to auto pull (explicit `gitAutoPull: false` opts out), and
  a sync tick only pulls when a `.git` entry actually exists (see
  `docs/superpowers/specs/2026-11-05-git-aware-auto-pull.md`). Server shared
  sources follow the same rule: a `dir` source that is a git repo is pulled
  with its own origin and the host's credential helpers before every refresh.
  Shared sources additionally accept optional per-source HTTPS credentials
  (collected at add time, stored 0600 under the gateway secrets dir): a
  source with a stored token runs git through GIT_ASKPASS with ambient
  credential helpers disabled, so headless scheduled syncs never pop a
  keychain prompt.
  Never collapse the two: a managed resolve must not
  accept an absolute path, and an imported resolve must not be re-joined onto
  the root.
- One AnythingLLM workspace **per vault** (per-vault model, 2026-11 — see
  `docs/superpowers/specs/2026-11-02-per-vault-workspaces.md`), slugged
  `any-obs-<host>-<vaultId>` (deterministic, recorded on the vault record's
  `workspaceSlug`) so instances sharing one AnythingLLM never collide. Upload
  chunk sources carry `<vaultId>/<vault-relative path>` so RAG results map
  back to the owning vault. Document folders stay per vault
  (`anything-obsidian-vault-<vaultId>`, single segment). The registry's
  top-level `workspace` record is a legacy migration marker only; the
  first app start after upgrade migrates a unified install (assign per-vault
  slugs, wipe manifests for a full re-embed, delete the unified workspace
  best-effort, clear the marker).
- Removing a vault from management never deletes its repository or the
  user's files — preserve this rule everywhere, including scripts. Its
  derived chunks and document folder leave the index, and its own (now
  empty) workspace is deleted; other vaults' workspaces are never touched.

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
