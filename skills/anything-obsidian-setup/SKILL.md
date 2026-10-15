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

A local control plane that syncs Git-backed Obsidian vaults and mirrors them
into an AnythingLLM RAG index. It talks to an **existing** AnythingLLM
instance (shared mini instance, AnythingLLM Desktop, or a remote server) — it
never hosts AnythingLLM itself. No Docker, no admin rights, no sudo needed.

## Install (one command, zero prompts when flags are given)

```sh
curl -fsSL https://raw.githubusercontent.com/Lettucech/anything-obsidian/main/install.sh | sh -s -- \
  --vaults-root <absolute-path> --url <anythingllm-base-url> --api-key <key> [--port <n>] [--no-browser]
```

- The installer bootstraps everything: if the machine has no node ≥ 18 it
  downloads a portable Node into `~/.anything-obsidian/runtime/`; no
  Homebrew and no sudo are required. git must exist (on a bare macOS run
  `xcode-select --install` first).
- As an agent, prefer the non-interactive flags above. Before installing,
  collect from the user:
  1. **vaults-root** — propose `~/ObsidianVaults` (never Documents/Desktop —
     macOS permission prompts); create nothing yourself, the installer does it.
  2. **AnythingLLM base URL** — where their instance serves the API, e.g.
     `http://localhost:11301` for a local AnythingLLM Desktop.
  3. **API key** — from AnythingLLM Settings → Developer API. Ask the user to
     paste it; never invent one.
- Interactive humans can drop the flags entirely: the installer asks the same
  questions.

## Keeping it current

```sh
anything-obsidian update   # re-downloads the app + dependencies, keeps all data
```

## Verify (do this after every install or change)

```sh
anything-obsidian status --json
```

Exit code `0` plus `"ok": true` means: config present, git found, AnythingLLM
reachable. Check these fields:

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
- The dashboard URL is `http://localhost:21400` unless a `--port` was set.
After setup, a local agent can also operate Anything Obsidian through the
MCP management tools (`any_obs_*` on the loopback endpoint, e.g.
`any_obs_status`, `any_obs_vault_add`, `any_obs_vault_sync`, `any_obs_lan`)
— tokenless on loopback, never available on the LAN profile.

The installer turns autostart on by default (opt out with `--no-autostart`).
All state lives under one data directory (`~/Library/Application Support/
anything-obsidian` on macOS) plus the app itself in `~/.anything-obsidian/`.
Never edit files in those directories directly; use the CLI or the dashboard.

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
