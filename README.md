# Anything Obsidian

Use Obsidian as a private Markdown vault, sync that vault with any private Git repo you choose, embed changed notes into local AnythingLLM, and expose the knowledge base to code agents through MCP.

The important split:

- `anything-obsidian`: this tooling repo. It contains Docker Compose, the MCP wrapper, and the embedding job.
- `vault`: your Obsidian vault repo. It is your own private Git repo and does not have to be `pingkiuho/anything-obsidian`.

The main setup path uses plain Git and Docker Compose. Helper scripts exist for maintainers, but users do not need them.

## What You Will End Up With

- Obsidian installed on your computer.
- A tooling repo at `/Users/lettucech/Documents/anything-obsidian`.
- A separate Git-backed Obsidian vault at `/Users/lettucech/Documents/vault`.
- Core server: AnythingLLM at `http://localhost:11301`.
- Optional agent layer: MCP server at `http://localhost:11333/mcp`.
- Auto sync service: watches vault changes, waits for an idle window, commits/pushes vault Git changes, then re-embeds changed files into AnythingLLM.
- Optional embed job: a one-shot command for manual full or repair embedding.
- Codex / Claude / Copilot able to query your AnythingLLM workspace via MCP.

AnythingLLM storage, API keys, embedding state, and vector data stay local on each machine. Your vault content lives in your vault Git repo.

## Folder Layout

Recommended local layout:

```text
/Users/lettucech/Documents/
  anything-obsidian/   # this tooling repo
  vault/               # your separate Obsidian vault repo
```

Inside `anything-obsidian`:

- `docker/anythingllm/compose.yml`: core AnythingLLM only.
- `docker/mcp/compose.yml`: optional MCP server, auto sync service, and one-shot `embed` job.
- `mcp/anythingllm/`: MCP wrapper source.
- `scripts/embed-vault.mjs`: vault-to-AnythingLLM embedding job used by Docker.
- `scripts/watch-vault.mjs`: auto sync watcher used by Docker.

The Docker embed job mounts the sibling `vault` folder into the container as `/vault`.

## 1. Install Obsidian

