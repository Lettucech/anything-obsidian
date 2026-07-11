# Dashboard Control Plane Design

## Summary

Add a lightweight web dashboard to `anything-obsidian` so daily operation can move out of the terminal after the user runs:

```bash
docker compose up -d
```

The dashboard is the always-on control plane. It stays running when the user turns the rest of the system off. The heavier project services, `anythingllm`, `mcp`, and `syncer`, become controlled services that can be started, stopped, inspected, and repaired from the UI.

The first version is intentionally operational, not a setup wizard or full admin platform. It should cover status, logs, manual maintenance actions, and system on/off. It should not edit secrets, delete volumes, mutate the Obsidian vault directly, or expose a broad Docker control surface.

## Goals

- Start a dashboard service by default with `docker compose up -d`.
- Keep the Docker-first human setup path: clone repos, edit `.env`, then run Compose.
- Let the user turn the project system on and off from the dashboard while leaving the dashboard running.
- Turn the current daily command surface into UI actions:
  - view service status;
  - view recent logs;
  - run `sync`;
  - run `embed`;
  - run `embed --all`;
  - run `doctor`.
- Preserve the invariant: Git is the source of truth; AnythingLLM is a derived local index.
- Keep runtime state in Docker volumes and the Obsidian vault as a host-mounted Git repo.
- Make failure states clear enough that the user can recover without remembering CLI commands.

## Non-goals

- Do not build a first-run setup wizard in this version.
- Do not edit `.env` from the dashboard in this version.
- Do not store or display `ANYTHINGLLM_API_KEY` or `KB_GIT_AUTH_TOKEN`.
- Do not expose arbitrary Docker commands.
- Do not manage unrelated containers outside this Compose project.
- Do not delete Docker volumes or clean runtime storage from the normal off flow.
- Do not change the vault Git remote, branch, or auth model.
- Do not make the dashboard a replacement for AnythingLLM's own UI.

## Runtime Shape

Add a new default Compose service:

```yaml
dashboard:
  container_name: anything-obsidian-dashboard
```

The default service graph becomes:

- `anything-obsidian-dashboard`: lightweight web UI and API, always intended to remain running.
- `anything-obsidian-anythingllm`: AnythingLLM server.
- `anything-obsidian-mcp`: HTTP MCP server.
- `anything-obsidian-syncer`: default background sync and embed loop.
- `anything-obsidian-worker`: profile-gated one-shot worker image for maintenance jobs.

The dashboard should expose a host port such as:

```env
HOST_DASHBOARD_PORT=11300
```

The Compose port should bind to localhost by default:

```yaml
ports:
  - "127.0.0.1:${HOST_DASHBOARD_PORT:-11300}:3000"
```

