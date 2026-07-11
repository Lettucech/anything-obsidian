# Dashboard Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local web dashboard that stays running while it monitors, starts, stops, and repairs the rest of the `anything-obsidian` Docker stack.

**Architecture:** Add a small dependency-free Node dashboard service with a narrow HTTP API and static frontend. The backend talks to Docker through `/var/run/docker.sock`, but all project operations go through hardcoded allowlists for the three controlled services and four worker commands. Worker actions create fixed one-shot containers using the existing worker image, vault mount, worker state volume, `.env` mount, and Compose project network.

**Tech Stack:** Node 22 ES modules, `node:test`, Docker Engine API over Unix socket, vanilla HTML/CSS/JS, Docker Compose.

## Global Constraints

- Dashboard starts by default with `docker compose up -d`.
- Dashboard remains running when the controlled system is off.
- System off stops only `anything-obsidian-anythingllm`, `anything-obsidian-mcp`, and `anything-obsidian-syncer`.
- System off must not remove volumes, vault data, Git data, or Docker images.
- Dashboard host port binds to `127.0.0.1`.
- Dashboard API must not accept arbitrary Docker commands, images, paths, bind mounts, or container names from the browser.
- Allowed service ids are exactly `anythingllm`, `mcp`, and `syncer`.
- Allowed worker commands are exactly `sync`, `embed`, `embed --all`, and `doctor`.
- Do not edit `.env` from the dashboard.
- Do not store or display `ANYTHINGLLM_API_KEY`, `KB_GIT_AUTH_TOKEN`, or `GIT_PASSWORD`.
- Preserve the invariant: Git is the source of truth; AnythingLLM is a derived local index.

---

## File Structure

- Create `dashboard/config.mjs`: shared constants, allowlists, system state classification, public config summary, service preconditions.
- Create `dashboard/redact.mjs`: secret redaction utilities used for logs and config text.
- Create `dashboard/docker-client.mjs`: minimal Docker Engine API client over the Unix socket.
- Create `dashboard/jobs.mjs`: one-shot worker job manager with a one-job-at-a-time guard.
- Create `dashboard/server.mjs`: HTTP API, static file serving, route validation, JSON responses.
- Create `dashboard/public/index.html`: dashboard app markup.
- Create `dashboard/public/styles.css`: dense operational layout.
- Create `dashboard/public/app.js`: polling UI, action buttons, logs, and power control.
- Create `docker/dashboard/Dockerfile`: dashboard runtime image.
- Modify `docker-compose.yml`: add `dashboard`, expose `HOST_DASHBOARD_PORT`, mount Docker socket, add labels or env values needed by worker jobs.
- Modify `.env.example`: add `HOST_DASHBOARD_PORT=11300`.
- Modify `README.md`: document dashboard URL, system on/off, Docker socket note, and remaining CLI fallback.
- Add tests beside dashboard modules as `dashboard/*.test.mjs`.

---

### Task 1: Dashboard Domain Constants, Redaction, And State Rules

**Files:**
- Create: `dashboard/config.mjs`
- Create: `dashboard/redact.mjs`
- Test: `dashboard/config.test.mjs`
- Test: `dashboard/redact.test.mjs`

**Interfaces:**
- Produces: `CONTROLLED_SERVICES: Record<string, { id, name, label, health?: { url, okStatus } }>`
- Produces: `LOG_SERVICES: Record<string, { id, name, label }>`
- Produces: `WORKER_ACTIONS: Record<string, { id, label, command, requiresAnythingLLM }>`
- Produces: `classifySystemState(services: Array<{ id: string, found: boolean, running: boolean }>): "on" | "off" | "partial"`
- Produces: `publicConfig(env: Record<string, string | undefined>): object`
- Produces: `redactSecretsText(value: string): string`
- Produces: `redactSecretsObject(value: unknown): unknown`

- [ ] **Step 1: Write failing tests for allowlists and system states**

Create `dashboard/config.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROLLED_SERVICES,
  LOG_SERVICES,
  WORKER_ACTIONS,
  classifySystemState,
  publicConfig,
} from "./config.mjs";

test("controlled service allowlist contains only project services", () => {
  assert.deepEqual(Object.keys(CONTROLLED_SERVICES).sort(), ["anythingllm", "mcp", "syncer"]);
  assert.equal(CONTROLLED_SERVICES.anythingllm.name, "anything-obsidian-anythingllm");
  assert.equal(CONTROLLED_SERVICES.mcp.name, "anything-obsidian-mcp");
  assert.equal(CONTROLLED_SERVICES.syncer.name, "anything-obsidian-syncer");
});

test("log service allowlist does not accept arbitrary names", () => {
  assert.deepEqual(Object.keys(LOG_SERVICES).sort(), ["anythingllm", "mcp", "syncer"]);
  assert.equal(LOG_SERVICES.syncer.name, "anything-obsidian-syncer");
  assert.equal(LOG_SERVICES["/var/run/docker.sock"], undefined);
});

test("worker action allowlist maps to exact worker commands", () => {
  assert.deepEqual(Object.keys(WORKER_ACTIONS).sort(), ["doctor", "embed", "embed-all", "sync"]);
  assert.deepEqual(WORKER_ACTIONS.sync.command, ["sync"]);
  assert.deepEqual(WORKER_ACTIONS.embed.command, ["embed"]);
  assert.deepEqual(WORKER_ACTIONS["embed-all"].command, ["embed", "--all"]);
  assert.deepEqual(WORKER_ACTIONS.doctor.command, ["doctor"]);
  assert.equal(WORKER_ACTIONS.doctor.requiresAnythingLLM, false);
  assert.equal(WORKER_ACTIONS.sync.requiresAnythingLLM, true);
});

test("classifies on off and partial states", () => {
  const allRunning = [
    { id: "anythingllm", found: true, running: true },
    { id: "mcp", found: true, running: true },
    { id: "syncer", found: true, running: true },
  ];
  const allStopped = [
    { id: "anythingllm", found: true, running: false },
    { id: "mcp", found: true, running: false },
    { id: "syncer", found: false, running: false },
  ];
  const mixed = [
    { id: "anythingllm", found: true, running: true },
    { id: "mcp", found: true, running: false },
    { id: "syncer", found: true, running: true },
  ];

  assert.equal(classifySystemState(allRunning), "on");
  assert.equal(classifySystemState(allStopped), "off");
  assert.equal(classifySystemState(mixed), "partial");
});

test("public config exposes only non-secret operational values", () => {
  const config = publicConfig({
    HOST_DASHBOARD_PORT: "11300",
    HOST_ANYTHINGLLM_PORT: "11301",
    HOST_MCP_PORT: "11333",
    ANYTHINGLLM_WORKSPACE_SLUG: "obsidian",
    KB_SYNC_INTERVAL_SECONDS: "300",
    KB_GIT_REMOTE: "origin",
    KB_GIT_BRANCH: "main",
    ANYTHINGLLM_API_KEY: "sk-secret",
    KB_GIT_AUTH_TOKEN: "ghp-secret",
  });

  assert.deepEqual(config, {
    dashboardUrl: "http://localhost:11300",
    anythingllmUrl: "http://localhost:11301",
    mcpUrl: "http://localhost:11333/mcp",
    workspaceSlug: "obsidian",
    syncIntervalSeconds: "300",
    gitRemote: "origin",
    gitBranch: "main",
  });
});
```

