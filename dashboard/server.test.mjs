import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
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
  assert.deepEqual(response.body.services.map((service) => service.id), ["anythingllm", "mcp", "syncer"]);
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

test("actions return conflict when job preconditions fail", async () => {
  const app = createDashboardServer({
    docker: fakeDocker(),
    jobs: {
      latest: () => null,
      get: () => null,
      async start() {
        throw new Error("Embed changed requires AnythingLLM to be running");
      },
    },
    env: {},
  });

  const response = await request(app, "POST", "/api/actions/embed");

  assert.equal(response.status, 409);
  assert.match(response.body.error, /requires AnythingLLM/);
});

test("static files do not serve traversal-looking paths", async () => {
  const app = createDashboardServer({ docker: fakeDocker(), jobs: fakeJobs(), env: {} });

  const response = await request(app, "GET", "/..%2fserver.mjs");

  assert.equal([403, 404].includes(response.status), true);
  assert.notEqual(response.body, "#!/usr/bin/env node");
});

test("static files return not found instead of server error", async () => {
  const app = createDashboardServer({ docker: fakeDocker(), jobs: fakeJobs(), env: {} });

  const response = await request(app, "GET", "/missing.css");

  assert.equal(response.status, 404);
  assert.match(response.body.error, /Not found/);
});

function fakeDocker({ running = new Set() } = {}) {
  return {
    started: [],
    stopped: [],
    async inspectContainer(name) {
      return {
        found: true,
        id: `container-${name}`,
        name,
        state: running.has(name) ? "running" : "exited",
        running: running.has(name),
      };
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
  return await new Promise((resolve) => {
    const chunks = [];
    const req = new Readable({
      read() {
        this.push(null);
      },
    });
    req.method = method;
    req.url = path;

    const res = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    res.writeHead = (status, headers) => {
      res.statusCode = status;
      res.headers = headers;
      return res;
    };
    res.end = (chunk) => {
      if (chunk) chunks.push(Buffer.from(chunk));
      resolve({
        status: res.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      return res;
    };

    server.emit("request", req, res);
  });
}
