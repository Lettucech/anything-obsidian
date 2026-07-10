# Docker-first Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework `anything-obsidian` so the supported setup is clone vault, edit `.env`, and run Docker Compose from one root runtime surface.

**Architecture:** A single root `docker-compose.yml` owns the runtime. AnythingLLM and MCP are long-running Docker services; `worker` is a Dockerized one-shot command service for `embed`, `sync`, and `doctor`. The old installer/TUI and split Compose files are retired from the documented path.

**Tech Stack:** Docker Compose, Node.js 22 ESM scripts, TypeScript MCP server, AnythingLLM HTTP API, Git CLI inside the worker image, Node built-in test runner.

## Global Constraints

- The primary human UX is: clone this repo, clone the Obsidian vault repo, copy/edit `.env`, then run `docker compose up -d`.
- Server-like components stay in Docker.
- Use one root `docker-compose.yml` as the main runtime entrypoint.
- Docker-visible container names must be prefixed with `anything-obsidian`.
- `worker` is acceptable as a Compose service name, but the container name must be `anything-obsidian-worker`.
- `worker` must not start as a long-running service from plain `docker compose up -d` in this rewrite.
- Manual `worker sync`, `worker embed`, and `worker doctor` must be reliable before optional auto polling returns.
- Preserve: Git is the source of truth; AnythingLLM is a derived local index.
- Do not implement graph search in this rewrite.
- Do not add Ollama summarization or reranking.
- Do not require a Go installer or TUI.
- Do not require a host-side Node CLI for the core setup path.
- `/vault` remains container-internal wiring, not a user setting.

---

## File Structure

- Create `docker-compose.yml`: root Compose file for `anythingllm`, `mcp`, and profiled `worker`.
- Create `docker/worker/Dockerfile`: Node 22 worker image with Git and SSH client.
- Create `scripts/lib/env.mjs`: shared `.env` parsing and config helpers for worker scripts.
- Create `scripts/worker.mjs`: command dispatcher for `embed`, `sync`, and `doctor`.
- Modify `scripts/embed-vault.mjs`: export an `embedVault(options)` function and keep CLI compatibility.
- Modify `scripts/watch-vault.mjs`: extract `syncOnce(options)` for reuse by `worker sync`; keep `shouldEmbedAfterSync`.
- Modify `mcp/anythingllm/src/index.ts`: make missing API key first-run status obvious without breaking `/health`.
- Modify `.env.example`: reduce to the Docker-first user-facing env surface.
- Modify `README.md`: rewrite around root Docker Compose and one-shot worker commands.
- Modify `docs/agent-mcp.md`: update MCP setup to root Compose.
- Remove or retire from docs: `install.sh`, `installer/`, `docker/anythingllm/compose.yml`, `docker/mcp/compose.yml`, and `docker/automation/Dockerfile`.

---

### Task 1: Shared Config And Worker CLI Skeleton

**Files:**
- Create: `scripts/lib/env.mjs`
- Create: `scripts/worker.mjs`
- Create: `scripts/worker.test.mjs`
- Modify: `.env.example`

**Interfaces:**
- Produces: `loadEnvFile(filePath: string): Record<string, string>`
- Produces: `resolveConfig(env: Record<string, string>): { anythingllmBaseUrl: string; apiKey: string; workspaceSlug: string; vaultPath: string; gitRemote: string; gitBranch: string; gitAutoPull: boolean; gitAutoPush: boolean; gitUserName: string; gitUserEmail: string; gitPushUrl: string; }`
- Produces: `runWorker(argv: string[], env?: NodeJS.ProcessEnv): Promise<number>`
- Later tasks consume `resolveConfig` and `runWorker`.

- [ ] **Step 1: Write failing config tests**