- [ ] **Step 2: Write failing tests for secret redaction**

Create `dashboard/redact.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

import { redactSecretsObject, redactSecretsText } from "./redact.mjs";

test("redacts known secret env assignments in text", () => {
  const text = [
    "ANYTHINGLLM_API_KEY=sk-secret",
    "KB_GIT_AUTH_TOKEN=ghp-secret",
    "GIT_PASSWORD=token-secret",
    "KB_GIT_BRANCH=main",
  ].join("\n");

  assert.equal(
    redactSecretsText(text),
    [
      "ANYTHINGLLM_API_KEY=[redacted]",
      "KB_GIT_AUTH_TOKEN=[redacted]",
      "GIT_PASSWORD=[redacted]",
      "KB_GIT_BRANCH=main",
    ].join("\n"),
  );
});

test("redacts nested secret object keys", () => {
  assert.deepEqual(
    redactSecretsObject({
      config: {
        ANYTHINGLLM_API_KEY: "sk-secret",
        KB_GIT_AUTH_TOKEN: "ghp-secret",
        KB_GIT_BRANCH: "main",
      },
      logs: ["GIT_PASSWORD=token-secret"],
    }),
    {
      config: {
        ANYTHINGLLM_API_KEY: "[redacted]",
        KB_GIT_AUTH_TOKEN: "[redacted]",
        KB_GIT_BRANCH: "main",
      },
      logs: ["GIT_PASSWORD=[redacted]"],
    },
  );
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
node --test dashboard/config.test.mjs dashboard/redact.test.mjs
```

Expected: FAIL with module not found for `dashboard/config.mjs` and `dashboard/redact.mjs`.

- [ ] **Step 4: Implement domain constants and redaction**

Create `dashboard/config.mjs`:

```js
export const CONTROLLED_SERVICES = Object.freeze({
  anythingllm: Object.freeze({
    id: "anythingllm",
    name: "anything-obsidian-anythingllm",
    label: "AnythingLLM",
    health: Object.freeze({ url: "http://anythingllm:3001/api/docs", okStatus: 200 }),
  }),
  mcp: Object.freeze({
    id: "mcp",
    name: "anything-obsidian-mcp",
    label: "MCP",
    health: Object.freeze({ url: "http://mcp:3333/health", okStatus: 200 }),
  }),
  syncer: Object.freeze({
    id: "syncer",
    name: "anything-obsidian-syncer",
    label: "Syncer",
  }),
});

export const LOG_SERVICES = Object.freeze({
  anythingllm: CONTROLLED_SERVICES.anythingllm,
  mcp: CONTROLLED_SERVICES.mcp,
  syncer: CONTROLLED_SERVICES.syncer,
});

export const WORKER_ACTIONS = Object.freeze({
  sync: Object.freeze({
    id: "sync",
    label: "Sync now",
    command: Object.freeze(["sync"]),
    requiresAnythingLLM: true,
  }),
  embed: Object.freeze({
    id: "embed",
    label: "Embed changed",
    command: Object.freeze(["embed"]),
    requiresAnythingLLM: true,
  }),
  "embed-all": Object.freeze({
    id: "embed-all",
    label: "Rebuild index",
    command: Object.freeze(["embed", "--all"]),
    requiresAnythingLLM: true,
  }),
  doctor: Object.freeze({
    id: "doctor",
    label: "Run doctor",
    command: Object.freeze(["doctor"]),
    requiresAnythingLLM: false,
  }),
});

export function classifySystemState(services) {
  const running = services.filter((service) => service.found && service.running).length;
  if (running === services.length) return "on";
  if (running === 0) return "off";
  return "partial";
}

export function publicConfig(env) {
  const dashboardPort = env.HOST_DASHBOARD_PORT || "11300";
  const anythingllmPort = env.HOST_ANYTHINGLLM_PORT || "11301";
  const mcpPort = env.HOST_MCP_PORT || "11333";

  return {
    dashboardUrl: `http://localhost:${dashboardPort}`,
    anythingllmUrl: `http://localhost:${anythingllmPort}`,
    mcpUrl: `http://localhost:${mcpPort}/mcp`,
    workspaceSlug: env.ANYTHINGLLM_WORKSPACE_SLUG || "obsidian",
    syncIntervalSeconds: env.KB_SYNC_INTERVAL_SECONDS || "300",
    gitRemote: env.KB_GIT_REMOTE || "origin",
    gitBranch: env.KB_GIT_BRANCH || "main",
  };
}
```

Create `dashboard/redact.mjs`:

```js
const SECRET_KEYS = new Set(["ANYTHINGLLM_API_KEY", "KB_GIT_AUTH_TOKEN", "GIT_PASSWORD"]);

export function redactSecretsText(value) {
  return String(value).replace(
    /\b(ANYTHINGLLM_API_KEY|KB_GIT_AUTH_TOKEN|GIT_PASSWORD)=([^\s\r\n]*)/g,
    "$1=[redacted]",
  );
}

export function redactSecretsObject(value) {
  if (Array.isArray(value)) return value.map((item) => redactSecretsObject(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_KEYS.has(key) ? "[redacted]" : redactSecretsObject(item),
      ]),
    );
  }
  if (typeof value === "string") return redactSecretsText(value);
  return value;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run:

```bash
node --test dashboard/config.test.mjs dashboard/redact.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add dashboard/config.mjs dashboard/redact.mjs dashboard/config.test.mjs dashboard/redact.test.mjs
git commit -m "Add dashboard domain rules"
```

