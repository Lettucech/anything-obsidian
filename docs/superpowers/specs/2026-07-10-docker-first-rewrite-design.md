# Docker-first Rewrite Design

## Summary

Rewrite `anything-obsidian` around the simplest human setup path:

```bash
git clone https://github.com/pingkiuho/anything-obsidian.git
git clone <your-vault-repo> vault
cd anything-obsidian
cp .env.example .env
docker compose up -d
```

The rewrite keeps server-like components in Docker. Humans should only need to clone their Obsidian vault, edit `.env`, and use Docker Compose. The project should stop optimizing around installer layers and instead make the Docker path direct, inspectable, and reliable.

On first run, `ANYTHINGLLM_API_KEY` may be empty because the user has not finished AnythingLLM setup yet. `docker compose up -d` must still be useful in that state: AnythingLLM should start, and MCP should either run in a degraded "missing API key" state or fail with an obvious diagnostic. A missing API key must not make the whole setup path feel broken.

## Goals

- Use one root `docker-compose.yml` as the main runtime entrypoint.
- Keep AnythingLLM, MCP, and background automation inside Docker.
- Keep `.env` as the user-facing setup contract.
- Use clear Docker names prefixed with `anything-obsidian`.
- Make manual sync/embed commands reliable before reintroducing optional auto polling.
- Preserve the invariant: Git is the source of truth; AnythingLLM is a derived local index.
- Leave room for future graph search without including it in this rewrite.

## Non-goals

- Do not implement Obsidian graph search in this rewrite.
- Do not add Ollama summarization or reranking.
- Do not require a Go installer or TUI.
- Do not require a host-side Node CLI for the core setup path.
- Do not make auto polling required for a successful setup.
- Do not split components just for naming aesthetics.

## Runtime Shape

The root Compose file owns the runtime.

Recommended services:

- `anythingllm`: runs the AnythingLLM server.
- `mcp`: exposes AnythingLLM to coding agents through MCP.
- `worker`: runs background and one-shot project jobs, including vault sync and embedding.

The Compose service name may stay short for command ergonomics, but container names must be explicit:

```yaml
services:
  anythingllm:
    container_name: anything-obsidian-anythingllm

  mcp:
    container_name: anything-obsidian-mcp

  worker:
    container_name: anything-obsidian-worker
```

`worker` is acceptable when it is prefixed in Docker-visible names. The docs must explain that `anything-obsidian-worker` is responsible for vault sync, embedding, and future graph indexing jobs.

`worker` should not be started as a long-running service by plain `docker compose up -d` in the first rewrite. Prefer a Compose profile such as `tools` so one-shot commands remain available through `docker compose run --rm worker ...` without introducing another always-on process.

## User Setup Flow

The primary setup path is Docker-first:

1. Clone this tooling repo.
2. Clone or create the Obsidian vault repo.
3. Copy `.env.example` to `.env`.
4. Set `HOST_VAULT_PATH`.
5. Start the stack with Docker Compose.
6. Finish AnythingLLM first-run setup and create an API key.
7. Put the API key in `.env`.
8. Re-run or recreate the Docker services that consume the API key.
9. Run an explicit embed command.
10. Connect coding agents to MCP.

The README should present this flow as the main path. Scripts may exist as convenience wrappers, but the documented source of truth is Docker Compose.

## Commands

The rewrite should make these commands work from the repo root:

```bash
docker compose up -d
docker compose ps
docker compose logs -f
docker compose run --rm worker embed --all
docker compose run --rm worker sync
docker compose run --rm worker doctor
docker compose down
```

`docker compose up -d` should start long-running server services. One-shot jobs should be invoked with `docker compose run --rm worker <command>`. The first-run docs should show the API-key refresh step explicitly, for example:

```bash
docker compose up -d
# create AnythingLLM API key and put it in .env
docker compose up -d --force-recreate mcp
docker compose run --rm worker embed --all
```

## Environment Surface

`.env.example` should expose only settings a user actually configures:

```bash
ANYTHINGLLM_API_KEY=
ANYTHINGLLM_WORKSPACE_SLUG=obsidian

HOST_VAULT_PATH=/Users/you/Documents/vault
HOST_ANYTHINGLLM_PORT=11301
HOST_MCP_PORT=11333

KB_GIT_REMOTE=origin
KB_GIT_BRANCH=main
KB_GIT_AUTO_PULL=true
KB_GIT_AUTO_PUSH=true
KB_GIT_USER_NAME=anything-obsidian
KB_GIT_USER_EMAIL=anything-obsidian@local
KB_GIT_PUSH_URL=
```

Container-internal paths and service URLs should stay inside Compose. `/vault` remains container wiring, not a user setting.

## Sync And Embedding

The first rewrite pass should prioritize explicit commands over always-on polling:

- `worker sync` performs Git pull, add, commit, push, and then embedding when push succeeds.
- `worker embed` uploads changed vault documents to AnythingLLM.
- `worker embed --all` repairs or initializes the full index.
- `worker doctor` checks Docker-visible config, vault mount, AnythingLLM reachability, API key validity, workspace access, and MCP health.

Auto polling can return later as an optional `worker watch` mode. It must not be required for the main setup path and should not be documented as the primary reliability mechanism.

## MCP

MCP stays Dockerized. The `mcp` service should:

- use the repo root `.env`;
- connect to AnythingLLM over the Compose network;
- expose HTTP MCP at `http://localhost:${HOST_MCP_PORT}/mcp`;
- expose a health endpoint;
- make missing API key status obvious during first-run setup;
- keep `anythingllm_vector_search` as the default agent retrieval path.

Future graph-aware tools can be added after the rewrite stabilizes.

## Files To Remove Or Retire

The implementation plan should evaluate removing or retiring:

- `installer/`
- `install.sh`
- split Compose files under `docker/anythingllm/` and `docker/mcp/`
- `docker/automation/Dockerfile` if replaced by a unified worker image
- complex `scripts/kb` flows that duplicate Compose documentation

The rewrite should avoid deleting useful logic blindly. Existing embed and MCP code can be moved or simplified if it fits the new shape.

## Testing And Verification

The rewrite is done only when these checks pass:

- `docker compose config`
- `docker compose up -d anythingllm`
- `docker compose up -d mcp`
- `docker compose run --rm worker doctor`
- `docker compose run --rm worker embed --all` against a small test vault
- MCP health endpoint returns OK
- direct vector search can find a smoke-test note
- `git diff --check`

If full Docker runtime verification is not possible in the environment, the implementation result must clearly say which checks were not run.

## Open Decisions

- Whether `worker` should be long-running by default or only run one-shot commands until `watch` is explicitly enabled.
- Whether convenience scripts should remain after the README is rewritten around Docker Compose.
- Whether `KB_GIT_PUSH_URL` remains the recommended private Git authentication path for containerized sync.