Create `scripts/worker.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

import { loadEnvText, resolveConfig } from "./lib/env.mjs";

test("parses simple env text without shell evaluation", () => {
  assert.deepEqual(loadEnvText("A=one\nB=\"two dollars $$\"\n# comment\n"), {
    A: "one",
    B: "two dollars $$",
  });
});

test("resolves Docker worker defaults", () => {
  const config = resolveConfig({
    ANYTHINGLLM_API_KEY: "key",
    HOST_VAULT_PATH: "/Users/me/vault",
  });

  assert.equal(config.anythingllmBaseUrl, "http://anythingllm:3001");
  assert.equal(config.apiKey, "key");
  assert.equal(config.workspaceSlug, "obsidian");
  assert.equal(config.vaultPath, "/vault");
  assert.equal(config.gitRemote, "origin");
  assert.equal(config.gitBranch, "main");
  assert.equal(config.gitAutoPull, true);
  assert.equal(config.gitAutoPush, true);
});

test("worker config honors explicit container values", () => {
  const config = resolveConfig({
    ANYTHINGLLM_API_KEY: "key",
    ANYTHINGLLM_BASE_URL: "http://custom:3001",
    ANYTHINGLLM_WORKSPACE_SLUG: "notes",
    VAULT_PATH: "/mounted-vault",
    KB_GIT_AUTO_PULL: "false",
    KB_GIT_AUTO_PUSH: "0",
  });

  assert.equal(config.anythingllmBaseUrl, "http://custom:3001");
  assert.equal(config.workspaceSlug, "notes");
  assert.equal(config.vaultPath, "/mounted-vault");
  assert.equal(config.gitAutoPull, false);
  assert.equal(config.gitAutoPush, false);
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
node --test scripts/worker.test.mjs
```

Expected: FAIL with a module-not-found error for `./lib/env.mjs`.

- [ ] **Step 3: Implement shared env/config helpers**

Create `scripts/lib/env.mjs`:

```js
import { readFile } from "node:fs/promises";

export async function loadEnvFile(filePath) {
  try {
    return loadEnvText(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

export function loadEnvText(text) {
  const values = {};

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    if (!/^[A-Z0-9_]+$/.test(key)) continue;
    values[key] = parseEnvValue(trimmed.slice(index + 1).trim());
  }

  return values;
}

export function resolveConfig(env) {
  return {
    anythingllmBaseUrl: stripTrailingSlash(
      env.ANYTHINGLLM_BASE_URL ?? "http://anythingllm:3001",
    ),
    apiKey: env.ANYTHINGLLM_API_KEY ?? "",
    workspaceSlug: env.ANYTHINGLLM_WORKSPACE_SLUG ?? "obsidian",
    vaultPath: env.VAULT_PATH ?? "/vault",
    gitRemote: env.KB_GIT_REMOTE ?? "origin",
    gitBranch: env.KB_GIT_BRANCH ?? "main",
    gitAutoPull: bool(env.KB_GIT_AUTO_PULL, true),
    gitAutoPush: bool(env.KB_GIT_AUTO_PUSH, true),
    gitUserName: env.KB_GIT_USER_NAME ?? "anything-obsidian",
    gitUserEmail: env.KB_GIT_USER_EMAIL ?? "anything-obsidian@local",
    gitPushUrl: env.KB_GIT_PUSH_URL ?? "",
  };
}

function parseEnvValue(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function bool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}
```

- [ ] **Step 4: Implement worker dispatcher skeleton**

Create `scripts/worker.mjs`:

```js
#!/usr/bin/env node
import process from "node:process";

export async function runWorker(argv = process.argv.slice(2), env = process.env) {
  const [command] = argv;

  switch (command) {
    case "embed":
    case "sync":
    case "doctor":
      console.error(`worker command '${command}' is not wired yet.`);
      return 70;
    case "-h":
    case "--help":
    case "help":
    case undefined:
      printUsage();
      return command ? 0 : 2;
    default:
      console.error(`Unknown worker command: ${command}`);
      printUsage();
      return 2;
  }
}

function printUsage() {
  console.error(`Usage: node scripts/worker.mjs <command>

Commands:
  embed [--all]  Embed vault documents into AnythingLLM
  sync           Sync vault Git changes, then embed after successful push
  doctor         Check Docker-visible config and service reachability`);
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  process.exitCode = await runWorker();
}
```

