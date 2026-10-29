---
name: anything-obsidian-setup
description: Install, configure, verify, or remove Anything Obsidian on a user's machine — the one-command installer, agent-friendly setup flags, health checks, and uninstall.
---

# Anything Obsidian Setup

## When to Use

Use this skill when an agent must:

- install Anything Obsidian on a user's machine (macOS or Linux);
- complete its one-time setup (vault root, AnythingLLM connection);
- check whether an existing installation is healthy;
- stop, restart, or uninstall it; or
- onboard a non-technical user by doing all of the above for them.

## Do Not Use When

The app is already installed and the user only wants to manage vaults day to
day — point them at the browser dashboard, or use the
`anything-obsidian-vault-workflow` skill for vault work. This skill is only
about machine setup.

## What Anything Obsidian is

Anything Obsidian (short name: any-obs) is a local bridge between Obsidian
vault directories and a provided AnythingLLM instance. It registers vaults
(cloned under a vaults root or imported from any existing directory), syncs
them over Git when configured, and mirrors their content into the RAG index
of an AnythingLLM the user provides and runs themselves (shared Docker
deployment, AnythingLLM Desktop, or a remote server) — it never hosts
AnythingLLM. The app itself is a plain Node process: no Docker, no admin
rights, no sudo needed.

All vaults of one install embed into a single unified AnythingLLM workspace
(created automatically with the first vault, or attachable to an existing
one) — agents search it once and results name the owning vault. RAG search
never requires picking a vault first.

## Two install personas

- **User/solo** — the normal `install.sh`: connects to the user's own
  AnythingLLM (direct) or to a shared gateway (user token). Registering
  vaults, sync, dashboard.
- **Server** — `install-server.sh` (i.e. `install.sh --server`): for the
  machine running the IAM gateway for a shared deployment. The credential
  here IS the AnythingLLM developer key; the vault-root prompt is skipped;
  autostart registers the gateway service. Verify with
  `anything-obsidian status` and the gateway admin dashboard on loopback
  :21505.

## Install (one command, zero prompts when flags are given)

```sh
curl -fsSL https://raw.githubusercontent.com/Lettucech/anything-obsidian/main/install.sh | sh -s -- \
  --vaults-root <absolute-path> --url <anythingllm-base-url> --api-key <key> [--port <n>] [--no-browser]
```

- The installer bootstraps everything: if the machine has no node ≥ 22 it
  downloads a portable Node into `~/.anything-obsidian/runtime/`; no
  Homebrew and no sudo are required. git must exist (on a bare macOS run
  `xcode-select --install` first).
- As an agent, prefer the non-interactive flags above. Before installing,
  collect from the user:
  1. **vaults-root** — propose the default `~/.anything-obsidian/vaults`
     (never Documents/Desktop — macOS permission prompts); create nothing
     yourself, the installer does it. If the user already keeps notes in an
     existing folder, keep this default and import that folder later with
     `sourceMode: "import"` + its absolute `importPath`.
  2. **Client installs are gateway-first**: collect the **gateway URL**
     (`http://<server>:21500`) and the **any-obs user token** issued by the
     admin — never an AnythingLLM key. A reader token can search but not
     index; indexing needs member.
  3. Solo setups pointing straight at an AnythingLLM still work without
     asking anything: init tries `/api/gateway/me`, falls back to direct
     mode, and reports "direct — no gateway in front". Never invent a key
     or token.
- Interactive humans can drop the flags entirely: the installer asks the same
  questions.

## Keeping it current

```sh
anything-obsidian update   # re-downloads the app + dependencies, keeps all data
```

On the first sync or embed after updating to a release with the unified
workspace (0.3.0+), an existing install migrates automatically: the unified
workspace is created, and every vault re-embeds once. That first sync is
slow and uploads everything — expected, not a fault. Check
`status --json` → `workspace` afterwards; it holds the unified workspace
slug once the first vault exists.

## Verify (do this after every install or change)

```sh
anything-obsidian status --json
```

(Short form: `any-obs` — every command below works as `any-obs <command>` too.)