The dashboard needs controlled access to Docker so it can inspect and start or stop the project containers. The recommended first implementation mounts the Docker socket:

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```

Because Docker socket access is powerful, the dashboard API must only allow fixed project operations against fixed project container names. It must not accept arbitrary container names, images, commands, bind mounts, or shell input from the browser.

## System On And Off

The dashboard has a single top-level system power control.

When the user turns the system off, the dashboard stops only:

- `anything-obsidian-anythingllm`
- `anything-obsidian-mcp`
- `anything-obsidian-syncer`

It does not stop:

- `anything-obsidian-dashboard`

It does not remove:

- the AnythingLLM storage volume;
- the worker state volume;
- the Obsidian vault mount;
- any Git data;
- any Docker images.

When the user turns the system on, the dashboard starts the same controlled services again. If a controlled container does not exist yet, the UI should report that the stack needs to be recreated with Compose instead of trying to invent a new Compose deployment from the dashboard.

The dashboard should treat the system as:

- `on` when all controlled services are running;
- `off` when all controlled services are stopped or absent;
- `partial` when some controlled services are running and others are not;
- `error` when Docker cannot be reached or a required operation fails.

The UI may offer a repair action from the `partial` state that starts all controlled services.

## Status

The dashboard should display a compact status view for:

- Dashboard API reachability.
- AnythingLLM container state and, when running, `/api/docs` reachability.
- MCP container state and, when running, MCP health reachability.
- Syncer container state and recent autosync activity.
- Worker job history for dashboard-triggered one-shot actions.

Status should distinguish container state from service health. A container can be running while the service inside is still booting or misconfigured.

The dashboard should redact secrets in all displayed config and logs. At minimum, values for these keys must never be rendered:

- `ANYTHINGLLM_API_KEY`
- `KB_GIT_AUTH_TOKEN`
- `GIT_PASSWORD`

## Manual Actions

The dashboard should expose fixed maintenance actions:

- `Sync now`: equivalent to `worker sync`.
- `Embed changed`: equivalent to `worker embed`.
- `Rebuild index`: equivalent to `worker embed --all`.
- `Run doctor`: equivalent to `worker doctor`.

Each action creates a one-shot worker job and streams or polls its result. The job output should keep the existing split:

- machine-readable JSON result is preserved for the dashboard API;
- human-readable progress logs remain visible in the UI.

The dashboard should prevent duplicate conflicting jobs. For the first version, run at most one manual worker job at a time. If a job is active, additional action buttons should be disabled with a clear busy state.

Manual worker actions should not require the syncer to be running. This lets a user keep the system mostly off, start a repair action intentionally, and then return to off.

Manual worker actions have service preconditions:

- `Run doctor` can run while the controlled system is off and should report stopped or unreachable services clearly.
- `Sync now`, `Embed changed`, and `Rebuild index` require AnythingLLM to be running because the current worker command surface embeds through AnythingLLM.
- If a user requests an action that requires AnythingLLM while the system is off, the UI should offer to turn the system on first instead of starting a worker job that is expected to fail.

## Logs

The dashboard should show recent logs for:

- `syncer`
- `mcp`
- `anythingllm`
- dashboard-triggered worker jobs

The first version can use bounded recent logs rather than a permanent log database. A reasonable default is the latest 200 to 500 lines per source.

The UI should make the existing worker prefix useful:

```text
[anything-obsidian-worker]
```

The log view should be readable enough for ordinary operations: last sync, push result, embed skipped or completed, and errors.

## API Shape

The dashboard backend should expose a narrow project API:

- `GET /api/status`
- `POST /api/system/on`
- `POST /api/system/off`
- `GET /api/logs?service=syncer`
- `POST /api/actions/sync`
- `POST /api/actions/embed`
- `POST /api/actions/embed-all`
- `POST /api/actions/doctor`
- `GET /api/actions/:id`

The API should implement allowlists internally:

- allowed service ids: `anythingllm`, `mcp`, `syncer`;
- allowed log service ids: `anythingllm`, `mcp`, `syncer`, dashboard worker action ids;
- allowed worker commands: `sync`, `embed`, `embed --all`, `doctor`.

The browser must never submit raw Docker arguments.

## UI Shape

The first screen should be the operational dashboard, not a landing page.

Recommended layout:

- Top bar with system state, power toggle, and links to AnythingLLM and MCP endpoint.
- Status row for AnythingLLM, MCP, syncer, and last worker action.
- Action toolbar with `Sync now`, `Embed changed`, `Rebuild index`, and `Run doctor`.
- Main activity area with recent syncer logs and current or recent action output.
- Compact configuration summary showing non-secret values such as host ports, workspace slug, Git remote, Git branch, and sync interval.

The visual style should be quiet and utilitarian. This is an operations tool for repeated use, so dense, scannable status is more important than a marketing-style hero.

## Error Handling

The dashboard should make these cases explicit:

- Docker socket is unavailable.
- A controlled container is missing.
- A controlled container failed to start.
- AnythingLLM is running but not reachable yet.
- MCP is running but missing or rejecting the API key.
- A worker job failed.
- A worker job is already running.
- The system is partially on.

For missing containers, the UI should tell the user to run `docker compose up -d` from the tooling repo. The dashboard should not try to reconstruct the full Compose project from scratch.

## Security

Mounting the Docker socket gives the dashboard privileged local control. The first version mitigates this by:

- binding the dashboard host port to `127.0.0.1`;
- exposing only fixed project actions;
- using hardcoded allowlists for services and worker commands;
- rejecting arbitrary command, image, path, and container-name input;
- redacting secrets before sending text to the browser;
- avoiding `.env` edits from the UI.

This is acceptable for a local personal knowledge-base stack. It should be documented honestly in the README so users understand that the dashboard can control this Docker project.

## Testing And Verification

The implementation is done only when these checks pass:

- dashboard backend unit tests for service allowlists and rejected arbitrary input;
- dashboard backend tests for system state classification;
- dashboard backend tests for secret redaction;
- worker action tests showing only fixed commands can run;
- UI smoke test for on, off, partial, busy, and failed states;
- `docker compose config`;
- `docker compose up -d dashboard`;
- dashboard status endpoint returns OK when controlled services are stopped;
- dashboard can start and stop the controlled services without stopping itself;
- dashboard can trigger `doctor` and display the result;
- `git diff --check`.

If Docker runtime verification is not possible in the implementation environment, the result must state exactly which Docker checks were skipped.

## Implementation Decisions

- Implement the dashboard backend as a small Node service. The repo already uses Node for worker logic, env parsing, and AnythingLLM integration, so this keeps shared project conventions close.
- Use the Docker API over the mounted socket for container status, start, stop, and logs. Do not shell out to arbitrary Docker commands from request handlers.
- Create one-shot worker jobs by deriving a fixed job configuration from the existing worker or syncer service shape: same worker image, same project network, same vault mount, same worker state volume, same read-only `.env` mount, and one of the allowlisted worker commands.
- Keep dashboard-triggered action history in memory for the first version. A restart may lose old action history, but the Docker logs remain available.
- Use bounded polling of recent logs for the first version instead of live streaming. Live streaming can be added after the core control path is reliable.
