# AGENTS.md

Guidance for AI agents working in this repository, or helping a user install
and operate Anything Obsidian on their machine.

## What this project is

Anything Obsidian is a local control plane connecting Git-backed Obsidian
vaults with AnythingLLM RAG indexes. Two forms coexist:

- A plain Node app, installed by `install.sh`, managed by the
  `anything-obsidian` CLI and a browser dashboard on port 21400. AnythingLLM
  is always an external client-side dependency (URL + API key in config) —
  the app never hosts it. MCP endpoints: loopback 21433, optional LAN 21444
  (`lan on`, Bearer token required).

There is no Docker stack, no Electron/desktop-shell plan, and no npm publish —
distribution is `install.sh` from this repo. The root `package.json` now
carries real dependencies (MCP SDK, zod); `install.sh` runs `npm ci --omit=dev`
and `anything-obsidian update` refreshes both app and dependencies.

## Helping a user install and set up

Use the `skills/anything-obsidian-setup/SKILL.md` playbook. Short version:

```sh
curl -fsSL https://raw.githubusercontent.com/Lettucech/anything-obsidian/main/install.sh | sh -s -- \
  --vaults-root ~/.anything-obsidian/vaults --url <anythingllm-url> --api-key <key>
anything-obsidian status --json   # exit 0 + "ok": true == done
```

Collect the AnythingLLM URL and API key from the user (Settings → Developer
API). Never invent a key. Verify with `status --json` after every change.

The installer registers per-user auto-start services by default (macOS
LaunchAgents, Linux systemd user units): `anything-obsidian autostart
on|off|status` controls them. While autostart is on, `stop` unloads the
services until the next login/reboot — tell the user that, and use
`autostart off` for a permanent stop. Headless Linux servers need
`sudo loginctl enable-linger <user>` once for services to run without a
login session.

## Repo conventions

- Pure Node ESM (`type: module`) with a minimal dependency set (the MCP SDK
  and zod, installed by `install.sh`); reach for `node:` builtins and the
  global `fetch` first, and think twice before adding anything else.
- Tests: `npm test` runs `node --test` over `mcp/ dashboard/ lib/ scripts/
  bin/` (the MCP server is plain JS now).
- Network boundaries: dashboard and local MCP bind `127.0.0.1` only (21400 /
  21433); the LAN MCP (21444) is opt-in, RAG-only, and token-gated. Secrets
  never appear in API responses or logs (`redactSecretsText` /
  `redactSecretsObject`).
- Vault locations come in two flavours, and the registry records which:
  `managed` entries live beneath `VAULTS_ROOT` and must be direct children of
  it — anyobs owns that area; `imported` entries store an absolute
  `importPath` to a directory the user already owns, never auto-sync unless
  they ask, and that directory is the boundary every raw-file tool anchors
  its traversal checks to. Never collapse the two: a managed resolve must not
  accept an absolute path, and an imported resolve must not be re-joined onto
  the root.
- Removing a vault from management never deletes its repository, workspace,
  or the user's files — preserve this rule everywhere, including scripts.

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