1. Download Obsidian from [obsidian.md](https://obsidian.md/).
2. Install it like a normal desktop app.
3. Do not create the final vault inside Obsidian yet if this is a second computer. You will clone your vault Git repo first, then open that folder as a vault.

You also need:

- [Git](https://git-scm.com/downloads)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- [Node.js LTS](https://nodejs.org/) only if you want local stdio MCP for Claude Desktop or Codex. Docker-only setup does not require Node on the host.

## 2. Clone Tooling Repo And Vault Repo

First clone this tooling repo:

```bash
cd /Users/lettucech/Documents
git clone https://github.com/pingkiuho/anything-obsidian.git anything-obsidian
cd anything-obsidian
```

Then create or clone your actual Obsidian vault as a separate repo.

### New Vault Repo

```bash
cd /Users/lettucech/Documents
mkdir vault
cd vault
git init
git branch -M main
git remote add origin https://github.com/YOUR_ACCOUNT/YOUR_VAULT_REPO.git
```

Open Obsidian, choose **Open folder as vault**, and select `/Users/lettucech/Documents/vault`.

### Existing Vault Repo

```bash
cd /Users/lettucech/Documents
git clone https://github.com/YOUR_ACCOUNT/YOUR_VAULT_REPO.git vault
cd vault
```

Open Obsidian, choose **Open folder as vault**, and select `/Users/lettucech/Documents/vault`.

## 3. Configure `.env`

Create your local env file in the tooling repo:

```bash
cd /Users/lettucech/Documents/anything-obsidian
cp .env.example .env
```

Open `.env` in a text editor. These are the user settings:

```bash
ANYTHINGLLM_API_KEY=
ANYTHINGLLM_WORKSPACE_SLUG=obsidian

HOST_VAULT_PATH=/Users/lettucech/Documents/vault
HOST_ANYTHINGLLM_PORT=11301
HOST_MCP_PORT=11333

KB_GIT_REMOTE=origin
KB_GIT_BRANCH=main
KB_GIT_AUTO_PULL=true
KB_GIT_AUTO_PUSH=true
KB_GIT_USER_NAME=anything-obsidian
KB_GIT_USER_EMAIL=anything-obsidian@local
KB_GIT_PUSH_URL=
KB_WATCH_INTERVAL_SECONDS=300
KB_SYNC_DEBOUNCE_SECONDS=300
```

`HOST_VAULT_PATH` is the host path Docker Compose mounts. Change it if your Obsidian vault is somewhere else.
`HOST_ANYTHINGLLM_PORT` and `HOST_MCP_PORT` are the ports exposed on your computer. Change them if those ports are already in use.
When you change these ports, use the same values in browser URLs, curl commands, and MCP client URLs.

The container path is not a user setting. Compose always mounts the host vault to `/vault` inside the `sync` and `embed` containers.

The recommended layout is still:

```text
/Users/lettucech/Documents/
  anything-obsidian/
  vault/
```

Leave `ANYTHINGLLM_API_KEY` empty for now. You will fill it after starting AnythingLLM and creating an API key.

For private GitHub vault repos, the auto sync container needs a way to push. The simplest local setup is to create a GitHub token and put a push URL in `.env`:

```bash
KB_GIT_PUSH_URL=https://x-access-token:YOUR_TOKEN@github.com/YOUR_ACCOUNT/YOUR_VAULT_REPO.git
```

If `KB_GIT_PUSH_URL` is empty, auto sync uses the vault repo's normal `origin` remote. That works only if the container can authenticate with that remote.

## 4. Start AnythingLLM

Start Docker Desktop, then run the core server from the tooling repo:

```bash
cd /Users/lettucech/Documents/anything-obsidian/docker/anythingllm
docker compose --env-file ../../.env up -d
```

Check the service:

```bash
docker compose --env-file ../../.env ps
```

Open AnythingLLM:

```text
http://localhost:11301
```

If you changed `HOST_ANYTHINGLLM_PORT`, open `http://localhost:<your-port>` instead.

In AnythingLLM:

1. Finish the first-run setup.
2. Create a workspace named `obsidian`.
3. Configure your LLM provider:
   - Ollama: use `http://host.docker.internal:11434` on macOS/Windows.
   - OpenAI-compatible: configure the provider, base URL, API key, and model in the AnythingLLM UI.
4. Configure an embedder model.
5. Create an AnythingLLM API key.
6. Paste the key into `/Users/lettucech/Documents/anything-obsidian/.env`:

```bash
ANYTHINGLLM_API_KEY=your-api-key-here
```

## 5. Optional: Start MCP Server

If you want Codex / Claude / Copilot to query AnythingLLM, start the optional MCP layer after `ANYTHINGLLM_API_KEY` is set:

```bash
cd /Users/lettucech/Documents/anything-obsidian/docker/mcp
docker compose --env-file ../../.env up -d --build mcp
```

Check the MCP service:

```bash
docker compose --env-file ../../.env ps
```

Verify the MCP health endpoint:

```bash
curl --fail --silent --show-error http://localhost:11333/health
```

If you changed `HOST_MCP_PORT`, use that port in the health URL and in your MCP client config.

Expected result:

```json
{"ok":true,"name":"anything-obsidian-mcp"}
```

If you later change `ANYTHINGLLM_API_KEY`, recreate only MCP:

```bash
docker compose --env-file ../../.env up -d --build --force-recreate mcp
```

## 6. Start Auto Sync And Re-embedding

Start the watcher after `ANYTHINGLLM_API_KEY` is set:

```bash
cd /Users/lettucech/Documents/anything-obsidian/docker/mcp
docker compose --env-file ../../.env up -d --build sync
```

Check logs:

```bash
docker compose --env-file ../../.env logs -f sync
```

How it works:

1. The sync service polls `/Users/lettucech/Documents/vault` through the `/vault` container mount every 5 minutes.
2. Any file change starts a 5-minute countdown.
3. Each new file change resets the countdown.
4. After the vault is idle for 5 minutes, it runs:
   - `git pull --rebase --autostash origin main` when `KB_GIT_AUTO_PULL=true`
   - `git add -A`
   - `git commit -m "Auto sync vault <timestamp>"` when there are changes
   - `git push` when `KB_GIT_AUTO_PUSH=true`
   - re-embedding of changed vault files

The default watch interval and debounce are:

```bash
KB_WATCH_INTERVAL_SECONDS=300
KB_SYNC_DEBOUNCE_SECONDS=300
```

Change them in `.env` if you want a shorter test cycle.

## 7. Verify Auto Sync And Re-embedding

Create a test note in Obsidian, inside `/Users/lettucech/Documents/vault`, named `RAG Smoke Test.md` with this content:

```text
anything-obsidian-smoke-test-2026

The local knowledge base auto sync and embedding pipeline is working.
```

Wait for the debounce window. For a quick test, temporarily edit `.env` and set:

```bash
KB_WATCH_INTERVAL_SECONDS=30
KB_SYNC_DEBOUNCE_SECONDS=30
```

Then recreate `sync`, edit the note again, and wait for the next scan plus the idle window:

```bash
cd /Users/lettucech/Documents/anything-obsidian/docker/mcp
docker compose --env-file ../../.env up -d --build --force-recreate sync
```

Expected `sync` logs include:

```text
Change detected; auto sync scheduled after idle window
Idle window reached; starting auto sync
Committed vault changes
Re-embedding complete
```

Verify direct vector search from the tooling repo:

```bash
cd /Users/lettucech/Documents/anything-obsidian
ANYTHINGLLM_PORT="$(grep '^HOST_ANYTHINGLLM_PORT=' .env | cut -d= -f2-)"
curl --fail --silent --show-error \
  -H "Authorization: Bearer $(grep '^ANYTHINGLLM_API_KEY=' .env | cut -d= -f2-)" \
  -H "Content-Type: application/json" \
  -d '{"query":"anything-obsidian-smoke-test-2026","topN":4}' \
  "http://localhost:${ANYTHINGLLM_PORT:-11301}/api/v1/workspace/obsidian/vector-search"
```

You should see results that mention `RAG Smoke Test.md` or the smoke-test phrase. You can also ask inside AnythingLLM:

```text
What does anything-obsidian-smoke-test-2026 say?
```

Manual repair re-embedding is still available:

```bash
cd /Users/lettucech/Documents/anything-obsidian/docker/mcp
docker compose --env-file ../../.env run --rm embed
```

Force re-embedding of all supported vault files:

```bash
docker compose --env-file ../../.env run --rm embed node scripts/embed-vault.mjs --all
```

## 8. Verify Vault Git Sync On Another Computer

On another computer, clone both repos as siblings:

```bash
cd /Users/lettucech/Documents
git clone https://github.com/pingkiuho/anything-obsidian.git anything-obsidian
git clone https://github.com/YOUR_ACCOUNT/YOUR_VAULT_REPO.git vault
```

Then start AnythingLLM from the tooling repo:

```bash
cd /Users/lettucech/Documents/anything-obsidian
cp .env.example .env
cd docker/anythingllm
docker compose --env-file ../../.env up -d
```

Copy or recreate that computer's local `.env` values, especially `ANYTHINGLLM_API_KEY`.

Start auto sync on that computer:

```bash
cd /Users/lettucech/Documents/anything-obsidian/docker/mcp
docker compose --env-file ../../.env up -d --build sync
```

The first computer should have pushed the smoke-test note. Pull manually once to verify the vault repo is connected:

```bash
cd /Users/lettucech/Documents/vault
git pull --rebase --autostash origin main
ls
```

After that, the sync service handles future idle-window commits, pushes, pulls, and re-embedding.

## 9. Connect Codex / Claude / Copilot To MCP

The MCP server exposes these tools:

- `anythingllm_workspaces`
- `anythingllm_query`
- `anythingllm_vector_search`

### Claude Code

This repo includes [.mcp.json](.mcp.json):

```json
{
  "mcpServers": {
    "anything-obsidian": {
      "type": "http",
      "url": "http://localhost:11333/mcp"
    }
  }
}
```

Start Claude Code from `/Users/lettucech/Documents/anything-obsidian` and approve the project MCP server when prompted. You can also add it manually:

If you changed `HOST_MCP_PORT`, edit `.mcp.json` and use that port in the URL.

```bash
claude mcp add --transport http anything-obsidian http://localhost:11333/mcp
```

Then run `/mcp` in Claude Code and check that `anything-obsidian` is connected.

### Claude Desktop

Claude Desktop commonly uses local stdio MCP. Build the local wrapper first:

```bash
cd /Users/lettucech/Documents/anything-obsidian/mcp/anythingllm
npm install
npm run build
```

Open Claude Desktop developer settings and edit `claude_desktop_config.json`. Add:

```json
{
  "mcpServers": {
    "anything-obsidian": {
      "command": "node",
      "args": [
        "/Users/lettucech/Documents/anything-obsidian/mcp/anythingllm/dist/index.js"
      ]
    }
  }
}
```

Restart Claude Desktop after saving the file.

### GitHub Copilot In VS Code

This repo includes [.vscode/mcp.json](.vscode/mcp.json):

```json
{
  "servers": {
    "anything-obsidian": {
      "type": "http",
      "url": "http://localhost:11333/mcp"
    }
  }
}
```

In VS Code, open `/Users/lettucech/Documents/anything-obsidian`, then open the Command Palette and run **MCP: List Servers**. Start or trust `anything-obsidian` if prompted.

If you changed `HOST_MCP_PORT`, edit `.vscode/mcp.json` and use that port in the URL.

### Codex

For local stdio MCP, build the wrapper first:

```bash
cd /Users/lettucech/Documents/anything-obsidian/mcp/anythingllm
npm install
npm run build
```

Use [docs/codex-config.example.toml](docs/codex-config.example.toml) as the starting point for your Codex config:

```toml
[mcp_servers.anything-obsidian]
command = "node"
args = ["/Users/lettucech/Documents/anything-obsidian/mcp/anythingllm/dist/index.js"]
```

Restart Codex after changing MCP config.

## 10. Test MCP Query

After connecting your agent, ask it:

```text
Use the anything-obsidian MCP tool to search for anything-obsidian-smoke-test-2026.
```

Expected behavior:

- The agent calls `anythingllm_vector_search` or `anythingllm_query`.
- The result mentions your smoke-test note.
- If no result appears, check sync logs or rerun the manual embed job:

```bash
cd /Users/lettucech/Documents/anything-obsidian/docker/mcp
docker compose --env-file ../../.env run --rm embed node scripts/embed-vault.mjs --all
```

## Useful Commands

Core AnythingLLM:

```bash
cd /Users/lettucech/Documents/anything-obsidian/docker/anythingllm
docker compose --env-file ../../.env up -d
docker compose --env-file ../../.env ps
docker compose --env-file ../../.env logs -f
docker compose --env-file ../../.env down
```

Optional MCP and embedding:

```bash
cd /Users/lettucech/Documents/anything-obsidian/docker/mcp
docker compose --env-file ../../.env up -d --build mcp
docker compose --env-file ../../.env up -d --build sync
docker compose --env-file ../../.env run --rm embed
docker compose --env-file ../../.env logs -f mcp
docker compose --env-file ../../.env logs -f sync
docker compose --env-file ../../.env down
```

Vault Git sync:

```bash
cd /Users/lettucech/Documents/vault
git pull --rebase --autostash origin main
git status
git add .
git commit -m "Update vault"
git push
```

## Local Data That Should Not Be Committed

These are ignored by the tooling repo:

- `.env`
- `.anything-obsidian-storage/`
- `.anything-obsidian-state/`
- `mcp/anythingllm/node_modules/`
- `mcp/anythingllm/dist/`

Keep your Obsidian notes and `.obsidian` settings in your separate vault repo according to your own vault policy.

## References

- AnythingLLM API docs are available on your local instance at `http://localhost:11301/api/docs`.
- AnythingLLM Docker storage must be mounted to `/app/server/storage`.
- When AnythingLLM runs in Docker, local host services such as Ollama should use `host.docker.internal` on macOS/Windows, not `localhost`.
