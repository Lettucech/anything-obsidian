---
name: anything-obsidian-setup
description: Install, configure, verify, update, stop, restart, or remove Anything Obsidian using its native installer or optional Docker client/gateway flavor.
---

# Anything Obsidian Setup

## When to Use

Use when the user wants an installation, machine configuration, service health
check, update, restart, or uninstall. The user supplies their connection details;
resolve the CLI, platform and current state on the target machine.

## Do Not Use When

For ordinary vault registration, sync policy or indexing, use the dashboard or
local MCP management tools. For searching/verifying/editing notes, use the
`anything-obsidian-vault-workflow` skill and the vault's own rules.

## Boundaries

Anything Obsidian is a native Node bridge. AnythingLLM is an external dependency
that its operator provides; never start or manage AnythingLLM on their behalf
as an implicit part of this setup. No Docker or desktop shell is required for
the bridge. Source directories are the user's notes and must be preserved.

One install, one process, one dashboard. A single app service hosts the
dashboard (21502), local MCP (21503) and sync scheduler; the gateway and the
LAN MCP are opt-in in-process listeners. Interactive `setup` opens with an
arrow-key choice of mode — the two credential kinds are never merged into
one question:

- **Local** (default, gateway feature off): the AnythingLLM URL and its
  developer API key.
- **Join a gateway**: the gateway URL (`http://<server>:21500`) and the
  administrator-issued user token. Members can index their own vaults;
  readers can search.
- **Serving others**: local setup plus the gateway feature
  (`anything-obsidian gateway on`, or `install.sh --server`). Collect the
  external AnythingLLM URL and developer API key from Settings → Developer
  API; it is stored in `gateway/gateway.json` and belongs only on that
  machine.

Never invent credentials or send them anywhere except the configured upstream.
Propose `~/.anything-obsidian/vaults` for managed vaults. Existing note directories
are imported later; do not move them into the managed root. Avoid Documents and
Desktop defaults on macOS because of repeated permission prompts.

## Install and configure

For Docker, follow [the Docker playbook](../../docs/docker.md): build the image,
run `docker compose run --rm client setup` (or `gateway setup`), then
`docker compose up -d client` (or `gateway`). Verify with
`docker compose exec <service> anything-obsidian status --json`. Retrieve the
separate dashboard admin token from that service's `/data/secrets/container-admin-token`;
never log it or confuse it with a gateway user/upstream token. Docker supports
Git clones only: never mount host notes, native data directories or the Docker
socket, and never offer local-directory import. Lifecycle, daemon startup and
image updates belong to Docker; do not invoke native autostart or updater commands
inside a container. `managed-by-docker` is not proof that Docker starts at OS boot.
The Docker flavor keeps the one-role-per-container model and has not migrated to
the merged native process. The rest of this playbook describes native installation.

Supply the collected values to avoid prompts:

```sh
curl -fsSL https://raw.githubusercontent.com/Lettucech/anything-obsidian/main/install.sh | sh -s -- \
  --vaults-root <absolute-path> --url <url> --api-key <key> --no-browser
# add --server to also enable the gateway feature (alias: install-server.sh)
```

Interactive users can omit the values. Git is required; the installer downloads
a supported Node runtime if necessary. It stages dependencies and validates the
app before installation.

For an existing app, configure with `anything-obsidian setup` and toggle the
gateway with `anything-obsidian gateway on|off|status`.
`--url`, `--api-key`, `--vaults-root` and `--port` avoid prompts. Setup
validates the credential before saving it, records the role, starts the app
service and checks readiness. Reconfiguration keeps the existing autostart
preference. Toggling the gateway or LAN never restarts the service: listeners
open and close in-process.

A new installation enables autostart. macOS starts after the user logs in.
Linux requires `loginctl enable-linger <user>` for boot without login;
the OS may require administrator authorization. Follow the reported remedy and
recheck. Never describe after-login startup as pre-login boot availability.

## Verify completion

Run after installation and every operational change:

```sh
anything-obsidian status --json
```

Require exit code 0 and `ok:true`. Inspect:

- `configRoot` and `roles`: the intended absolute data root and roles
  (gateway enabled ⇔ `roles` contains `"gateway"`).
- `services`: the app service running and each HTTP endpoint healthy
  (gateway public plane only when the feature is enabled).
- `autostart`: preference, actual registration and startup guarantee; Linux
  must report `at-boot` when autostart is enabled and linger is set.
- `indexing`: failed jobs or pending cleanup require attention even when the
  service processes are running. A fresh source may be pending its first job.

Do not claim reboot or live embedding-provider verification unless performed.

## Operate and recover

- `start`: the app service, backgrounded through the OS supervisor;
  repeated calls leave a healthy service running.
- `stop`: stop now, preserving startup preference.
- `restart`: restart the app service and verify readiness.
- `logs [app] --follow`: redacted logs; pre-merge names (dashboard, scheduler,
  mcp, mcp-lan, gateway) still resolve to their old log files. `any-obs` is a
  short form of the same CLI.
- `autostart on|off|status`: startup preference only; it does not stop running
  services. To stop permanently, use `autostart off` followed by `stop`.
- `gateway on|off|status`: the opt-in gateway feature; when the app is
  running the toggle applies immediately, otherwise at the next start.
- `lan on --allowed-hosts <hostnames-or-IPs>`: optional token-gated LAN RAG MCP;
  the token and allowed hosts persist across restarts. Save newly generated
  tokens when shown once. Local management tools are never exposed over LAN.

The dashboard defaults to localhost:21502 and includes the gateway console at
`/gateway/` when the feature is enabled (use an SSH tunnel remotely). Gateway
Operations shows persistent jobs, progress, logs, cancellation and retry.
Refresh changed is incremental; Rebuild all bypasses the local file-hash cache
and verifies remote documents. Interrupted jobs remain visible after restart.
Failed removal keeps a disabled source pending cleanup; retry the cleanup,
never delete notes.

Use `anything-obsidian update` for staged validation, activation, readiness checks
and rollback. The first `start` after this upgrade migrates automatically:
legacy per-role service definitions are removed, and a gateway-only install
gains a `config.json` synthesized from `gateway.json` (the gateway stays
enabled). Preserve registries, data and source files.

The installer pins the data root in the launcher and each service definition.
Configuration defaults to the OS app-support/config directory; the override is
`ANYTHING_OBSIDIAN_HOME`. Do not edit installation state to imitate a successful
setup or discard manifests as a repair shortcut. If the supported controls do
not recover the installation, report the relevant redacted error and limitation.

## Uninstall

```sh
curl -fsSL https://raw.githubusercontent.com/Lettucech/anything-obsidian/main/uninstall.sh | sh -s -- --yes
```

This keeps data and vault directories. `--purge-data` is a separate destructive
request: obtain explicit user authorization before using it. Always report the
retained vault location. Never delete source directories implicitly.

Agent-skill installation is opt-in: use `npx skills add Lettucech/anything-obsidian
--skill <name>` when requested; do not hand-copy installed skills.
