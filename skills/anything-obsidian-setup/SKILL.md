---
name: anything-obsidian-setup
description: Install, configure, verify, update, stop, restart, or remove Anything Obsidian on a user's macOS or Linux machine using its native installer and unified service commands.
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

Client and gateway are separate roles that may coexist on one machine:

- Client: collect its gateway URL and administrator-issued user token. Members
  can index their own vaults; readers can search. For a solo deployment the user
  may supply a direct AnythingLLM URL and developer API key instead.
- Gateway: collect the external AnythingLLM URL and developer API key from
  Settings → Developer API. Its key belongs only on the server.

Never invent credentials or send them anywhere except the configured upstream.
Propose `~/.anything-obsidian/vaults` for managed vaults. Existing note directories
are imported later; do not move them into the managed root. Avoid Documents and
Desktop defaults on macOS because of repeated permission prompts.

## Install and configure

For a client, supply the collected values to avoid prompts:

```sh
curl -fsSL https://raw.githubusercontent.com/Lettucech/anything-obsidian/main/install.sh | sh -s -- \
  --vaults-root <absolute-path> --url <gateway-url> --api-key <user-token> --no-browser
```

For a gateway use `install.sh --server --url <anythingllm-url> --api-key <key>`
(or the `install-server.sh` wrapper). Interactive users can omit the values.
Git is required; the installer downloads a supported Node runtime if necessary.
It stages dependencies and validates the app before installation.

For an existing app, configure with `anything-obsidian setup` or `setup --server`.
`--url`, `--api-key`, `--vaults-root`, `--port` and server `--admin-port` avoid
prompts. Setup validates the credential before saving it, records the role,
starts its services and checks readiness. Client setup never overwrites gateway
credentials. Reconfiguration keeps the existing autostart preference.

A new installation enables autostart. macOS starts after the user logs in.
Linux gateways require `loginctl enable-linger <user>` for boot without login;
the OS may require administrator authorization. Follow the reported remedy and
recheck. Never describe after-login startup as pre-login boot availability.

## Verify completion

Run after installation and every operational change:

```sh
anything-obsidian status --json
```

Require exit code 0 and `ok:true`. Inspect:

- `configRoot` and `roles`: the intended absolute data root and installed roles.
- `services`: every required service running and each HTTP endpoint healthy.
- `autostart`: preference, actual registration and startup guarantee; a Linux
  gateway must report `at-boot` when autostart is enabled.
- `indexing`: failed jobs or pending cleanup require attention even when the
  service processes are running. A fresh source may be pending its first job.

Do not claim reboot or live embedding-provider verification unless performed.

## Operate and recover

- `start`: all configured services, backgrounded through the OS supervisor;
  repeated calls leave healthy services running.
- `stop`: stop now, preserving startup preference.
- `restart`: restart configured services and verify readiness.
- `logs [service] --follow`: redacted logs; service names are dashboard,
  scheduler, mcp, mcp-lan and gateway. `any-obs` is a short form of the same CLI.
- `autostart on|off|status`: startup preference only; it does not stop running
  services. To stop permanently, use `autostart off` followed by `stop`.
- `lan on --allowed-hosts <hostnames-or-IPs>`: optional token-gated LAN RAG MCP;
  the token and allowed hosts persist across restarts. Save newly generated
  tokens when shown once. Local management tools are never exposed over LAN.

The client dashboard defaults to localhost:21502; gateway administration to
localhost:21505 on the server (use an SSH tunnel remotely). Gateway Operations
shows persistent jobs, progress, logs, cancellation and retry. Refresh changed
is incremental; Rebuild all bypasses the local file-hash cache and verifies
remote documents. Interrupted jobs remain visible after restart. Failed removal
keeps a disabled source pending cleanup; retry the cleanup, never delete notes.

Use `anything-obsidian update` for staged validation, activation, readiness checks
and rollback. This breaking release removes `init`, `start-bg`, `--bg`, and the
separate gateway start/stop command. Existing installations need setup to record
their roles; preserve their registry, data and source files.

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
