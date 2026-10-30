# Docker client and gateway flavor

User scope: optional Docker deployment for both roles, accepting loss of local
directory import. This supersedes the previous native-only product constraint;
native services and their import behavior remain supported.

## Decisions

- One Node image, two Compose services, separate named volumes. No bundled or
  lifecycle-managed AnythingLLM. No host note directories or Docker socket.
- Compose owns restart, stop, recreation and image updates. The container runtime
  runs the existing foreground service entry points, drains siblings after a
  failure, and exits for Docker to restart the role. Scheduler pause is the only
  in-app service control. Native systemd/launchd never runs inside the image.
- Read-only root, non-root UID 1000, capability drop, no-new-privileges and bounded
  temporary storage. Data and cloned notes persist under `/data`.
- Host dashboard ports publish on loopback. Container-network reach no longer
  grants admin authority: separate generated dashboard token, signed eight-hour
  browser session and existing host/origin checks. Container client MCP requires
  an administrator or scoped agent Bearer token. Gateway user-token IAM remains.
- Local import/browsing and directory sources are disabled at UI and backend
  boundaries. Git sources require HTTP(S) URLs; native behavior stays unchanged.
- No automatic image publishing or deployment. No automatic native data migration.
  Backups include volumes and any unpushed changes in cloned note repositories.

## Verification

Focused contracts: authentication/session expiry/origin checks, import and Git
URL restrictions, isolated setup without an OS supervisor, scheduler pause/resume
and sibling shutdown. Full native regression suite, Compose config, real image
build and disposable-container integration using a fake AnythingLLM/Git origin.
The integration covers both roles, Git clone/indexing, denied unauthenticated
admin/MCP and import, restart and recreation persistence. Browser-check both
dashboards and source forms. Remote CI, actual OS reboot and live provider
behavior remain separately verifiable deployment checks.

Completed locally:

- Node 22.14.0 and Node 26: 284 tests passed on each, no failures or skips.
- Real Docker image build and both-profile Compose validation passed.
- Disposable containers: client through gateway IAM, Git clone/indexing on both
  roles, authenticated MCP management, import absent from its tool schema,
  unauthenticated admin/MCP rejected (401), directory import rejected (403),
  restart/recreation persistence, and Docker restart after a wrapper SIGKILL.
- Browser: separate client/gateway logins coexist, client reports 4/4 healthy,
  scheduler pause/resume works, and both source forms expose Git-only operation.
- CI defines image build and the same disposable smoke test on Linux. It has not
  run remotely in this session. No actual OS reboot or live provider was tested.

Only uniquely named disposable test containers, volumes and network were used;
the machine's native installation and real vaults were not changed.
