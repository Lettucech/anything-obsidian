# Multi-Vault Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run multiple Git-backed vaults through one Docker stack, with dashboard-managed vaults, isolated AnythingLLM workspaces and worker state.

**Architecture:** A shared registry persists vault metadata below a dashboard state volume. Dashboard, worker, scheduler, and MCP address each vault by stable id and resolve only direct children of one fixed `/vaults` mount.

**Tech Stack:** Node.js 22 ESM, node:test, Docker Compose, AnythingLLM Developer API, TypeScript MCP.

## Global Constraints

- Compose mounts one configurable `HOST_VAULTS_ROOT` at `/vaults`; no API accepts arbitrary host paths.
- Git is the source of truth; every vault maps to one workspace and its own manifest namespace.
- The registry and API never expose raw API keys or Git tokens.
- `restricted` policy persists an allowlist but must state it is unenforced until MCP identity exists.
- Remove unregisters a vault only; it never deletes its local repository or workspace.

---

### Task 1: Registry and root-path safety

**Files:**
- Create: `lib/vault-registry.mjs`
- Test: `lib/vault-registry.test.mjs`
- Modify: `docker/dashboard/Dockerfile`, `docker/worker/Dockerfile`

**Interfaces:** Export `createVaultRegistry({ rootPath, registryPath })` with `list()`, `get(id)`, `create(input)`, `update(id, input)`, `remove(id)`, and `resolvePath(vault)`.

- [ ] **Step 1: Write failing tests for invalid ids, `../` directory traversal, duplicate workspace slugs, atomic persistence, and non-destructive removal.**
- [ ] **Step 2: Run:** `node --test lib/vault-registry.test.mjs` — expect missing-module failure.
- [ ] **Step 3: Implement a versioned JSON registry (`{ version: 1, vaults: [] }`) written through a sibling temporary file and rename. Resolve a vault only when `path.dirname(path.resolve(root, directory)) === path.resolve(root)`. Validate `id`, `directory`, and `workspaceSlug` as lowercase dash-separated values.**
- [ ] **Step 4: Copy `lib` into dashboard and worker Docker images; run:** `node --test lib/vault-registry.test.mjs`.
- [ ] **Step 5: Commit:** `git add lib/vault-registry.mjs lib/vault-registry.test.mjs docker/dashboard/Dockerfile docker/worker/Dockerfile && git commit -m "feat: add safe multi-vault registry"`.

### Task 2: AnythingLLM workspace client and dashboard CRUD

**Files:**
- Create: `dashboard/anythingllm.mjs`, `dashboard/anythingllm.test.mjs`
- Modify: `dashboard/server.mjs`, `dashboard/server.test.mjs`

**Interfaces:** Export `createAnythingllmClient({ baseUrl, apiKey, fetchImpl })` with `listWorkspaces()`, `createWorkspace({ name })`, and `workspaceExists(slug)`. Add `GET /api/vaults`, `POST /api/vaults`, `PATCH /api/vaults/:id`, and `DELETE /api/vaults/:id`.

- [ ] **Step 1: Write failing tests proving create calls `POST /api/v1/workspace/new`, attach verifies `GET /api/v1/workspaces`, and `../outside` receives HTTP 400.**
- [ ] **Step 2: Run:** `node --test dashboard/anythingllm.test.mjs dashboard/server.test.mjs` — expect failure.
- [ ] **Step 3: Implement authenticated AnythingLLM requests, 64 KiB JSON body parsing, workspace create/attach, and registry-backed CRUD. Return 400 for input errors, 404 for absent ids, 409 for duplicate mappings. Never return API keys.**
- [ ] **Step 4: Run:** `node --test dashboard/anythingllm.test.mjs dashboard/server.test.mjs`.
- [ ] **Step 5: Commit:** `git add dashboard/anythingllm.mjs dashboard/anythingllm.test.mjs dashboard/server.mjs dashboard/server.test.mjs && git commit -m "feat: manage vaults from dashboard"`.

### Task 3: Shared-root Compose runtime

**Files:**
- Modify: `docker-compose.yml`, `.env.example`, `README.md`

**Interfaces:** Replace `HOST_VAULT_PATH` with `HOST_VAULTS_ROOT`, mounted as `/vaults` in dashboard, syncer, and worker. Mount a named registry volume at `/workspace/.anything-obsidian-registry`.

- [ ] **Step 1: Replace required single-vault interpolation. Pass `VAULTS_ROOT=/vaults` and `VAULT_REGISTRY_PATH=/workspace/.anything-obsidian-registry/vaults.json` to registry consumers. An empty root must start successfully.**
- [ ] **Step 2: Rewrite first-run docs: Compose creates an empty managed space; dashboard creates/imports vaults; users can set the root to their existing-vault parent.**
- [ ] **Step 3: Run:** `HOST_VAULTS_ROOT=/tmp/anything-obsidian-vaults docker compose config`.
- [ ] **Step 4: Commit:** `git add docker-compose.yml .env.example README.md && git commit -m "feat: mount shared vault root"`.

### Task 4: Vault-scoped worker, embed state, and scheduler