---

### Task 2: Docker API Client And Service Controls

**Files:**
- Create: `dashboard/docker-client.mjs`
- Test: `dashboard/docker-client.test.mjs`

**Interfaces:**
- Consumes: `CONTROLLED_SERVICES` names from `dashboard/config.mjs`
- Produces: `DockerClient` with methods:
  - `inspectContainer(name: string): Promise<{ found, id?, name, state, running, status }>`
  - `inspectContainerDetails(name: string): Promise<object>`
  - `startContainer(name: string): Promise<void>`
  - `stopContainer(name: string): Promise<void>`
  - `containerLogs(name: string, options?: { tail?: number }): Promise<string>`
  - `createContainer(body: object): Promise<{ Id: string }>`
  - `startContainerById(id: string): Promise<void>`
  - `waitContainer(id: string): Promise<{ StatusCode: number }>`
  - `removeContainer(id: string): Promise<void>`

- [ ] **Step 1: Write failing Docker client tests**

Create `dashboard/docker-client.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

import { DockerClient, encodeContainerName } from "./docker-client.mjs";

test("encodes container names for Docker API paths", () => {
  assert.equal(encodeContainerName("anything-obsidian-syncer"), "anything-obsidian-syncer");
  assert.equal(encodeContainerName("name with spaces"), "name%20with%20spaces");
});

test("inspectContainer maps 404 to found false", async () => {
  const client = new DockerClient({
    request: async () => ({ statusCode: 404, body: { message: "No such container" } }),
  });

  assert.deepEqual(await client.inspectContainer("anything-obsidian-syncer"), {
    found: false,
    name: "anything-obsidian-syncer",
    state: "missing",
    running: false,
    status: "missing",
  });
});

test("inspectContainer maps Docker state", async () => {
  const client = new DockerClient({
    request: async () => ({
      statusCode: 200,
      body: {
        Id: "abc123",
        Name: "/anything-obsidian-syncer",
        State: { Status: "running", Running: true },
      },
    }),
  });

  assert.deepEqual(await client.inspectContainer("anything-obsidian-syncer"), {
    found: true,
    id: "abc123",
    name: "anything-obsidian-syncer",
    state: "running",
    running: true,
    status: "running",
  });
});

test("start stop and logs use exact Docker API endpoints", async () => {
  const calls = [];
  const client = new DockerClient({
    request: async (options) => {
      calls.push(options);
      if (options.path.includes("/logs")) return { statusCode: 200, body: "hello\n" };
      return { statusCode: 204, body: "" };
    },
  });

  await client.startContainer("anything-obsidian-syncer");
  await client.stopContainer("anything-obsidian-syncer");
  assert.equal(await client.containerLogs("anything-obsidian-syncer", { tail: 25 }), "hello\n");

  assert.deepEqual(calls, [
    {
      method: "POST",
      path: "/containers/anything-obsidian-syncer/start",
      socketPath: "/var/run/docker.sock",
    },
    {
      method: "POST",
      path: "/containers/anything-obsidian-syncer/stop?t=10",
      socketPath: "/var/run/docker.sock",
    },
    {
      method: "GET",
      path: "/containers/anything-obsidian-syncer/logs?stdout=1&stderr=1&tail=25",
      socketPath: "/var/run/docker.sock",
    },
  ]);
});

test("inspectContainerDetails returns raw Docker inspect payload", async () => {
  const client = new DockerClient({
    request: async () => ({
      statusCode: 200,
      body: {
        Id: "syncer123",
        Config: { Image: "anything-obsidian-worker" },
        HostConfig: { NetworkMode: "anything-obsidian_default" },
        Mounts: [{ Source: "/repo/.env", Destination: "/workspace/.env" }],
      },
    }),
  });

  assert.equal((await client.inspectContainerDetails("anything-obsidian-syncer")).Id, "syncer123");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test dashboard/docker-client.test.mjs
```

Expected: FAIL with module not found for `dashboard/docker-client.mjs`.

- [ ] **Step 3: Implement Docker client**

Create `dashboard/docker-client.mjs`:

```js
import http from "node:http";

const DEFAULT_SOCKET = "/var/run/docker.sock";

export function encodeContainerName(name) {
  return encodeURIComponent(name);
}

export class DockerClient {
  constructor({ socketPath = DEFAULT_SOCKET, request = dockerRequest } = {}) {
    this.socketPath = socketPath;
    this.request = request;
  }

  async inspectContainer(name) {
    const response = await this.request({
      method: "GET",
      path: `/containers/${encodeContainerName(name)}/json`,
      socketPath: this.socketPath,
    });

    if (response.statusCode === 404) {
      return { found: false, name, state: "missing", running: false, status: "missing" };
    }
    ensureOk(response, `inspect ${name}`);

    const state = response.body.State || {};
    return {
      found: true,
      id: response.body.Id,
      name: String(response.body.Name || `/${name}`).replace(/^\//, ""),
      state: state.Status || "unknown",
      running: Boolean(state.Running),
      status: state.Status || "unknown",
    };
  }

  async inspectContainerDetails(name) {
    const response = await this.request({
      method: "GET",
      path: `/containers/${encodeContainerName(name)}/json`,
      socketPath: this.socketPath,
    });
    ensureOk(response, `inspect details ${name}`);
    return response.body;
  }

  async startContainer(name) {
    const response = await this.request({
      method: "POST",
      path: `/containers/${encodeContainerName(name)}/start`,
      socketPath: this.socketPath,
    });
    if (![204, 304].includes(response.statusCode)) ensureOk(response, `start ${name}`);
  }

  async stopContainer(name) {
    const response = await this.request({
      method: "POST",
      path: `/containers/${encodeContainerName(name)}/stop?t=10`,
      socketPath: this.socketPath,
    });
    if (![204, 304].includes(response.statusCode)) ensureOk(response, `stop ${name}`);
  }

  async containerLogs(name, { tail = 300 } = {}) {
    const response = await this.request({
      method: "GET",
      path: `/containers/${encodeContainerName(name)}/logs?stdout=1&stderr=1&tail=${Number(tail)}`,
      socketPath: this.socketPath,
    });
    ensureOk(response, `logs ${name}`);
    return typeof response.body === "string" ? response.body : JSON.stringify(response.body);
  }

  async createContainer(body) {
    const response = await this.request({
      method: "POST",
      path: "/containers/create",
      socketPath: this.socketPath,
      body,
    });
    ensureOk(response, "create worker container");
    return response.body;
  }

  async startContainerById(id) {
    const response = await this.request({
      method: "POST",
      path: `/containers/${encodeContainerName(id)}/start`,
      socketPath: this.socketPath,
    });
    if (![204, 304].includes(response.statusCode)) ensureOk(response, `start ${id}`);
  }

  async waitContainer(id) {
    const response = await this.request({
      method: "POST",
      path: `/containers/${encodeContainerName(id)}/wait`,
      socketPath: this.socketPath,
    });
    ensureOk(response, `wait ${id}`);
    return response.body;
  }

  async removeContainer(id) {
    const response = await this.request({
      method: "DELETE",
      path: `/containers/${encodeContainerName(id)}?force=1`,
      socketPath: this.socketPath,
    });
    if (![204, 404].includes(response.statusCode)) ensureOk(response, `remove ${id}`);
  }
}

function ensureOk(response, label) {
  if (response.statusCode >= 200 && response.statusCode < 300) return;
  const message = response.body?.message || response.body || `HTTP ${response.statusCode}`;
  throw new Error(`Docker ${label} failed: ${message}`);
}

async function dockerRequest({ method, path, socketPath = DEFAULT_SOCKET, body }) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        method,
        path,
        headers: payload
          ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
          : undefined,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const contentType = res.headers["content-type"] || "";
          const parsed = contentType.includes("application/json") && text ? JSON.parse(text) : text;
          resolve({ statusCode: res.statusCode || 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
```