Exit code `0` plus `"ok": true` means: config present, git found, AnythingLLM
reachable. Check these fields:

- `workspace: null` with `vaults: 0` → normal fresh install; the unified RAG
  workspace appears with the first added vault. `workspace: null` with
  `vaults` ≥ 1 → the unified workspace was never initialised (vault add
  failed midway or an old install never ran a sync since updating); adding
  any vault or running one sync/embed creates it.

- `anythingllm.ok: false` with `AnythingLLM API 401/403` → the API key is
  wrong; re-run `anything-obsidian init --vaults-root … --url … --api-key …`
  with a fresh key from Settings → Developer API.
- `dashboard.healthy: false` but `dashboard.running: true` → wait a few
  seconds and re-check; if still false, read
  `~/Library/Application Support/anything-obsidian/logs/dashboard.log`
  (Linux: `~/.config/anything-obsidian/logs/dashboard.log`).
- `scheduler.running: false` → background sync is off; start it with
  `anything-obsidian start-bg` if the user wants scheduled syncs.

Human-readable form: `anything-obsidian status`.

## Everyday control

- `anything-obsidian start` — dashboard in the foreground (Ctrl+C stops it),
  opens the browser.
- `anything-obsidian start --bg --no-browser` — dashboard as a detached
  background process (agent friendly; does not block the terminal).
- `anything-obsidian start-bg` — background sync scheduler only.
- `anything-obsidian stop` — stops the dashboard and the scheduler.
- `anything-obsidian autostart on|off|status` — keep both running: `on`
  registers per-user services (macOS LaunchAgents, Linux systemd user units)
  so the dashboard and scheduler start at every login and restart
  automatically if they crash. While autostart is on, `stop` unloads the
  services for now (they return at next login) — say so when reporting to the
  user, and use `autostart off` for a permanent stop.
- On a headless Linux server without an active session, autostart needs
  `sudo loginctl enable-linger <user>` once; without it the installer falls
  back to a plain background start.
- The dashboard URL is `http://localhost:21502` unless a `--port` was set.
After setup, a local agent can also operate Anything Obsidian through the
MCP management tools (`any_obs_*` on the loopback endpoint, e.g.
`any_obs_status`, `any_obs_vault_add`, `any_obs_vault_sync`, `any_obs_lan`)
— tokenless on loopback, never available on the LAN profile.

The installer turns autostart on by default (opt out with `--no-autostart`).
All state lives under one data directory (`~/Library/Application Support/
anything-obsidian` on macOS) plus the app itself in `~/.anything-obsidian/`.
Never edit files in those directories directly; use the CLI or the dashboard.

## Agent skills are opt-in via npx

The installer does not install agent skills itself — its final output tells
the user how. To install them (as the user's agent, or on their request):

```sh
npx skills add Lettucech/anything-obsidian --skill anything-obsidian-setup
npx skills add Lettucech/anything-obsidian --skill anything-obsidian-vault-workflow
```

`npx skills` manages the copies (install target, updates, removal) — do not
hand-copy skill directories into `~/.zcode/skills` or similar.

## Uninstall

```sh
curl -fsSL https://raw.githubusercontent.com/Lettucech/anything-obsidian/main/uninstall.sh | sh -s -- --yes            # keep user data
curl -fsSL https://raw.githubusercontent.com/Lettucech/anything-obsidian/main/uninstall.sh | sh -s -- --purge-data    # also remove config/secrets/registry
```

The uninstaller stops running processes, removes the app, the CLI launcher,
and its PATH entry. **Vault folders (the user's actual notes) are never
deleted** — it prints their location instead. Confirm with the user before
passing `--purge-data`, and always report where the vaults live afterwards.

## Safety boundaries

- Never delete or move anything inside the vault root except through the
  user's explicit request; the notes are the user's source of truth.
- Never send the API key anywhere except the AnythingLLM base URL the user
  configured.
- If `status` reports something you cannot fix with the commands above, show
  the user the relevant log line instead of improvising with manual edits.
