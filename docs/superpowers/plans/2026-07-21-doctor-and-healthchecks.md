# Doctor Hardening + Compose Healthchecks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `doctor` catch Git-auth, MCP-reachability, embedder-config, and index-drift failures, and give the Compose stack real readiness healthchecks so dependents start only once AnythingLLM is healthy.

**Architecture:** Additive changes only. `doctor` keeps its `record()/checks[]` pattern and gains two injectable dependencies (`runGit`, `readManifest`) mirroring the existing `fetchImpl` injection. File-listing defaults move into a shared exported `embeddableVaultFiles` so `embed` and `doctor` cannot drift on what counts as embeddable. Compose healthchecks use Node's built-in `http` module (no `curl`/`wget` dependency), and `mcp`/`syncer` switch to `depends_on: condition: service_healthy`.

**Tech Stack:** Node 22 (`node --test`), vanilla `node:http`/`node:child_process`, Docker Compose, existing AnythingLLM HTTP API.

**Spec:** [docs/superpowers/specs/2026-07-21-doctor-and-healthchecks-design.md](../specs/2026-07-21-doctor-and-healthchecks-design.md)

> **Commits:** every commit below ends with a trailer line `Co-Authored-By: Claude <noreply@anthropic.com>`.

---

## File Structure

- **Modify** `scripts/lib/env.mjs` — `resolveConfig` gains `mcpBaseUrl` and `kbStateDir` (raw string, stays pure).
- **Modify** `scripts/embed-vault.mjs` — export `embeddableVaultFiles` + `DEFAULT_EMBED_EXTENSIONS` + `DEFAULT_EMBED_EXCLUDE_DIRS`; `embedVault` calls the shared helper. No behavior change.
- **Modify** `scripts/doctor.mjs` — add four checks (`git remote`, `mcp health`, `embedder probe`, `index drift`) plus default `runGit`/`readManifest` and `stateDir` resolution.
- **Create** `scripts/doctor.test.mjs` — failure-case coverage for each new check via injected deps + temp dirs.
- **Modify** `scripts/worker.test.mjs` — update the existing doctor happy-path test (now 7 checks) and add config-field assertions.
- **Modify** `scripts/embed-vault.test.mjs` — add a test for `embeddableVaultFiles` defaults.
- **Modify** `docker-compose.yml` — three healthchecks; `mcp` and `syncer` → `condition: service_healthy`.

---

## Task 1: Branch + resolveConfig fields

**Files:**
- Modify: `scripts/lib/env.mjs:28-46`
- Test: `scripts/worker.test.mjs`

- [ ] **Step 1: Create the feature branch (we are on `main`)**

Run:
```bash
git checkout -b feature/doctor-and-healthchecks
```
Expected: `Switched to a new branch 'feature/doctor-and-healthchecks'`

- [ ] **Step 2: Commit the design spec and plan**

Run:
```bash
git add docs/superpowers/specs/2026-07-21-doctor-and-healthchecks-design.md docs/superpowers/plans/2026-07-21-doctor-and-healthchecks.md
git commit -m "$(cat <<'EOF'
Add doctor hardening + healthchecks design and plan

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```
Expected: one commit on `feature/doctor-and-healthchecks`.

- [ ] **Step 3: Write the failing test additions**

In `scripts/worker.test.mjs`, inside the test `"resolves Docker worker defaults"` (currently asserting through `config.gitAuthToken`), append two assertions before the closing `});`:

```js
  assert.equal(config.mcpBaseUrl, "http://mcp:3333");
  assert.equal(config.kbStateDir, "");
```

And in the test `"worker config honors explicit container values"`, add these env entries to the `resolveConfig({...})` input and matching assertions:

```js
    ANYTHINGLLM_MCP_BASE_URL: "http://mcp.special:3333",
    KB_STATE_DIR: "custom-state",
```

```js
  assert.equal(config.mcpBaseUrl, "http://mcp.special:3333");
  assert.equal(config.kbStateDir, "custom-state");
```