- [ ] **Step 5: Simplify `.env.example` to the approved user surface**

Replace `.env.example` with:

```bash
# AnythingLLM user settings
ANYTHINGLLM_API_KEY=
ANYTHINGLLM_WORKSPACE_SLUG=obsidian

# Vault host path used by Docker Compose.
HOST_VAULT_PATH=/Users/you/Documents/vault

# Host ports used by Docker Compose.
HOST_ANYTHINGLLM_PORT=11301
HOST_MCP_PORT=11333

# Git sync settings used by the worker container.
KB_GIT_REMOTE=origin
KB_GIT_BRANCH=main
KB_GIT_AUTO_PULL=true
KB_GIT_AUTO_PUSH=true
KB_GIT_USER_NAME=anything-obsidian
KB_GIT_USER_EMAIL=anything-obsidian@local
KB_GIT_PUSH_URL=
```

- [ ] **Step 6: Run tests**

Run:

```bash
node --test scripts/worker.test.mjs
```

Expected: PASS for all tests.

- [ ] **Step 7: Commit Task 1**

Run:

```bash
git add .env.example scripts/lib/env.mjs scripts/worker.mjs scripts/worker.test.mjs
git commit -m "Add Docker worker config skeleton"
```

---

### Task 2: Worker Embed, Sync, And Doctor Commands

**Files:**
- Modify: `scripts/embed-vault.mjs`
- Modify: `scripts/watch-vault.mjs`
- Modify: `scripts/worker.mjs`
- Modify: `scripts/worker.test.mjs`
- Create: `scripts/doctor.mjs`

**Interfaces:**
- Consumes: `resolveConfig(env)` from Task 1.
- Produces: `embedVault({ config, all?: boolean }): Promise<{ scanned: number; uploaded: number; removed: number; workspaceSlug: string; }>`
- Produces: `syncVaultOnce({ config }): Promise<{ pushed: boolean; embedded: boolean; }>`
- Produces: `doctor({ config, fetchImpl?: typeof fetch }): Promise<{ ok: boolean; checks: Array<{ name: string; ok: boolean; message: string; }> }>`
- `runWorker(["embed", "--all"])`, `runWorker(["sync"])`, and `runWorker(["doctor"])` return `0` on success and non-zero on failure.

- [ ] **Step 1: Add worker command tests**

Append to `scripts/worker.test.mjs`:

```js
import { runWorker } from "./worker.mjs";

test("worker rejects unknown commands", async () => {
  assert.equal(await runWorker(["wat"], {}), 2);
});

test("worker help succeeds", async () => {
  assert.equal(await runWorker(["--help"], {}), 0);
});
```

- [ ] **Step 2: Run command tests and capture current failures**

Run:

```bash
node --test scripts/worker.test.mjs
```

Expected: FAIL if `runWorker` import executes the process-exit branch incorrectly, or PASS for the new dispatcher-only tests before command wiring.

- [ ] **Step 3: Refactor embed script into a callable function**

In `scripts/embed-vault.mjs`, wrap the current top-level implementation in:

