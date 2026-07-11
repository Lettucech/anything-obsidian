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
