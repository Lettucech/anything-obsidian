# Native App (npm Distribution) Design

Date: 2026-10-07
Status: implemented (phase 1)

## Goal

Ship Anything Obsidian as a plain npm package. After `npm i -g`, the
`anything-obsidian` CLI performs one-time setup (`init`) and background
scheduler control (`start-bg`/`stop`); everyday management (add vault, sync,
embed, agents, health) happens in the browser dashboard, which reuses the
existing UI unchanged. No Docker is required.
The existing Docker stack keeps working untouched; both forms coexist on one
machine (Docker dashboard on 11300, native dashboard on 11400).

AnythingLLM stays a pure client concern: `init` records a base URL and API key
(a mini shared instance, local AnythingLLM Desktop, or any remote instance).
The app never hosts or manages AnythingLLM.

LaunchAgent auto-start, job persistence, Keychain storage for the
API key, and npm publishing are explicitly phase 2. The app stays
npm-distributed; there is no desktop-shell packaging step in the roadmap.

## Prerequisites

- Node.js >= 18 and git on the host. `init` checks git and reports a missing
  binary before writing anything.
- The vault root should live in a self-created folder such as `~/ObsidianVaults`
  to avoid macOS TCC prompts around Documents and Desktop. `init` warns and
  asks for confirmation when the chosen root sits inside those folders.

## Config store: `lib/app-config.mjs`

All state lives under one root directory: by default
`~/Library/Application Support/anything-obsidian` on macOS
(`%APPDATA%\anything-obsidian` on Windows, `${XDG_CONFIG_HOME:-~/.config}/anything-obsidian`
elsewhere). `ANYTHING_OBSIDIAN_HOME` overrides the root for tests and
walkthroughs.

Layout:

- `config.json` (0600): `vaultsRoot`, `anythingllmBaseUrl`, `apiKey`,
  `dashboardPort` (default 11400).
- `registry/vaults.json` — the same vault registry format as Docker mode.
- `secrets/` (0700) — per-vault HTTPS credentials (0600 files).
- `agent-tokens/` — MCP agent tokens.
- `state/` — worker manifests.
- `logs/scheduler.log` — scheduler and worker output.
- `run/scheduler.pid` — background scheduler pid file.

`normalizeConfig` validates every field (absolute vault root, HTTP(S) URL,
non-empty key, 1–65535 port) and `nativeEnv(config, paths, { env })` maps the
config to the exact environment variables the existing worker and dashboard
already consume: `VAULTS_ROOT`, `VAULT_REGISTRY_PATH`, `VAULT_SECRETS_PATH`,
`VAULT_STATE_ROOT`, `AGENT_TOKENS_PATH`, `ANYTHINGLLM_BASE_URL`,
`ANYTHINGLLM_API_KEY`, `DASHBOARD_PORT` (plus `PATH`/`HOME` pass-through).

## Spawn-based jobs: `dashboard/local-jobs.mjs`

`createLocalJobManager` mirrors `createJobManager` exactly (`start`, `get`,
`latest`, `list`, one job per vault, `requiresAnythingLLM` gate against the
service snapshot). Instead of creating Docker containers it spawns
`node scripts/worker.mjs <action> --vault <id>`:

- stdout and stderr stream into `job.logs` with a rolling 500-line cap; every
  capture runs through `redactSecretsText` so secrets never sit unredacted in
  job state.
- The child's exit code sets `succeeded`/`failed` and `job.error`
  (`Worker exited with N`); spawn errors become `failed` with `exitCode: null`.
- The child env is the `nativeEnv` mapping, so the worker reads the user's
  config paths rather than the container paths.

The same module hosts the scheduler process helpers used by both the server
power button and the CLI: `startSchedulerProcess` (detached spawn of
`scripts/worker.mjs scheduler`, append-mode stdio into
`logs/scheduler.log`, pid written to `run/scheduler.pid`, `unref`),
`readSchedulerStatus` (pid file + `kill(pid, 0)` with ESRCH/EPERM handling),
`stopSchedulerProcess` (SIGTERM, bounded grace, SIGKILL fallback, pid file
cleanup), and `tailLogFile` for the logs panel.