```js
export async function embedVault({ config, all = false }) {
  const baseUrl = stripTrailingSlash(config.anythingllmBaseUrl);
  const apiKey = config.apiKey;
  const workspaceSlug = config.workspaceSlug;
  const documentFolder = config.documentFolder ?? "anything-obsidian-vault";
  const vaultPath = config.vaultPath;
  const stateDir = config.stateDir ?? path.resolve(repoRoot, ".anything-obsidian-state");
  const manifestPath = path.join(stateDir, "embed-manifest.json");

  if (!apiKey) {
    throw new Error("Missing ANYTHINGLLM_API_KEY in .env.");
  }

  const manifest = await readManifest(manifestPath);
  const files = await listVaultFiles(vaultPath);
  const seen = new Set();
  const additions = [];
  const deletions = [];
  const nextManifest = { version: 1, files: { ...manifest.files } };

  for (const file of files) {
    const rel = toPosix(path.relative(vaultPath, file));
    seen.add(rel);
    const hash = await sha256(file);
    const previous = manifest.files[rel];
    if (!all && previous?.hash === hash && previous?.locations?.length) continue;
    const uploaded = await uploadFile({ file, rel, baseUrl, apiKey, documentFolder });
    const locations = uploaded.documents?.map((document) => document.location).filter(Boolean);
    if (!locations?.length) continue;
    additions.push(...locations);
    if (previous?.locations?.length) deletions.push(...previous.locations);
    nextManifest.files[rel] = { hash, locations, embeddedAt: new Date().toISOString() };
  }

  for (const [rel, previous] of Object.entries(manifest.files)) {
    if (seen.has(rel)) continue;
    if (previous?.locations?.length) deletions.push(...previous.locations);
    delete nextManifest.files[rel];
  }

  if (additions.length || deletions.length) {
    await updateEmbeddings({ adds: additions, deletes: deletions, baseUrl, apiKey, workspaceSlug });
    await mkdir(stateDir, { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
  }

  return { scanned: files.length, uploaded: additions.length, removed: deletions.length, workspaceSlug };
}
```

Keep CLI compatibility at the bottom:

```js
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const env = { ...(await loadEnvFile(path.join(repoRoot, ".env"))), ...process.env };
  const config = resolveConfig(env);
  const result = await embedVault({ config, all: process.argv.includes("--all") });
  console.log(JSON.stringify(result, null, 2));
}
```

- [ ] **Step 4: Extract sync-once command**

In `scripts/watch-vault.mjs`, export:

```js
export async function syncVaultOnce({ config }) {
  await configureGit(config);
  let pushSucceeded = !config.gitAutoPush;

  if (config.gitAutoPull) {
    await run("git", ["pull", "--rebase", "--autostash", config.gitRemote, config.gitBranch], {
      cwd: config.vaultPath,
    });
  }

  const statusBefore = await capture("git", ["status", "--porcelain"], {
    cwd: config.vaultPath,
  });

  if (statusBefore.trim()) {
    await run("git", ["add", "-A"], { cwd: config.vaultPath });
    const statusAfterAdd = await capture("git", ["status", "--porcelain"], {
      cwd: config.vaultPath,
    });
    if (statusAfterAdd.trim()) {
      await run("git", ["commit", "-m", commitMessage()], { cwd: config.vaultPath });
    }
  }

  if (config.gitAutoPush) {
    if (config.gitPushUrl) {
      await run("git", ["push", config.gitPushUrl, `HEAD:${config.gitBranch}`], {
        cwd: config.vaultPath,
      });
    } else {
      await run("git", ["push", "-u", config.gitRemote, config.gitBranch], {
        cwd: config.vaultPath,
      });
    }
    pushSucceeded = true;
  }

  return { pushed: pushSucceeded, embedded: false };
}
```

Update existing helper signatures so `configureGit(config)` reads values from config. Keep the old watcher `main()` behavior working by constructing config from env before polling.

- [ ] **Step 5: Add doctor command module**

Create `scripts/doctor.mjs`:

```js
import { access } from "node:fs/promises";

export async function doctor({ config, fetchImpl = fetch }) {
  const checks = [];

  await record(checks, "vault mount", async () => {
    await access(config.vaultPath);
    return `Vault path is readable: ${config.vaultPath}`;
  });

  await record(checks, "anythingllm api docs", async () => {
    const response = await fetchImpl(`${config.anythingllmBaseUrl}/api/docs`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return "AnythingLLM API docs are reachable";
  });

  await record(checks, "anythingllm api key", async () => {
    if (!config.apiKey) throw new Error("ANYTHINGLLM_API_KEY is empty");
    const response = await fetchImpl(`${config.anythingllmBaseUrl}/api/v1/workspaces`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return "AnythingLLM API key can list workspaces";
  });

  return { ok: checks.every((check) => check.ok), checks };
}

async function record(checks, name, fn) {
  try {
    checks.push({ name, ok: true, message: await fn() });
  } catch (error) {
    checks.push({
      name,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
```

- [ ] **Step 6: Wire worker commands**