- [ ] **Step 4: Run the tests to verify they fail**

Run:
```bash
node --test scripts/worker.test.mjs 2>&1 | tail -15
```
Expected: FAIL — `config.mcpBaseUrl` / `config.kbStateDir` are `undefined`.

- [ ] **Step 5: Implement the config fields**

In `scripts/lib/env.mjs`, edit `resolveConfig` to add the two fields (place them right after `gitPushUrl`):

```js
    gitPushUrl: env.KB_GIT_PUSH_URL ?? "",
    mcpBaseUrl: stripTrailingSlash(env.ANYTHINGLLM_MCP_BASE_URL ?? "http://mcp:3333"),
    kbStateDir: env.KB_STATE_DIR ?? "",
```

- [ ] **Step 6: Run the tests to verify they pass**

Run:
```bash
node --test scripts/worker.test.mjs 2>&1 | tail -8
```
Expected: `# pass` count increases by 0 (same tests, now passing); `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/env.mjs scripts/worker.test.mjs
git commit -m "$(cat <<'EOF'
Add mcpBaseUrl and kbStateDir to worker config

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Share embeddable file listing from embed-vault

**Files:**
- Modify: `scripts/embed-vault.mjs`
- Test: `scripts/embed-vault.test.mjs`

- [ ] **Step 1: Write the failing test**

In `scripts/embed-vault.test.mjs`, update the import (line 7) and add a new test at the end of the file (before the `response` helper):

```js
import { embedVault, embeddableVaultFiles } from "./embed-vault.mjs";
```

```js
test("embeddableVaultFiles lists markdown and skips excluded dirs and other extensions", async () => {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "embed-vault-"));
  try {
    await writeFile(path.join(vaultPath, "note.md"), "x");
    await mkdir(path.join(vaultPath, ".git"), { recursive: true });
    await writeFile(path.join(vaultPath, ".git", "config"), "x");
    await writeFile(path.join(vaultPath, "image.png"), "x");

    const files = await embeddableVaultFiles(vaultPath);
    assert.deepEqual(
      files.map((file) => path.relative(vaultPath, file)),
      ["note.md"],
    );
  } finally {
    await rm(vaultPath, { force: true, recursive: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
node --test scripts/embed-vault.test.mjs 2>&1 | tail -12
```
Expected: FAIL — `embeddableVaultFiles` is not exported.

- [ ] **Step 3: Implement the shared helper + constants**

In `scripts/embed-vault.mjs`:

(a) Replace the local default strings inside `embedVault`. The current block near the top of `embedVault` is:

```js
  const extensions = csv(config.embedExtensions ?? ".md,.txt,.pdf,.docx").map((ext) =>
    ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`,
  );
  const excludeDirs = new Set(
    csv(
      config.embedExcludeDirs ??
        ".git,.obsidian,node_modules,mcp,.anything-obsidian-storage,.anything-obsidian-state",
    ),
  );
```

and later:

```js
  const files = await listVaultFiles(vaultPath, { extensions, excludeDirs });
```

Replace BOTH with:

```js
  const files = await embeddableVaultFiles(vaultPath, {
    extensions: config.embedExtensions,
    excludeDirs: config.embedExcludeDirs,
  });
```

(Delete the now-unused `const extensions` and `const excludeDirs` lines entirely.)

(b) Add these module-level exports near the other helpers (e.g. just above `async function listVaultFiles`):

```js
export const DEFAULT_EMBED_EXTENSIONS = ".md,.txt,.pdf,.docx";
export const DEFAULT_EMBED_EXCLUDE_DIRS =
  ".git,.obsidian,node_modules,mcp,.anything-obsidian-storage,.anything-obsidian-state";

export async function embeddableVaultFiles(vaultPath, { extensions, excludeDirs } = {}) {
  return listVaultFiles(vaultPath, {
    extensions: normalizeExtensions(extensions ?? DEFAULT_EMBED_EXTENSIONS),
    excludeDirs: new Set(csv(excludeDirs ?? DEFAULT_EMBED_EXCLUDE_DIRS)),
  });
}

function normalizeExtensions(value) {
  return csv(value).map((ext) =>
    ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`,
  );
}
```

- [ ] **Step 4: Run embed-vault tests to verify they pass**

Run:
```bash
node --test scripts/embed-vault.test.mjs 2>&1 | tail -8
```
Expected: PASS (both the existing workspace-validation test and the new listing test).

- [ ] **Step 5: Commit**

```bash
git add scripts/embed-vault.mjs scripts/embed-vault.test.mjs
git commit -m "$(cat <<'EOF'
Share embeddable file listing between embed and doctor

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Harden doctor with four new checks

**Files:**
- Modify: `scripts/doctor.mjs`
- Create: `scripts/doctor.test.mjs`
- Modify: `scripts/worker.test.mjs:235-271`

- [ ] **Step 1: Write the failing tests**

Create `scripts/doctor.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { doctor } from "./doctor.mjs";

function passingFetch() {
  return async () => ({ ok: true, status: 200, text: async () => "" });
}

function passingRunGit() {
  return async () => ({ ok: true, code: 0, stdout: "", stderr: "" });
}

function baseConfig(vaultPath, overrides = {}) {
  return {
    anythingllmBaseUrl: "http://anythingllm:3001",
    mcpBaseUrl: "http://mcp:3333",
    apiKey: "key",
    workspaceSlug: "obsidian",
    vaultPath,
    gitRemote: "origin",
    gitBranch: "main",
    ...overrides,
  };
}

function byName(result) {
  return new Map(result.checks.map((check) => [check.name, check]));
}

test("doctor git check reports failure and hints at KB_GIT_AUTH_TOKEN", async () => {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "doctor-"));
  try {
    const result = await doctor({
      config: baseConfig(vaultPath, { gitAuthToken: "" }),
      fetchImpl: passingFetch(),
      runGit: async () => ({ ok: false, code: 128, stdout: "", stderr: "Authentication failed" }),
      readManifest: async () => ({ files: {} }),
    });
    const git = byName(result).get("git remote");
    assert.equal(git.ok, false);
    assert.match(git.message, /exit 128/);
    assert.match(git.message, /KB_GIT_AUTH_TOKEN/);
  } finally {
    await rm(vaultPath, { force: true, recursive: true });
  }
});

test("doctor mcp health fails on non-200", async () => {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "doctor-"));
  try {
    const result = await doctor({
      config: baseConfig(vaultPath),
      fetchImpl: async (url) => {
        if (String(url).endsWith("/health")) {
          return { ok: false, status: 503, text: async () => "" };
        }
        return { ok: true, status: 200, text: async () => "" };
      },
      runGit: passingRunGit(),
      readManifest: async () => ({ files: {} }),
    });
    const mcp = byName(result).get("mcp health");
    assert.equal(mcp.ok, false);
    assert.match(mcp.message, /503/);
  } finally {
    await rm(vaultPath, { force: true, recursive: true });
  }
});

test("doctor embedder probe fails on non-200 vector-search", async () => {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "doctor-"));
  try {
    const result = await doctor({
      config: baseConfig(vaultPath),
      fetchImpl: async (url) => {
        if (String(url).endsWith("/vector-search")) {
          return { ok: false, status: 500, text: async () => "No embedding engine configured" };
        }
        return { ok: true, status: 200, text: async () => "" };
      },
      runGit: passingRunGit(),
      readManifest: async () => ({ files: {} }),
    });
    const embedder = byName(result).get("embedder probe");
    assert.equal(embedder.ok, false);
    assert.match(embedder.message, /HTTP 500/);
    assert.match(embedder.message, /No embedding engine configured/);
  } finally {
    await rm(vaultPath, { force: true, recursive: true });
  }
});

test("doctor flags empty index when vault has files but manifest is empty", async () => {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "doctor-"));
  try {
    await writeFile(path.join(vaultPath, "note.md"), "hello");
    const result = await doctor({
      config: baseConfig(vaultPath),
      fetchImpl: passingFetch(),
      runGit: passingRunGit(),
      readManifest: async () => ({ files: {} }),
    });
    const drift = byName(result).get("index drift");
    assert.equal(drift.ok, false);
    assert.match(drift.message, /index empty/);
    assert.match(drift.message, /1 vault files/);
  } finally {
    await rm(vaultPath, { force: true, recursive: true });
  }
});

test("doctor reports drift when a vault file is missing from the manifest", async () => {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "doctor-"));
  try {
    await writeFile(path.join(vaultPath, "a.md"), "a");
    await writeFile(path.join(vaultPath, "b.md"), "b");
    const result = await doctor({
      config: baseConfig(vaultPath),
      fetchImpl: passingFetch(),
      runGit: passingRunGit(),
      readManifest: async () => ({ files: { "a.md": { hash: "x" } } }),
    });
    const drift = byName(result).get("index drift");
    assert.equal(drift.ok, false);
    assert.match(drift.message, /index drift/);
    assert.match(drift.message, /b\.md/);
  } finally {
    await rm(vaultPath, { force: true, recursive: true });
  }
});

test("doctor drift is healthy when index matches vault", async () => {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "doctor-"));
  try {
    await writeFile(path.join(vaultPath, "a.md"), "a");
    const result = await doctor({
      config: baseConfig(vaultPath),
      fetchImpl: passingFetch(),
      runGit: passingRunGit(),
      readManifest: async () => ({ files: { "a.md": { hash: "x" } } }),
    });
    assert.equal(result.ok, true);
    assert.match(byName(result).get("index drift").message, /up to date/i);
  } finally {
    await rm(vaultPath, { force: true, recursive: true });
  }
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run:
```bash
node --test scripts/doctor.test.mjs 2>&1 | tail -15
```
Expected: FAIL — the new checks do not exist yet (`byName(...).get("git remote")` returns `undefined`, etc.).

- [ ] **Step 3: Implement doctor.mjs (full replacement)**

Replace the entire contents of `scripts/doctor.mjs` with:

```js
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { embeddableVaultFiles } from "./embed-vault.mjs";
import { gitEnv } from "./watch-vault.mjs";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");

export async function doctor({
  config,
  fetchImpl = fetch,
  runGit = runGitDefault,
  readManifest = readManifestDefault,
}) {
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

  await record(checks, "git remote", async () => {
    const result = await runGit({
      args: ["ls-remote", "--heads", config.gitRemote, config.gitBranch],
      cwd: config.vaultPath,
      env: gitEnv(config),
    });
    if (!result.ok) {
      throw new Error(
        `git ls-remote failed (exit ${result.code}): ${result.stderr.trim() || "no output"}` +
          (config.gitAuthToken ? "" : " — set KB_GIT_AUTH_TOKEN for private repos"),
      );
    }
    return `git remote '${config.gitRemote}' is reachable`;
  });

  await record(checks, "mcp health", async () => {
    const response = await fetchImpl(`${config.mcpBaseUrl}/health`);
    if (!response.ok) throw new Error(`MCP /health HTTP ${response.status}`);
    return `MCP is reachable at ${config.mcpBaseUrl}/health`;
  });

  await record(checks, "embedder probe", async () => {
    if (!config.apiKey) throw new Error("ANYTHINGLLM_API_KEY is empty");
    const url = `${config.anythingllmBaseUrl}/api/v1/workspace/${encodeURIComponent(
      config.workspaceSlug,
    )}/vector-search`;
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ query: "doctor", topN: 1 }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`vector-search HTTP ${response.status}: ${detail.trim() || "no detail"}`);
    }
    return "Embedder responded to a vector-search probe";
  });

  await record(checks, "index drift", async () => {
    const manifest = await readManifest(manifestPath(config));
    const embedded = Object.keys(manifest.files ?? {}).length;
    const files = await embeddableVaultFiles(config.vaultPath);
    if (files.length === 0) {
      return `Vault has no embeddable files; index has ${embedded} entries`;
    }
    if (embedded === 0) {
      throw new Error(
        `index empty: 0 embedded vs ${files.length} vault files (run: docker compose run --rm worker embed --all)`,
      );
    }
    const embeddedSet = new Set(Object.keys(manifest.files ?? {}));
    const missing = files
      .map((file) => toPosix(path.relative(config.vaultPath, file)))
      .filter((rel) => !embeddedSet.has(rel))
      .sort()
      .slice(0, 5);
    if (missing.length) {
      const label = missing.length === 5 ? "5+" : String(missing.length);
      throw new Error(
        `index drift: ${label} vault file(s) not embedded (e.g. ${missing.join(", ")})`,
      );
    }
    return `Index up to date: ${embedded} embedded vs ${files.length} vault files`;
  });

  return { ok: checks.every((check) => check.ok), checks };
}