## Server: `dashboard/server.mjs` gains `mode`

`createDashboardServer({ mode = "docker" | "native", native = { … } })`.
Docker mode is untouched (all pre-existing tests stay green).

- Native `serviceSnapshot` returns three services with the same shape the
  frontend already renders: `anythingllm` (probes the configured instance via
  `listWorkspaces`), `scheduler` (pid file + `kill(pid, 0)`), and `git`
  (`git --version`). `classifySystemState` then yields on/off/partial with no
  frontend changes.
- `/api/system/on|off` start and stop the background scheduler instead of
  toggling containers; AnythingLLM and git are host-side facts, not services
  the app controls.
- `/api/logs?service=syncer` (the frontend's existing request) and
  `service=scheduler` return the redacted tail of `logs/scheduler.log`; the
  `{ logs }` response shape is unchanged. Unknown ids still return 400.
- `publicConfig(env, "native")` reports the configured dashboard/AnythingLLM
  URLs and the vault root.
- The "AnythingLLM setup required" page points native users at
  `anything-obsidian init` instead of `docker compose`.
- Native mode requires `native.schedulerPidPath`/`native.schedulerLogPath` and
  defaults `jobs` to `createLocalJobManager({ env })`.

## Import folder browse: `/api/import-tree`

`dashboard/import-tree.mjs` lists subdirectories for the add-vault dialog in
both modes:

- `GET /api/import-tree` lists the vault root;
  `?path=<absolute path>` descends into a folder.
- Containment is enforced against the *real* path of the vault root (symlinked
  parents such as `/var` → `/private/var` on macOS cannot be used to escape);
  traversal and outside paths return 403, missing paths 404.
- Only real directories are listed: symlinked entries, hidden dot-folders, and
  files are skipped.
- Every entry carries `canImport` (it is a direct child of the vault root) and
  the response carries `canUseHere` (the browsed folder itself can be
  imported), matching the registry's direct-child rule.

The dialog grows a **Browse vault root…** panel with breadcrumbs, a directory
list, and **Use this folder**, which fills `importDirectory` (and `importId`
when empty). The button is disabled with an explanatory reason while the
browsed folder is the root or deeper than one level.

## CLI: `bin/anything-obsidian.mjs`

- `init` — checks git, collects the vault root (default `~/ObsidianVaults`,
  TCC warning), AnythingLLM URL and API key, tests the connection with
  `listWorkspaces`, writes the config, creates the layout and vault root.
  `--vaults-root`, `--url`, `--api-key`, `--port` make it non-interactive
  (all three required flags present → no prompts).
- `start` — loads the config, builds the native env, listens on
  `127.0.0.1:<dashboardPort>` (default 11400), and opens the browser.
- `start-bg` — starts the detached scheduler (no-op with a clear message when
  already running).
- `stop` — SIGTERM → SIGKILL → pid file cleanup.
- `--help` / unknown commands print usage.

## Phase 2 progress

- **Auto-start / auto-restart (done 2026-10-13):** `autostart on|off|status`
  registers two per-user macOS LaunchAgents (`app.anything-obsidian.dashboard`
  running `start --no-browser`, `app.anything-obsidian.scheduler` running the
  foreground `scheduler-fg` command) with `RunAtLoad` + `KeepAlive`. While
  autostart is on, launchd owns the processes: `stop` unloads them (they
  return at next login), `start --bg` delegates to `kickstart`, and `status`
  reports launchd state instead of pid files. The installer enables this by
  default (`--no-autostart` to opt out) and also copies the two agent skills
  into detected skill directories (`--no-skills` to opt out). Linux systemd
  units are not implemented.
- **Job persistence, Keychain-backed API key, npm publish:** still open.
  (npm publish is unlikely to ever be needed given `install.sh`.)