- [ ] **Step 4: Run Docker client tests**

Run:

```bash
node --test dashboard/docker-client.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/docker-client.mjs dashboard/docker-client.test.mjs
git commit -m "Add dashboard Docker client"
```

---

### Task 3: Worker Job Manager

**Files:**
- Create: `dashboard/jobs.mjs`
- Test: `dashboard/jobs.test.mjs`

**Interfaces:**
- Consumes: `WORKER_ACTIONS` from `dashboard/config.mjs`
- Consumes: `DockerClient` methods from `dashboard/docker-client.mjs`
- Produces: `createJobManager({ docker, now }): { start(actionId, serviceSnapshot), get(id), latest(), list() }`
- `start(actionId, serviceSnapshot)` returns `{ id, actionId, status }`
- Job statuses are `queued`, `running`, `succeeded`, `failed`

- [ ] **Step 1: Write failing worker job tests**

Create `dashboard/jobs.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

import { createJobManager } from "./jobs.mjs";

test("rejects unknown worker actions", async () => {
  const manager = createJobManager({ docker: fakeDocker(), now: () => 1 });
  await assert.rejects(() => manager.start("rm-all", []), /Unknown action/);
});

test("prevents duplicate active jobs", async () => {
  const docker = fakeDocker({ wait: new Promise(() => {}) });
  const manager = createJobManager({ docker, now: () => 1 });

  await manager.start("doctor", []);
  await assert.rejects(() => manager.start("doctor", []), /already running/);
});

test("blocks embed action when AnythingLLM is not running", async () => {
  const manager = createJobManager({ docker: fakeDocker(), now: () => 1 });

  await assert.rejects(
    () => manager.start("embed", [{ id: "anythingllm", running: false }]),
    /requires AnythingLLM/,
  );
});

test("doctor can run while AnythingLLM is stopped", async () => {
  const docker = fakeDocker();
  const manager = createJobManager({ docker, now: () => 1 });

  const job = await manager.start("doctor", [{ id: "anythingllm", running: false }]);
  await settle();

  assert.equal(job.actionId, "doctor");
  assert.equal(manager.get(job.id).status, "succeeded");
  assert.deepEqual(docker.created[0].Cmd, ["doctor"]);
});

test("creates fixed worker container config for embed all", async () => {
  const docker = fakeDocker();
  const manager = createJobManager({
    docker,
    now: () => 1,
  });

  await manager.start("embed-all", [{ id: "anythingllm", running: true }]);
  await settle();

  assert.equal(docker.created.length, 1);
  assert.deepEqual(docker.created[0].Cmd, ["embed", "--all"]);
  assert.equal(docker.created[0].Image, "anything-obsidian-worker");
  assert.deepEqual(docker.created[0].HostConfig.Binds, [
    "/repo/.env:/workspace/.env:ro",
    "/Users/me/vault:/vault",
    "anything-obsidian-worker-state:/workspace/.anything-obsidian-state",
  ]);
  assert.equal(docker.created[0].HostConfig.NetworkMode, "anything-obsidian_default");
  assert.deepEqual(docker.created[0].Env, [
    "ANYTHINGLLM_BASE_URL=http://anythingllm:3001",
    "VAULT_PATH=/vault",
  ]);
});

function fakeDocker({ wait = Promise.resolve({ StatusCode: 0 }) } = {}) {
  return {
    created: [],
    async inspectContainerDetails(name) {
      assert.equal(name, "anything-obsidian-syncer");
      return {
        Config: {
          Image: "anything-obsidian-worker",
          Env: ["ANYTHINGLLM_BASE_URL=http://anythingllm:3001", "VAULT_PATH=/vault"],
        },
        HostConfig: {
          NetworkMode: "anything-obsidian_default",
        },
        Mounts: [
          { Type: "bind", Source: "/repo/.env", Destination: "/workspace/.env", Mode: "ro", RW: false },
          { Type: "bind", Source: "/Users/me/vault", Destination: "/vault", Mode: "rw", RW: true },
          {
            Type: "volume",
            Name: "anything-obsidian-worker-state",
            Destination: "/workspace/.anything-obsidian-state",
            Mode: "rw",
            RW: true,
          },
        ],
      };
    },
    async createContainer(body) {
      this.created.push(body);
      return { Id: "job123" };
    },
    async startContainerById() {},
    async waitContainer() {
      return await wait;
    },
    async containerLogs() {
      return "[anything-obsidian-worker] done";
    },
    async removeContainer() {},
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test dashboard/jobs.test.mjs
```

Expected: FAIL with module not found for `dashboard/jobs.mjs`.

- [ ] **Step 3: Implement job manager**

Create `dashboard/jobs.mjs`:

```js
import { randomUUID } from "node:crypto";

import { WORKER_ACTIONS } from "./config.mjs";
import { redactSecretsText } from "./redact.mjs";

const PROJECT_NAME = "anything-obsidian";
const WORKER_IMAGE = "anything-obsidian-worker";

export function createJobManager({ docker, now = Date.now } = {}) {
  const jobs = new Map();
  let activeJobId = null;

  return {
    async start(actionId, serviceSnapshot = []) {
      const action = WORKER_ACTIONS[actionId];
      if (!action) throw new Error(`Unknown action: ${actionId}`);
      if (activeJobId) throw new Error(`A worker job is already running: ${activeJobId}`);
      if (action.requiresAnythingLLM && !isRunning(serviceSnapshot, "anythingllm")) {
        throw new Error(`${action.label} requires AnythingLLM to be running`);
      }

      const id = `job-${now()}-${randomUUID().slice(0, 8)}`;
      const job = {
        id,
        actionId,
        label: action.label,
        status: "queued",
        startedAt: new Date(now()).toISOString(),
        finishedAt: null,
        exitCode: null,
        logs: "",
        error: null,
      };
      jobs.set(id, job);
      activeJobId = id;

      runJob({ docker, job, action })
        .catch((error) => {
          job.status = "failed";
          job.error = error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
          job.finishedAt = new Date(now()).toISOString();
          activeJobId = null;
        });

      return job;
    },
    get(id) {
      return jobs.get(id) || null;
    },
    latest() {
      return Array.from(jobs.values()).at(-1) || null;
    },
    list() {
      return Array.from(jobs.values());
    },
  };
}

async function runJob({ docker, job, action }) {
  job.status = "running";
  const syncer = await docker.inspectContainerDetails("anything-obsidian-syncer");
  const container = await docker.createContainer(workerContainerConfig({ syncer, action }));
  try {
    await docker.startContainerById(container.Id);
    const result = await docker.waitContainer(container.Id);
    job.exitCode = result.StatusCode;
    job.logs = redactSecretsText(await docker.containerLogs(container.Id, { tail: 500 }));
    job.status = result.StatusCode === 0 ? "succeeded" : "failed";
    if (job.status === "failed") job.error = `Worker exited with ${result.StatusCode}`;
  } finally {
    await docker.removeContainer(container.Id);
  }
}

export function workerContainerConfig({ syncer, action }) {
  return {
    Image: syncer.Config?.Image || WORKER_IMAGE,
    Cmd: [...action.command],
    Env: workerEnv(syncer.Config?.Env || []),
    HostConfig: {
      AutoRemove: false,
      NetworkMode: syncer.HostConfig?.NetworkMode || `${PROJECT_NAME}_default`,
      Binds: workerBinds(syncer.Mounts || []),
    },
  };
}

function workerEnv(envValues) {
  const allowed = new Set(["ANYTHINGLLM_BASE_URL", "VAULT_PATH"]);
  return envValues.filter((entry) => allowed.has(entry.split("=")[0]));
}

function workerBinds(mounts) {
  const destinations = new Set(["/workspace/.env", "/vault", "/workspace/.anything-obsidian-state"]);
  return mounts
    .filter((mount) => destinations.has(mount.Destination))
    .map((mount) => {
      const source = mount.Type === "volume" ? mount.Name : mount.Source;
      const mode = mount.Destination === "/workspace/.env" ? ":ro" : "";
      return `${source}:${mount.Destination}${mode}`;
    });
}

function isRunning(services, id) {
  return services.some((service) => service.id === id && service.running);
}
```

- [ ] **Step 4: Run job manager tests**

Run:

```bash
node --test dashboard/jobs.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/jobs.mjs dashboard/jobs.test.mjs
git commit -m "Add dashboard worker jobs"
```

---

### Task 4: Dashboard HTTP API

**Files:**
- Create: `dashboard/server.mjs`
- Test: `dashboard/server.test.mjs`

**Interfaces:**
- Consumes: `CONTROLLED_SERVICES`, `LOG_SERVICES`, `WORKER_ACTIONS`, `classifySystemState`, `publicConfig`
- Consumes: `DockerClient`
- Consumes: `createJobManager`
- Produces: `createDashboardServer({ docker, jobs, env, fetchImpl }): http.Server`
- Produces API endpoints from the spec:
  - `GET /api/status`
  - `POST /api/system/on`
  - `POST /api/system/off`
  - `GET /api/logs?service=syncer`
  - `POST /api/actions/sync`
  - `POST /api/actions/embed`
  - `POST /api/actions/embed-all`
  - `POST /api/actions/doctor`
  - `GET /api/actions/:id`

- [ ] **Step 1: Write failing API server tests**

Create `dashboard/server.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

import { createDashboardServer } from "./server.mjs";

test("status returns classified system state and public config", async () => {
  const app = createDashboardServer({
    docker: fakeDocker({ running: new Set(["anything-obsidian-anythingllm"]) }),
    jobs: fakeJobs(),
    env: { HOST_DASHBOARD_PORT: "11300", HOST_ANYTHINGLLM_PORT: "11301" },
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });

  const response = await request(app, "GET", "/api/status");

  assert.equal(response.status, 200);
  assert.equal(response.body.systemState, "partial");
  assert.equal(response.body.services.length, 3);
  assert.equal(response.body.config.dashboardUrl, "http://localhost:11300");
});

test("system off stops only controlled services", async () => {
  const docker = fakeDocker({ running: new Set(["anything-obsidian-anythingllm"]) });
  const app = createDashboardServer({ docker, jobs: fakeJobs(), env: {} });

  const response = await request(app, "POST", "/api/system/off");

  assert.equal(response.status, 200);
  assert.deepEqual(docker.stopped, [
    "anything-obsidian-anythingllm",
    "anything-obsidian-mcp",
    "anything-obsidian-syncer",
  ]);
  assert.equal(docker.stopped.includes("anything-obsidian-dashboard"), false);
});

test("system on starts only controlled services", async () => {
  const docker = fakeDocker();
  const app = createDashboardServer({ docker, jobs: fakeJobs(), env: {} });

  const response = await request(app, "POST", "/api/system/on");

  assert.equal(response.status, 200);
  assert.deepEqual(docker.started, [
    "anything-obsidian-anythingllm",
    "anything-obsidian-mcp",
    "anything-obsidian-syncer",
  ]);
});

test("logs reject unknown service ids", async () => {
  const app = createDashboardServer({ docker: fakeDocker(), jobs: fakeJobs(), env: {} });

  const response = await request(app, "GET", "/api/logs?service=/var/run/docker.sock");

  assert.equal(response.status, 400);
  assert.match(response.body.error, /Unknown log service/);
});

test("actions reject unknown action ids and start allowed jobs", async () => {
  const jobs = fakeJobs();
  const app = createDashboardServer({
    docker: fakeDocker({ running: new Set(["anything-obsidian-anythingllm"]) }),
    jobs,
    env: {},
  });

  assert.equal((await request(app, "POST", "/api/actions/rm-all")).status, 404);
  const response = await request(app, "POST", "/api/actions/doctor");
  assert.equal(response.status, 202);
  assert.equal(response.body.actionId, "doctor");
});

function fakeDocker({ running = new Set() } = {}) {
  return {
    started: [],
    stopped: [],
    async inspectContainer(name) {
      return { found: true, name, state: running.has(name) ? "running" : "exited", running: running.has(name) };
    },
    async startContainer(name) {
      this.started.push(name);
    },
    async stopContainer(name) {
      this.stopped.push(name);
    },
    async containerLogs() {
      return "ANYTHINGLLM_API_KEY=[redacted]";
    },
  };
}

function fakeJobs() {
  const store = new Map();
  return {
    latest: () => null,
    get: (id) => store.get(id) || null,
    async start(actionId) {
      const job = { id: "job1", actionId, status: "queued" };
      store.set(job.id, job);
      return job;
    },
  };
}

async function request(server, method, path) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method });
    const body = await response.json();
    return { status: response.status, body };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test dashboard/server.test.mjs
```