Update `scripts/worker.mjs` command cases:

```js
import path from "node:path";
import { fileURLToPath } from "node:url";

import { doctor } from "./doctor.mjs";
import { embedVault } from "./embed-vault.mjs";
import { loadEnvFile, resolveConfig } from "./lib/env.mjs";
import { syncVaultOnce, shouldEmbedAfterSync } from "./watch-vault.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadConfig(env) {
  return resolveConfig({
    ...(await loadEnvFile(path.join(repoRoot, ".env"))),
    ...env,
  });
}
```

Use these command bodies:

```js
case "embed": {
  const config = await loadConfig(env);
  const result = await embedVault({ config, all: argv.includes("--all") });
  console.log(JSON.stringify(result, null, 2));
  return 0;
}
case "sync": {
  const config = await loadConfig(env);
  const syncResult = await syncVaultOnce({ config });
  let embedded = false;
  if (shouldEmbedAfterSync({
    embedAfterSync: true,
    gitAutoPush: config.gitAutoPush,
    pushSucceeded: syncResult.pushed,
  })) {
    await embedVault({ config, all: false });
    embedded = true;
  }
  console.log(JSON.stringify({ ...syncResult, embedded }, null, 2));
  return 0;
}
case "doctor": {
  const config = await loadConfig(env);
  const result = await doctor({ config });
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}
```

- [ ] **Step 7: Run tests**

Run:

```bash
node --test scripts/worker.test.mjs scripts/watch-vault.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit Task 2**

Run:

```bash
git add scripts/embed-vault.mjs scripts/watch-vault.mjs scripts/worker.mjs scripts/worker.test.mjs scripts/doctor.mjs
git commit -m "Wire Docker worker commands"
```

---

### Task 3: Root Compose Runtime

**Files:**
- Create: `docker-compose.yml`
- Create: `docker/worker/Dockerfile`
- Modify: `mcp/anythingllm/Dockerfile`
- Retire from docs or remove after replacement: `docker/anythingllm/compose.yml`, `docker/mcp/compose.yml`, `docker/automation/Dockerfile`

**Interfaces:**
- Consumes: `scripts/worker.mjs embed|sync|doctor` from Task 2.
- Produces: root Compose services `anythingllm`, `mcp`, and profiled `worker`.
- Produces container names `anything-obsidian-anythingllm`, `anything-obsidian-mcp`, and `anything-obsidian-worker`.

- [ ] **Step 1: Create worker Dockerfile**

Create `docker/worker/Dockerfile`:

```dockerfile
FROM node:22-alpine

RUN apk add --no-cache git openssh-client

WORKDIR /workspace

COPY scripts ./scripts
COPY .env.example ./.env.example

ENTRYPOINT ["node", "scripts/worker.mjs"]
CMD ["doctor"]
```

- [ ] **Step 2: Ensure MCP Dockerfile builds the TypeScript server**

Keep or update `mcp/anythingllm/Dockerfile` so it contains:

```dockerfile
FROM node:22-alpine AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

CMD ["node", "dist/index.js", "--http"]
```

- [ ] **Step 3: Create root Compose file**

Create `docker-compose.yml`:

```yaml
name: anything-obsidian

services:
  anythingllm:
    image: mintplexlabs/anythingllm:latest
    container_name: anything-obsidian-anythingllm
    restart: unless-stopped
    ports:
      - "${HOST_ANYTHINGLLM_PORT:-11301}:3001"
    volumes:
      - ./.anything-obsidian-storage:/app/server/storage
    environment:
      DISABLE_TELEMETRY: "true"
      STORAGE_DIR: /app/server/storage
      UID: "1000"
      GID: "1000"
    extra_hosts:
      - "host.docker.internal:host-gateway"

  mcp:
    build:
      context: ./mcp/anythingllm
    container_name: anything-obsidian-mcp
    restart: unless-stopped
    depends_on:
      - anythingllm
    env_file:
      - path: ./.env
        required: false
    environment:
      ANYTHINGLLM_BASE_URL: http://anythingllm:3001
      MCP_TRANSPORT: http
      MCP_PORT: "3333"
    ports:
      - "${HOST_MCP_PORT:-11333}:3333"

  worker:
    profiles:
      - tools
    build:
      context: .
      dockerfile: docker/worker/Dockerfile
    container_name: anything-obsidian-worker
    depends_on:
      - anythingllm
    env_file:
      - path: ./.env
        required: false
    environment:
      ANYTHINGLLM_BASE_URL: http://anythingllm:3001
      VAULT_PATH: /vault
    volumes:
      - ./.anything-obsidian-state:/workspace/.anything-obsidian-state
      - ${HOST_VAULT_PATH:?Set HOST_VAULT_PATH in .env}:/vault
