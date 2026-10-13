# AGENTS.md

Guidance for AI agents working in this repository, or helping a user install
and operate Anything Obsidian on their machine.

## What this project is

Anything Obsidian is a local control plane connecting Git-backed Obsidian
vaults with AnythingLLM RAG indexes. Two forms coexist:

- **Native (primary):** plain Node app, installed by `install.sh`, managed by
  the `anything-obsidian` CLI and a browser dashboard on port 11400.
  AnythingLLM is always an external client-side dependency (URL + API key in
  config) — the app never hosts it.
- **Docker (legacy/parallel):** `docker compose up -d`, dashboard on 11300.
  Keep this path working; never break Docker-mode behavior.

There is no Electron/desktop-shell plan and no npm publish — distribution is
`install.sh` from this repo.

## Helping a user install and set up

Use the `skills/anything-obsidian-setup/SKILL.md` playbook. Short version:

```sh
curl -fsSL https://raw.githubusercontent.com/Lettucech/anything-obsidian/main/install.sh | sh -s -- \
  --vaults-root ~/ObsidianVaults --url <anythingllm-url> --api-key <key>
anything-obsidian status --json   # exit 0 + "ok": true == done
```

Collect the AnythingLLM URL and API key from the user (Settings → Developer
API). Never invent a key. Verify with `status --json` after every change.

## Repo conventions

- Pure Node ESM (`type: module`), **zero runtime dependencies** — do not add
  packages; use `node:` builtins and the global `fetch`.
- Tests: `npm test` runs `node --test` over `dashboard/ lib/ scripts/ bin/`.
  The TS files under `mcp/anythingllm/` have their own toolchain (`tsx`) and
  are NOT covered by the root suite — never "fix" them by running the root
  test runner.
- Native-mode boundaries: dashboard binds `127.0.0.1` only; Docker keeps
  `0.0.0.0:11300`. Vault registry entries must be direct children of
  `VAULTS_ROOT`. Secrets never appear in API responses or logs
  (`redactSecretsText` / `redactSecretsObject`).
- Removing a vault from management never deletes its repository, workspace,
  or the user's files — preserve this rule everywhere, including scripts.

## Data directories (never delete casually)

- App + portable runtime: `~/.anything-obsidian/`
- Data (config.json 0600, secrets/, registry/, agent-tokens/, state/, logs/,
  run/ PID files): `~/Library/Application Support/anything-obsidian/`
  (override with `ANYTHING_OBSIDIAN_HOME`)
- User vaults: the configured vaults root (default `~/ObsidianVaults`) —
  these are the user's actual notes.

`uninstall.sh` already follows the safe-by-default rules; do not "improve"
it into deleting user data implicitly.