Expected: FAIL with module not found for `dashboard/server.mjs`.

- [ ] **Step 3: Implement HTTP server**

Create `dashboard/server.mjs`:

```js
#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CONTROLLED_SERVICES, LOG_SERVICES, classifySystemState, publicConfig } from "./config.mjs";
import { DockerClient } from "./docker-client.mjs";
import { createJobManager } from "./jobs.mjs";
import { redactSecretsObject, redactSecretsText } from "./redact.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createDashboardServer({
  docker = new DockerClient(),
  jobs = createJobManager({ docker }),
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/api/status") {
        return sendJson(res, 200, await statusPayload({ docker, jobs, env, fetchImpl }));
      }
      if (req.method === "POST" && url.pathname === "/api/system/on") {
        for (const service of Object.values(CONTROLLED_SERVICES)) await docker.startContainer(service.name);
        return sendJson(res, 200, await statusPayload({ docker, jobs, env, fetchImpl }));
      }
      if (req.method === "POST" && url.pathname === "/api/system/off") {
        for (const service of Object.values(CONTROLLED_SERVICES)) await docker.stopContainer(service.name);
        return sendJson(res, 200, await statusPayload({ docker, jobs, env, fetchImpl }));
      }
      if (req.method === "GET" && url.pathname === "/api/logs") {
        const id = url.searchParams.get("service") || "";
        const service = LOG_SERVICES[id];
        if (!service) return sendJson(res, 400, { error: `Unknown log service: ${id}` });
        const logs = redactSecretsText(await docker.containerLogs(service.name, { tail: 300 }));
        return sendJson(res, 200, { service: id, logs });
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/actions/")) {
        const actionId = url.pathname.slice("/api/actions/".length);
        if (!["sync", "embed", "embed-all", "doctor"].includes(actionId)) {
          return sendJson(res, 404, { error: `Unknown action: ${actionId}` });
        }
        const snapshot = await serviceSnapshot({ docker, fetchImpl });
        const job = await jobs.start(actionId, snapshot);
        return sendJson(res, 202, job);
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/actions/")) {
        const id = url.pathname.slice("/api/actions/".length);
        const job = jobs.get(id);
        return job ? sendJson(res, 200, job) : sendJson(res, 404, { error: `Unknown job: ${id}` });
      }
      if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
        return await serveStatic(res, url.pathname);
      }
      return sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

async function statusPayload({ docker, jobs, env, fetchImpl }) {
  const services = await serviceSnapshot({ docker, fetchImpl });
  return redactSecretsObject({
    ok: true,
    systemState: classifySystemState(services),
    services,
    latestJob: jobs.latest(),
    config: publicConfig(env),
  });
}

async function serviceSnapshot({ docker, fetchImpl }) {
  return await Promise.all(
    Object.values(CONTROLLED_SERVICES).map(async (service) => {
      const inspected = await docker.inspectContainer(service.name);
      const health = inspected.running && service.health
        ? await probeHealth(fetchImpl, service.health.url, service.health.okStatus)
        : { ok: false, status: "not-running" };
      return { id: service.id, label: service.label, ...inspected, health };
    }),
  );
}

async function probeHealth(fetchImpl, url, okStatus) {
  try {
    const response = await fetchImpl(url);
    return { ok: response.status === okStatus || response.ok, status: response.status };
  } catch (error) {
    return { ok: false, status: error instanceof Error ? error.message : String(error) };
  }
}

async function serveStatic(res, pathname) {
  const file = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const fullPath = path.join(__dirname, "public", file);
  if (!fullPath.startsWith(path.join(__dirname, "public"))) return sendJson(res, 403, { error: "Forbidden" });
  const body = await readFile(fullPath);
  res.writeHead(200, { "content-type": contentType(file) });
  res.end(body);
}

function contentType(file) {
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "text/html; charset=utf-8";
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.DASHBOARD_PORT || 3000);
  createDashboardServer().listen(port, "0.0.0.0", () => {
    console.error(`[anything-obsidian-dashboard] listening on ${port}`);
  });
}
```

- [ ] **Step 4: Run API server tests**

Run:

```bash
node --test dashboard/server.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/server.mjs dashboard/server.test.mjs
git commit -m "Add dashboard API server"
```

---

### Task 5: Operational Frontend

**Files:**
- Create: `dashboard/public/index.html`
- Create: `dashboard/public/styles.css`
- Create: `dashboard/public/app.js`
- Test: `dashboard/public/app.test.mjs`

**Interfaces:**
- Consumes API payload from `GET /api/status`
- Consumes logs from `GET /api/logs?service=syncer`
- Calls `POST /api/system/on`, `POST /api/system/off`, and fixed action endpoints

- [ ] **Step 1: Write failing frontend helper tests**