```

- [ ] **Step 4: Validate Compose config**

Run:

```bash
docker compose --env-file .env.example config
```

Expected: PASS and output includes `container_name: anything-obsidian-worker`.

- [ ] **Step 5: Decide old Compose file handling**

If the root Compose file validates, remove the old Compose files:

```bash
git rm docker/anythingllm/compose.yml docker/mcp/compose.yml docker/automation/Dockerfile
```

Expected: the files are staged for deletion. Do not remove `docker/anythingllm/` or `docker/mcp/` directories if Git leaves them empty; Git does not track empty directories.

- [ ] **Step 6: Commit Task 3**

Run:

```bash
git add docker-compose.yml docker/worker/Dockerfile mcp/anythingllm/Dockerfile
git commit -m "Consolidate Docker Compose runtime"
```

If Step 5 removed files, include those staged deletions in the same commit.

---

### Task 4: MCP First-run Behavior And Health

**Files:**
- Modify: `mcp/anythingllm/src/index.ts`

**Interfaces:**
- Consumes: root Compose service `mcp`.
- Produces: `/health` response `{ ok: boolean; name: string; apiKeyConfigured: boolean }`.
- Produces: MCP tools still fail clearly when `ANYTHINGLLM_API_KEY` is missing.

- [ ] **Step 1: Update health payload**

In `mcp/anythingllm/src/index.ts`, change the health endpoint to:

```ts
app.get("/health", (_: any, res: any) => {
  res.status(200).json({
    ok: true,
    name: "anything-obsidian-mcp",
    apiKeyConfigured: Boolean(apiKey),
  });
});
```

- [ ] **Step 2: Keep missing-key tool error explicit**

Keep `requestJson` throwing:

```ts
throw new Error("Missing ANYTHINGLLM_API_KEY in repo root .env");
```

If the message changes, use:

```ts
throw new Error("Missing ANYTHINGLLM_API_KEY. Finish AnythingLLM setup, add the key to .env, then recreate the MCP service.");
```

- [ ] **Step 3: Build MCP**

Run:

```bash
cd mcp/anythingllm
npm run typecheck
npm run build
```

Expected: both commands PASS.

- [ ] **Step 4: Commit Task 4**

Run:

```bash
git add mcp/anythingllm/src/index.ts
git commit -m "Clarify MCP first-run health"
```

---

### Task 5: Docker-first Docs And Legacy Cleanup

**Files:**
- Modify: `README.md`
- Modify: `docs/agent-mcp.md`
- Modify: `docs/codex-config.example.toml`
- Remove or archive: `install.sh`, `installer/`
- Remove: `scripts/kb`

**Interfaces:**
- Consumes: root Compose commands from Task 3.
- Produces: README with main setup path based on `docker compose up -d`.
- Produces: MCP docs pointing to `http://localhost:11333/mcp`.

- [ ] **Step 1: Rewrite README opening and setup**

Replace the first-run setup section with this Markdown. Use normal fenced command blocks in `README.md`; the four-backtick wrapper here is only for the plan document.

````markdown
## First-run setup

1. Clone this tooling repo and your Obsidian vault repo:

```bash
git clone https://github.com/pingkiuho/anything-obsidian.git
git clone <your-vault-repo> vault
cd anything-obsidian
```

2. Create `.env`:

```bash
cp .env.example .env
```