function manifestPath(config) {
  const stateDir = config.kbStateDir
    ? path.resolve(repoRoot, config.kbStateDir)
    : path.resolve(repoRoot, ".anything-obsidian-state");
  return path.join(stateDir, "embed-manifest.json");
}

async function runGitDefault({ args, cwd, env }) {
  return await new Promise((resolve) => {
    const child = spawn("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", () =>
      resolve({ ok: false, code: -1, stdout, stderr: "spawn failed" }),
    );
    child.on("close", (code) => resolve({ ok: code === 0, code, stdout, stderr }));
  });
}

async function readManifestDefault(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return { version: 1, files: parsed.files ?? {} };
  } catch {
    return { version: 1, files: {} };
  }
}

function toPosix(value) {
  return value.split(path.sep).join("/");
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

- [ ] **Step 4: Run doctor tests to verify they pass**

Run:
```bash
node --test scripts/doctor.test.mjs 2>&1 | tail -8
```
Expected: PASS — 6 tests, `# fail 0`.

- [ ] **Step 5: Update the existing doctor happy-path test in worker.test.mjs**

Replace the test at `scripts/worker.test.mjs` named `"doctor checks vault mount and AnythingLLM with injected fetch"` with:

```js
test("doctor checks vault mount and AnythingLLM with injected fetch", async () => {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "anything-obsidian-vault-"));
  const requests = [];

  try {
    const result = await doctor({
      config: {
        anythingllmBaseUrl: "http://anythingllm:3001",
        mcpBaseUrl: "http://mcp:3333",
        apiKey: "key",
        workspaceSlug: "obsidian",
        vaultPath,
        gitRemote: "origin",
        gitBranch: "main",
      },
      fetchImpl: async (url, options = {}) => {
        requests.push({ url, options });
        return { ok: true, status: 200 };
      },
      runGit: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
      readManifest: async () => ({ files: {} }),
    });

    assert.equal(result.ok, true);
    assert.deepEqual(
      result.checks.map((check) => [check.name, check.ok]),
      [
        ["vault mount", true],
        ["anythingllm api docs", true],
        ["anythingllm api key", true],
        ["git remote", true],
        ["mcp health", true],
        ["embedder probe", true],
        ["index drift", true],
      ],
    );
    assert.deepEqual(requests, [
      { url: "http://anythingllm:3001/api/docs", options: {} },
      {
        url: "http://anythingllm:3001/api/v1/workspaces",
        options: { headers: { Authorization: "Bearer key" } },
      },
      { url: "http://mcp:3333/health", options: {} },
      {
        url: "http://anythingllm:3001/api/v1/workspace/obsidian/vector-search",
        options: {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: "Bearer key",
          },
          body: JSON.stringify({ query: "doctor", topN: 1 }),
        },
      },
    ]);
  } finally {
    await rm(vaultPath, { force: true, recursive: true });
  }
});
```

- [ ] **Step 6: Run the worker tests to verify they pass**

Run:
```bash
node --test scripts/worker.test.mjs 2>&1 | tail -8
```
Expected: PASS — `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add scripts/doctor.mjs scripts/doctor.test.mjs scripts/worker.test.mjs
git commit -m "$(cat <<'EOF'
Harden doctor with git, mcp, embedder, and drift checks

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Compose healthchecks + readiness ordering

**Files:**
- Modify: `docker-compose.yml`

- [ ] **Step 1: Add AnythingLLM healthcheck**

In `docker-compose.yml`, under the `anythingllm` service, add after the `extra_hosts:` block:

```yaml
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://localhost:3001/api/docs',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      start_period: 60s
```

- [ ] **Step 2: Switch MCP to conditional depends_on and add its healthcheck**

Under the `mcp` service, replace:

```yaml
    depends_on:
      - anythingllm
```

with:

```yaml
    depends_on:
      anythingllm:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://localhost:3333/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      start_period: 60s
```

- [ ] **Step 3: Switch syncer to conditional depends_on**

Under the `syncer` service, replace:

```yaml
    depends_on:
      - anythingllm
```

with:

```yaml
    depends_on:
      anythingllm:
        condition: service_healthy
```

- [ ] **Step 4: Add dashboard healthcheck**

Under the `dashboard` service, add after the `volumes:` block:

```yaml
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://localhost:3000/',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      start_period: 60s
```

- [ ] **Step 5: Validate the compose file**

Run:
```bash
docker compose config >/dev/null && echo OK
```
Expected: `OK` (no YAML / interpolation errors).

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml
git commit -m "$(cat <<'EOF'
Add service healthchecks and wait for AnythingLLM readiness

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Full suite green + final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the entire test suite**

Run:
```bash
node --test scripts/*.test.mjs dashboard/*.test.mjs dashboard/public/*.test.mjs 2>&1 | tail -12
```
Expected: `# fail 0` (previous 53 plus the new doctor tests + the embeddableVaultFiles test).

- [ ] **Step 2: Smoke-test doctor against a running stack (optional, manual)**

If the stack is up (`docker compose up -d`), run:
```bash
docker compose run --rm worker doctor
```
Expected: JSON with 7 checks; the `ok` flag reflects the live state. (If the stack is not running, skip — the unit tests cover the logic.)

- [ ] **Step 3: Confirm branch state**

Run:
```bash
git log --oneline main..HEAD
git status
```
Expected: four commits on `feature/doctor-and-healthchecks` ahead of `main`; clean working tree (the earlier `pt.1` `docker-compose.yml` localhost-binding edit is folded into this branch's history).

---

## Self-Review

**Spec coverage:**
- Git token check → Task 3 (`git remote`).
- MCP reachable → Task 3 (`mcp health`) + config field in Task 1.
- Embedder canary (vector-search HTTP status) → Task 3 (`embedder probe`).
- Index drift (manifest vs vault, up-to-5 missing, empty-vault healthy) → Task 3 (`index drift`).
- `kbStateDir` in `resolveConfig` → Task 1; resolved identically to embed-vault's `extendConfig` → Task 3 `manifestPath`.
- Shared `listVaultFiles`/defaults (refined to `embeddableVaultFiles` + constants) → Task 2.
- Injectable `runGit` / `readManifest` → Task 3.
- Three healthchecks using node `http` → Task 4.
- `mcp` + `syncer` `condition: service_healthy` → Task 4.
- No syncer healthcheck, no disk check, no backup — consistent with Non-goals.

**Placeholder scan:** none — every code step contains complete code.

**Type/name consistency:** `runGit` returns `{ ok, code, stdout, stderr }` consistently across doctor.mjs, doctor.test.mjs, and worker.test.mjs. `readManifest` returns `{ files }` consistently. `embeddableVaultFiles(vaultPath, { extensions, excludeDirs })` matches across embed-vault.mjs and doctor.mjs. Check names (`git remote`, `mcp health`, `embedder probe`, `index drift`) match between doctor.mjs and both test files.
