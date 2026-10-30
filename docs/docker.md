# Docker flavor

Client and gateway can each run in Docker. Choose this when you want their Git
working copies and runtime isolated from host directories. Native installation
remains available and supports importing existing local vaults.

Docker supports Git clone, optional sync, indexing/rebuilds, dashboards and MCP.
It deliberately disables importing local directories and gateway `dir` sources
in both UI and backend. Do not mount host notes, native data roots or the Docker
socket. AnythingLLM remains an external dependency that you operate separately.

## First setup

Install Docker Engine with Compose, or Docker Desktop. Clone this repository and
run these commands from its root. No image is published automatically; build the
checked-out revision locally:

```sh
git clone https://github.com/Lettucech/anything-obsidian.git
cd anything-obsidian
docker compose build client
```

The same image runs either role. Select the service you need; each has its own
named volume. You can run both on one host. Native and Docker services may also
coexist if their published host ports differ.

For a **client**, collect a gateway URL and its administrator-issued user token
(or a direct AnythingLLM URL and developer key for solo use):

```sh
docker compose run --rm client setup
docker compose up -d client
docker compose exec client anything-obsidian status --json
```

For a **gateway**, collect the external AnythingLLM URL and developer API key:

```sh
docker compose run --rm gateway setup
docker compose up -d gateway
docker compose exec gateway anything-obsidian status --json
```

Setup prompts for the URL and hides credential input. It verifies the connection
before saving it and exits without starting native services. Noninteractive
setup accepts `--url <url> --api-key <token>`; protect shell history when passing
secrets this way. Client vaults always live under `/data/vaults`.

`localhost` inside a container means that container. Use a reachable upstream
address. For another service in this Compose project, use `http://gateway:21500`.
For an upstream on the Docker host, use `http://host.docker.internal:<port>`;
the upstream must listen on an interface reachable from Docker. A host-loopback
only service may require separate networking configuration, especially on Linux.
Use a remote HTTPS endpoint when appropriate; this flavor does not change or
expose your AnythingLLM deployment.

## Dashboard login and MCP

Client dashboard: <http://localhost:21502>. Gateway admin: <http://localhost:21505>.
Docker dashboards require a separate generated admin token, even from localhost.
Retrieve the token for the selected service, then paste it into its login page:

```sh
docker compose exec client cat /data/secrets/container-admin-token
# For the gateway, replace client with gateway.
```

The token is stored with mode 0600 in that service's volume and survives restart
and recreation. It is never printed in startup logs. Login uses an HttpOnly,
SameSite=Strict session that expires after eight hours; the two roles use
separate cookies. Keep dashboard ports bound to host loopback. For remote
administration, use SSH port forwarding to localhost; arbitrary browser hostnames
and cross-origin administration requests are rejected.

Client MCP is <http://localhost:21503/mcp> and always requires a Bearer token in
Docker. Create scoped agent tokens in the client dashboard and assign their
vault access policies. To use the full management profile, retrieve the client
administrator token with this command (different from the dashboard token):

```sh
docker compose exec client node -e 'console.log(JSON.parse(require("fs").readFileSync("/data/config.json")).lanToken)'
```

The gateway public API/MCP remains on port 21500 and uses gateway-issued user
tokens. Only share those user tokens with clients; keep both the gateway admin
token and the upstream developer key on the gateway host.

## Start, stop, restart and update

```sh
docker compose ps
docker compose logs -f client
docker compose restart client
docker compose stop client
docker compose up -d client
```

Replace `client` with `gateway` for gateway operations. Scheduler pause/resume
inside the client dashboard remains available. Container lifecycle, LAN endpoint
configuration and self-update commands defer to Docker; the optional native LAN
endpoint is not used here. Health checks report readiness independently from
historical indexing failures; `status --json` also reports jobs needing attention.
Readiness failures mark the container unhealthy, but Docker does not restart a
process solely because its health check failed. An unexpected child-process exit
drains its siblings and exits the container so Docker can restart the whole role.

Compose sets `restart: unless-stopped`. Enable Docker itself at host boot for
unattended Linux operation. Docker Desktop startup depends on its host settings
and login session. `status` reports lifecycle as managed by Docker; it does not
claim to have verified daemon startup at OS boot. An explicitly stopped service
stays stopped until you start it again. See the [Docker service reference](https://docs.docker.com/reference/compose-file/services/).

For an update, back up the stopped service's named volume and retain the previous
image under a local tag. Then pull the desired Git revision, rebuild and recreate:

```sh
docker compose build --pull client
docker compose up -d --force-recreate client
docker compose exec client anything-obsidian status --json
```

To roll back, select the retained image tag via a Compose override and recreate
against the same volume. Image updates do not run the native app updater and do
not automatically roll back. Check release notes for data-format changes.

To reconfigure, stop the selected service, run its `setup` command again, then
start it. Setup refuses to change a running volume. Do not attach native data
volumes: imported directories and native paths are deliberately unsupported.

## Storage and network boundary

The image runs as UID/GID 1000, with a read-only root filesystem, no Linux
capabilities, no-new-privileges, and a bounded temporary filesystem. App data,
config, credentials, cloned notes, manifests and job history live in `/data`.
Compose creates separate `client-data` and `gateway-data` named volumes, prefixed
by the Compose project name. Removing a container preserves those volumes.
**Do not run `docker compose down -v` unless you intend to delete all their data,
including cloned vault contents.** Back up volumes and unpushed note changes.

Published ports default to `127.0.0.1`. To share the gateway's token-protected
public plane on the LAN, put `GATEWAY_BIND=0.0.0.0` in a local `.env` file and
recreate the gateway. Admin/dashboard ports remain host-loopback. Host port
overrides are `GATEWAY_PORT`, `GATEWAY_ADMIN_PORT`, `CLIENT_DASHBOARD_PORT` and
`CLIENT_MCP_PORT`; internal ports stay fixed. See [Docker port publishing](https://docs.docker.com/engine/network/port-publishing/).

Docker isolates the host filesystem; it is not a network egress firewall or a
virtual machine. The app still needs outbound HTTP(S) access to Git and upstream
services. Compose does not bundle, start or manage AnythingLLM.

## Development verification

```sh
npm test
docker compose --profile client --profile gateway config -q
docker compose build client
node docker/smoke.mjs anything-obsidian:local
```

The smoke check creates uniquely named temporary containers, volumes and a
network, uses a fake AnythingLLM/Git origin, and removes only those test resources.
It checks both roles, real Git cloning/indexing, denied import and unauthenticated
access, non-root operation, and persistence across restart and recreation.
This does not prove a live embedding provider or OS-reboot behavior.