Create `dashboard/public/app.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

import { actionDisabledReason, serviceTone, systemPowerLabel } from "./app.js";

test("system power label follows state", () => {
  assert.equal(systemPowerLabel("on"), "Turn Off");
  assert.equal(systemPowerLabel("off"), "Turn On");
  assert.equal(systemPowerLabel("partial"), "Repair");
});

test("service tone maps service running and health", () => {
  assert.equal(serviceTone({ running: true, health: { ok: true } }), "ok");
  assert.equal(serviceTone({ running: true, health: { ok: false } }), "warn");
  assert.equal(serviceTone({ running: false, health: { ok: false } }), "off");
});

test("action disabled reason blocks embed when AnythingLLM is off", () => {
  const status = {
    services: [{ id: "anythingllm", running: false }],
    latestJob: null,
  };

  assert.equal(actionDisabledReason("embed", status), "Turn system on first");
  assert.equal(actionDisabledReason("doctor", status), "");
});

test("action disabled reason blocks while a job is running", () => {
  const status = {
    services: [{ id: "anythingllm", running: true }],
    latestJob: { status: "running" },
  };

  assert.equal(actionDisabledReason("doctor", status), "Worker job running");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test dashboard/public/app.test.mjs
```

Expected: FAIL with module not found or missing exports for `dashboard/public/app.js`.

- [ ] **Step 3: Implement frontend helpers and UI script**

Create `dashboard/public/app.js`:

```js
const ACTIONS_REQUIRING_ANYTHINGLLM = new Set(["sync", "embed", "embed-all"]);

export function systemPowerLabel(state) {
  if (state === "on") return "Turn Off";
  if (state === "partial") return "Repair";
  return "Turn On";
}

export function serviceTone(service) {
  if (!service.running) return "off";
  return service.health?.ok ? "ok" : "warn";
}

export function actionDisabledReason(actionId, status) {
  if (status.latestJob && ["queued", "running"].includes(status.latestJob.status)) {
    return "Worker job running";
  }
  const anythingllm = status.services.find((service) => service.id === "anythingllm");
  if (ACTIONS_REQUIRING_ANYTHINGLLM.has(actionId) && !anythingllm?.running) {
    return "Turn system on first";
  }
  return "";
}

if (typeof document !== "undefined") {
  const state = { status: null, logsService: "syncer" };
  const els = {
    systemState: document.querySelector("#system-state"),
    power: document.querySelector("#power"),
    services: document.querySelector("#services"),
    actions: document.querySelector("#actions"),
    logs: document.querySelector("#logs"),
    config: document.querySelector("#config"),
    latestJob: document.querySelector("#latest-job"),
  };

  els.power.addEventListener("click", async () => {
    const endpoint = state.status.systemState === "on" ? "/api/system/off" : "/api/system/on";
    await fetch(endpoint, { method: "POST" });
    await refresh();
  });

  els.actions.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    await fetch(`/api/actions/${button.dataset.action}`, { method: "POST" });
    await refresh();
  });

  async function refresh() {
    state.status = await fetchJson("/api/status");
    renderStatus(state.status);
    const logs = await fetchJson(`/api/logs?service=${state.logsService}`);
    els.logs.textContent = logs.logs || "";
  }

  function renderStatus(status) {
    els.systemState.textContent = status.systemState;
    els.power.textContent = systemPowerLabel(status.systemState);
    els.services.innerHTML = status.services.map(renderService).join("");
    els.config.innerHTML = Object.entries(status.config)
      .map(([key, value]) => `<div><span>${escapeHtml(key)}</span><strong>${escapeHtml(value)}</strong></div>`)
      .join("");
    els.latestJob.textContent = status.latestJob
      ? `${status.latestJob.label || status.latestJob.actionId}: ${status.latestJob.status}`
      : "No dashboard worker job yet";
    for (const button of els.actions.querySelectorAll("button[data-action]")) {
      const reason = actionDisabledReason(button.dataset.action, status);
      button.disabled = Boolean(reason);
      button.title = reason;
    }
  }

  function renderService(service) {
    return `<article class="service ${serviceTone(service)}">
      <h2>${escapeHtml(service.label)}</h2>
      <p>${escapeHtml(service.status || service.state)}</p>
      <small>${escapeHtml(service.health?.ok ? "healthy" : service.health?.status || "not healthy")}</small>
    </article>`;
  }

  async function fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    return await response.json();
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[char]);
  }

  refresh();
  setInterval(refresh, 5000);
}
```

- [ ] **Step 4: Create HTML and CSS**

Create `dashboard/public/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Anything Obsidian</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <header class="topbar">
      <div>
        <h1>Anything Obsidian</h1>
        <p id="system-state">loading</p>
      </div>
      <button id="power" type="button">Loading</button>
    </header>
    <main>
      <section id="services" class="services"></section>
      <section class="toolbar" id="actions">
        <button type="button" data-action="sync">Sync now</button>
        <button type="button" data-action="embed">Embed changed</button>
        <button type="button" data-action="embed-all">Rebuild index</button>
        <button type="button" data-action="doctor">Run doctor</button>
      </section>
      <section class="workspace">
        <div class="panel">
          <h2>Activity</h2>
          <p id="latest-job">No dashboard worker job yet</p>
          <pre id="logs"></pre>
        </div>
        <aside class="panel">
          <h2>Config</h2>
          <div id="config" class="config"></div>
        </aside>
      </section>
    </main>
    <script type="module" src="/app.js"></script>
  </body>
</html>
```

Create `dashboard/public/styles.css`:

```css
:root {
  color-scheme: light;
  --bg: #f7f7f4;
  --panel: #ffffff;
  --text: #222629;
  --muted: #66706b;
  --line: #d7ddd8;
  --ok: #1f7a4d;
  --warn: #9a6200;
  --off: #697078;
  --accent: #245b73;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 18px 24px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}

h1,
h2,
p {
  margin: 0;
}

h1 {
  font-size: 20px;
}

h2 {
  font-size: 14px;
}

button {
  min-height: 36px;
  border: 1px solid var(--accent);
  border-radius: 6px;
  background: var(--accent);
  color: white;
  padding: 0 14px;
  font-weight: 650;
  cursor: pointer;
}

button:disabled {
  border-color: var(--line);
  background: #d5dad6;
  color: var(--muted);
  cursor: not-allowed;
}

main {
  padding: 20px 24px;
}

.services {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 12px;
}

.service,
.panel {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
}

.service {
  padding: 14px;
  border-left-width: 5px;
}

.service.ok {
  border-left-color: var(--ok);
}

.service.warn {
  border-left-color: var(--warn);
}

.service.off {
  border-left-color: var(--off);
}

.service p,
.service small,
.config span {
  color: var(--muted);
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 16px 0;
}

.workspace {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(260px, 340px);
  gap: 16px;
}

.panel {
  padding: 14px;
}

pre {
  min-height: 420px;
  max-height: 60vh;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #111416;
  color: #e9eee9;
  padding: 12px;
  white-space: pre-wrap;
}

.config {
  display: grid;
  gap: 10px;
}

.config div {
  display: grid;
  gap: 2px;
}

@media (max-width: 800px) {
  .topbar,
  main {
    padding-inline: 14px;
  }

  .workspace {
    grid-template-columns: 1fr;
  }
}
```