3. Edit `.env` and set `HOST_VAULT_PATH` to the absolute path of your vault.

4. Start the Docker services:

```bash
docker compose up -d
```

5. Open AnythingLLM at `http://localhost:11301`, finish setup, create the `obsidian` workspace, configure an embedder, and create an API key.

6. Put the API key in `.env`, then recreate MCP:

```bash
docker compose up -d --force-recreate mcp
```

7. Embed the vault:

```bash
docker compose run --rm worker embed --all
```

8. Check the setup:

```bash
docker compose run --rm worker doctor
```
````

- [ ] **Step 2: Update service naming docs**

Add a short section:

```markdown
## Docker services

- `anything-obsidian-anythingllm`: local AnythingLLM server.
- `anything-obsidian-mcp`: MCP HTTP server for coding agents.
- `anything-obsidian-worker`: one-shot worker for vault embedding, sync, and diagnostics.
```

- [ ] **Step 3: Update MCP docs**

In `docs/agent-mcp.md`, replace split Compose commands with:

```bash
docker compose up -d
docker compose up -d --force-recreate mcp
curl --fail --silent --show-error http://localhost:11333/health
```

Keep the Codex/Claude/Copilot MCP URL as:

```text
http://localhost:11333/mcp
```

- [ ] **Step 4: Retire installer/TUI path**

Remove the old installer files:

```bash
git rm install.sh
git rm -r installer
```

Remove the legacy shell helper so Docker Compose is the single documented command surface:

```bash
git rm scripts/kb
```

- [ ] **Step 5: Run docs and whitespace checks**

Run:

```bash
git diff --check
docker compose --env-file .env.example config
```

Expected: both PASS.

- [ ] **Step 6: Commit Task 5**

Run:

```bash
git add README.md docs/agent-mcp.md docs/codex-config.example.toml
git add -u install.sh installer scripts/kb
git commit -m "Rewrite docs for Docker-first setup"
```

Include staged deletions from Step 4 in this commit.

---

### Task 6: End-to-end Verification

**Files:**
- Modify only files required by failures from verification.

**Interfaces:**
- Consumes all previous tasks.
- Produces verified Docker-first rewrite.

- [ ] **Step 1: Run unit tests**

Run:

```bash
node --test scripts/worker.test.mjs scripts/watch-vault.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Build MCP**

Run:

```bash
cd mcp/anythingllm
npm run typecheck
npm run build
```

Expected: PASS.

- [ ] **Step 3: Validate Docker Compose**

Run from repo root:

```bash
docker compose --env-file .env.example config
```

Expected: PASS.

- [ ] **Step 4: Run Docker smoke checks when Docker is available**

Run:

```bash
docker compose up -d anythingllm
docker compose up -d mcp
curl --fail --silent --show-error http://localhost:11333/health
docker compose run --rm worker doctor
```

Expected: health returns JSON with `name` equal to `anything-obsidian-mcp`. `worker doctor` may fail the API-key check if `.env.example` is used; with a real `.env` it must pass.

- [ ] **Step 5: Verify worker embed with a small real or temporary vault**

With `.env` pointing to a small test vault and a valid AnythingLLM API key, run:

```bash
docker compose run --rm worker embed --all
```

Expected: JSON output contains `"workspaceSlug": "obsidian"` and a non-negative `"scanned"` count.

- [ ] **Step 6: Final diff checks**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors. `git status --short` shows only intentional changes if this task fixed verification issues.

- [ ] **Step 7: Commit verification fixes when verification changed files**

When Step 4 or Step 5 required code/docs changes, run:

```bash
git add README.md docs/agent-mcp.md docs/codex-config.example.toml docker-compose.yml docker/worker/Dockerfile mcp/anythingllm/Dockerfile mcp/anythingllm/src/index.ts scripts/doctor.mjs scripts/embed-vault.mjs scripts/lib/env.mjs scripts/watch-vault.mjs scripts/worker.mjs scripts/worker.test.mjs
git commit -m "Fix Docker-first verification issues"
```

When no changes were required, do not create an empty commit.