**Files:**
- Create: `scripts/scheduler.mjs`, `scripts/scheduler.test.mjs`
- Modify: `scripts/worker.mjs`, `scripts/embed-vault.mjs`, `scripts/doctor.mjs`, `scripts/worker.test.mjs`, `scripts/embed-vault.test.mjs`

**Interfaces:** One-shot worker commands accept `--vault <id>`. `loadVaultConfig` resolves the registry record to `/vaults/<directory>`, mapped workspace, and `/workspace/.anything-obsidian-state/<vaultId>`. `runScheduler({ registry, runVault, sleep, now })` handles enabled records.

- [ ] **Step 1: Write failing tests proving `embed --vault work` uses workspace `work`, manifest directory ending in `work`, failed-vault scheduling does not skip the next vault, and an unknown id fails before a Git call.**
- [ ] **Step 2: Run:** `node --test scripts/worker.test.mjs scripts/embed-vault.test.mjs scripts/scheduler.test.mjs` — expect failure.
- [ ] **Step 3: Implement vault resolution for sync/embed/doctor; use global `.env` only as the initial secret store, while the registry supplies path, workspace, remote, branch, interval, and enabled state. Change default document folder to `anything-obsidian-vault/<vaultId>`. Change the long-running syncer command to `scheduler`; process all due enabled vaults and record one failure without aborting a round.**
- [ ] **Step 4: Run:** `node --test scripts/worker.test.mjs scripts/embed-vault.test.mjs scripts/watch-vault.test.mjs scripts/scheduler.test.mjs`.
- [ ] **Step 5: Commit:** `git add scripts/scheduler.mjs scripts/scheduler.test.mjs scripts/worker.mjs scripts/embed-vault.mjs scripts/doctor.mjs scripts/worker.test.mjs scripts/embed-vault.test.mjs && git commit -m "feat: run vault jobs independently"`.

### Task 5: Dashboard jobs and multi-vault UI

**Files:**
- Modify: `dashboard/config.mjs`, `dashboard/jobs.mjs`, `dashboard/jobs.test.mjs`, `dashboard/server.mjs`, `dashboard/server.test.mjs`
- Modify: `dashboard/public/index.html`, `dashboard/public/app.js`, `dashboard/public/app.test.mjs`, `dashboard/public/styles.css`

**Interfaces:** `POST /api/vaults/:id/actions/:action`; `jobs.start(vaultId, actionId, snapshot)` locks one job per vault. UI renders empty state, vault cards, form, access policy, and scoped actions.

- [ ] **Step 1: Write failing tests proving duplicate jobs for one vault are rejected but different vaults can start, `vaultActionUrl("work", "embed-all")` is `/api/vaults/work/actions/embed-all`, and an empty list renders `Add your first vault`.**
- [ ] **Step 2: Run:** `node --test dashboard/jobs.test.mjs dashboard/server.test.mjs dashboard/public/app.test.mjs` — expect failure.
- [ ] **Step 3: Scope worker container commands with fixed `--vault <id>` args. Replace global controls with escaped, vault-specific cards and an inline create/edit form. The `restricted` form state must show `not enforced yet`; never inject server strings through `innerHTML`.**
- [ ] **Step 4: Run:** `node --test dashboard/jobs.test.mjs dashboard/server.test.mjs dashboard/public/app.test.mjs`.
- [ ] **Step 5: Commit:** `git add dashboard/config.mjs dashboard/jobs.mjs dashboard/jobs.test.mjs dashboard/server.mjs dashboard/server.test.mjs dashboard/public/index.html dashboard/public/app.js dashboard/public/app.test.mjs dashboard/public/styles.css && git commit -m "feat: add multi-vault dashboard UI"`.

### Task 6: MCP vault selection and migration

**Files:**
- Create: `mcp/anythingllm/src/vault-registry.ts`, `mcp/anythingllm/src/vault-registry.test.ts`
- Modify: `mcp/anythingllm/src/index.ts`, `mcp/anythingllm/Dockerfile`, `docker-compose.yml`, `README.md`

**Interfaces:** MCP accepts optional `vaultId` rather than raw `workspaceSlug`. One accessible vault is implicit; more than one requires an explicit id. Registry is mounted read-only.

- [ ] **Step 1: Write failing resolver tests for successful id resolution, multi-vault selector required, and restricted policy clearly reported as unenforced.**
- [ ] **Step 2: Run:** `npm --prefix mcp/anythingllm run typecheck` — expect failure.
- [ ] **Step 3: Implement typed read-only registry parsing and map tool calls from vault ids to workspace slugs. Change workspace list to a vault list. Add one-time legacy single-vault import preview; never move or silently register a repository.**
- [ ] **Step 4: Run final verification:** `node --test dashboard/*.test.mjs dashboard/public/*.test.mjs lib/*.test.mjs scripts/*.test.mjs`; `npm --prefix mcp/anythingllm run typecheck`; `HOST_VAULTS_ROOT=/tmp/anything-obsidian-vaults docker compose config`; `git diff --check`.
- [ ] **Step 5: Commit:** `git add mcp/anythingllm/src mcp/anythingllm/Dockerfile docker-compose.yml README.md && git commit -m "feat: scope MCP requests to vaults"`.