- [ ] **Step 5: Run frontend tests**

Run:

```bash
node --test dashboard/public/app.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add dashboard/public/index.html dashboard/public/styles.css dashboard/public/app.js dashboard/public/app.test.mjs
git commit -m "Add dashboard frontend"
```

---

### Task 6: Compose Integration, Docs, And Verification

**Files:**
- Create: `docker/dashboard/Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- Consumes dashboard server entrypoint: `node dashboard/server.mjs`
- Produces Compose service `dashboard` with container name `anything-obsidian-dashboard`
- Produces env knob `HOST_DASHBOARD_PORT=11300`

- [ ] **Step 1: Create dashboard Dockerfile**

Create `docker/dashboard/Dockerfile`:

```dockerfile
FROM node:22-alpine

WORKDIR /workspace

COPY dashboard ./dashboard

ENV DASHBOARD_PORT=3000

CMD ["node", "dashboard/server.mjs"]
```

- [ ] **Step 2: Modify Compose to add dashboard service**

Modify `docker-compose.yml` so the beginning of `services:` includes:

```yaml
  dashboard:
    build:
      context: .
      dockerfile: docker/dashboard/Dockerfile
    container_name: anything-obsidian-dashboard
    restart: unless-stopped
    ports:
      - "127.0.0.1:${HOST_DASHBOARD_PORT:-11300}:3000"
    environment:
      HOST_DASHBOARD_PORT: ${HOST_DASHBOARD_PORT:-11300}
      HOST_ANYTHINGLLM_PORT: ${HOST_ANYTHINGLLM_PORT:-11301}
      HOST_MCP_PORT: ${HOST_MCP_PORT:-11333}
      ANYTHINGLLM_WORKSPACE_SLUG: ${ANYTHINGLLM_WORKSPACE_SLUG:-obsidian}
      KB_SYNC_INTERVAL_SECONDS: ${KB_SYNC_INTERVAL_SECONDS:-300}
      KB_GIT_REMOTE: ${KB_GIT_REMOTE:-origin}
      KB_GIT_BRANCH: ${KB_GIT_BRANCH:-main}
      HOST_VAULT_PATH: ${HOST_VAULT_PATH:?Set HOST_VAULT_PATH in .env}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
```

Do not add `depends_on` from dashboard to the controlled services. The dashboard must be able to run while they are stopped.

- [ ] **Step 3: Ensure worker image name is stable for dashboard jobs**

Modify the existing `worker` and `syncer` build sections in `docker-compose.yml` to include:

```yaml
    image: anything-obsidian-worker
```

This gives dashboard-created one-shot worker containers a stable local image reference. Keep existing `container_name`, `volumes`, `environment`, and `command` values.

- [ ] **Step 4: Add dashboard port to `.env.example`**

Modify `.env.example` host ports:

```env
# Host ports used by Docker Compose.
HOST_DASHBOARD_PORT=11300
HOST_ANYTHINGLLM_PORT=11301
HOST_MCP_PORT=11333
```

- [ ] **Step 5: Update README daily flow**

Modify `README.md` to include:

```markdown
4. Open the dashboard.

```text
http://localhost:11300
```

The dashboard stays running even when you turn the rest of the system off. Use it to start or stop AnythingLLM, MCP, and the background syncer, view recent logs, run `doctor`, sync now, or rebuild the index.
```

Also add a short note under Daily Commands:

```markdown
Most daily commands are available from the dashboard. The CLI commands remain useful when Docker itself or the dashboard is unavailable.
```

Add a security note:

```markdown
The dashboard mounts the local Docker socket so it can control this Compose project. It binds to `127.0.0.1` by default and only exposes fixed project actions for `anythingllm`, `mcp`, `syncer`, and worker maintenance jobs.
```

- [ ] **Step 6: Run unit tests**

Run:

```bash
node --test dashboard/*.test.mjs dashboard/public/*.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Run existing worker tests**

Run:

```bash
node --test scripts/worker.test.mjs scripts/watch-vault.test.mjs scripts/embed-vault.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Run Compose config validation**

Run:

```bash
docker compose --env-file .env.example --profile tools config
```

Expected: PASS and output includes `anything-obsidian-dashboard`, `127.0.0.1:11300:3000`, and `image: anything-obsidian-worker`.

- [ ] **Step 9: Run dashboard runtime smoke checks**

Run:

```bash
docker compose up -d dashboard
curl -fsS http://localhost:11300/api/status
docker compose ps dashboard
```

Expected: dashboard container is running and `/api/status` returns JSON even if controlled services are stopped.

- [ ] **Step 10: Verify system on/off smoke path**

Run:

```bash
curl -fsS -X POST http://localhost:11300/api/system/on
docker compose ps anythingllm mcp syncer
curl -fsS -X POST http://localhost:11300/api/system/off
docker compose ps dashboard anythingllm mcp syncer
```

Expected: on starts `anythingllm`, `mcp`, and `syncer`; off stops those three; `dashboard` remains running.

- [ ] **Step 11: Verify doctor action smoke path**

Run:

```bash
curl -fsS -X POST http://localhost:11300/api/actions/doctor
curl -fsS http://localhost:11300/api/status
```

Expected: action is accepted with HTTP 202, latest job appears in status, and job result eventually reaches `succeeded` or `failed` with visible logs.

- [ ] **Step 12: Run whitespace check**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 13: Commit**

```bash
git add docker/dashboard/Dockerfile docker-compose.yml .env.example README.md
git commit -m "Wire dashboard into Docker runtime"
```
