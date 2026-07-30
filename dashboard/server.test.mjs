import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import test from "node:test";

import { createDashboardServer } from "./server.mjs";

test("vault routes clone a repository and create its managed workspace", async () => {
  const registry = fakeRegistry();
  const anythingllm = {
    async createWorkspace({ name }) {
      assert.equal(name, "Work");
      return { id: 1, name, slug: "work" };
    },
  };
  const secrets = fakeSecrets();
  const vaultStorage = fakeVaultStorage();
  const app = createDashboardServer({ docker: fakeDocker(), jobs: fakeJobs(), registry, anythingllm, vaultStorage, secrets, env: {} });

  assert.deepEqual((await request(app, "GET", "/api/vaults")).body, { vaults: [] });
  const created = await request(app, "POST", "/api/vaults", validVaultPayload());

  assert.equal(created.status, 201);
  assert.equal(created.body.id, "work");
  assert.equal(created.body.workspaceSlug, "work");
  assert.equal(created.body.gitBranch, "main");
  assert.equal(vaultStorage.cloned[0].repositoryUrl, "https://github.com/acme/work.git");
  assert.deepEqual(vaultStorage.cloned[0].gitAuth, { mode: "https-token", username: "oauth2", token: "work-secret" });
  assert.deepEqual(secrets.saved, [{ id: "work", auth: { mode: "https-token", username: "oauth2", token: "work-secret" } }]);
  assert.equal(created.body.gitAuth, undefined);
  assert.equal((await request(app, "GET", "/api/vaults")).body.vaults.length, 1);
});

test("vault routes import a local repository, attach a workspace, and remove only its registry record", async () => {
  const registry = fakeRegistry();
  const anythingllm = {
    async listWorkspaces() { return [{ id: 2, name: "Personal", slug: "personal" }]; },
  };
  const secrets = fakeSecrets();
  const app = createDashboardServer({ docker: fakeDocker(), jobs: fakeJobs(), registry, anythingllm, vaultStorage: fakeVaultStorage(), secrets, env: {} });

  const created = await request(app, "POST", "/api/vaults", {
    sourceMode: "import", id: "personal", name: "Personal", directory: "personal",
    workspaceMode: "attach", workspaceSlug: "personal", repositoryVisibility: "public",
    gitUserName: "Personal Bot", gitUserEmail: "personal@example.test",
  });
  assert.equal(created.status, 201);
  assert.equal((await request(app, "DELETE", "/api/vaults/personal")).status, 204);
  assert.deepEqual(secrets.removed, ["personal"]);
  assert.deepEqual((await request(app, "GET", "/api/vaults")).body, { vaults: [] });
});

test("vault creation requires an explicit automatic-commit identity and private HTTPS credential", async () => {
  const vaultStorage = fakeVaultStorage();
  const secrets = fakeSecrets();
  const app = createDashboardServer({
    docker: fakeDocker(), jobs: fakeJobs(), registry: fakeRegistry(),
    anythingllm: { async createWorkspace() { return { slug: "work" }; } }, vaultStorage, secrets, env: {},
  });

  const missingIdentity = await request(app, "POST", "/api/vaults", {
    ...validVaultPayload(), gitUserName: "", gitUserEmail: "",
  });
  assert.equal(missingIdentity.status, 400);
  assert.match(missingIdentity.body.error, /Git commit author name is required/);

  const missingPrivateCredential = await request(app, "POST", "/api/vaults", {
    ...validVaultPayload(), gitAuth: { mode: "https-token", username: "", token: "" },
  });
  assert.equal(missingPrivateCredential.status, 400);
  assert.match(missingPrivateCredential.body.error, /Private repositories require an HTTPS username and token/);
  assert.equal(vaultStorage.cloned.length, 0);
  assert.deepEqual(secrets.saved, []);
});

test("private local imports also require an HTTPS credential for later sync", async () => {
  const vaultStorage = fakeVaultStorage();
  const app = createDashboardServer({
    docker: fakeDocker(), jobs: fakeJobs(), registry: fakeRegistry(),
    anythingllm: { async createWorkspace() { return { slug: "work" }; } }, vaultStorage, secrets: fakeSecrets(), env: {},
  });

  const response = await request(app, "POST", "/api/vaults", {
    ...validVaultPayload(), sourceMode: "import", gitAuth: { mode: "https-token", username: "", token: "" },
  });

  assert.equal(response.status, 400);
  assert.equal(vaultStorage.imported.length, 0);
});

test("status returns classified system state and public config", async () => {
  const healthRequests = [];
  const app = createDashboardServer({
    docker: fakeDocker({
      running: new Set(["anything-obsidian-anythingllm", "anything-obsidian-mcp", "anything-obsidian-syncer"]),
    }),
    jobs: fakeJobs(),
    env: { HOST_DASHBOARD_PORT: "11300", HOST_ANYTHINGLLM_PORT: "11301" },
    fetchImpl: async (url, options) => {
      healthRequests.push({ url, options });
      return { ok: true, status: 200 };
    },
  });

  const response = await request(app, "GET", "/api/status");

  assert.equal(response.status, 200);
  assert.equal(response.body.systemState, "on");
  assert.equal(response.body.services.length, 3);
  assert.deepEqual(response.body.services.map((service) => service.id), ["anythingllm", "mcp", "syncer"]);
  assert.equal(response.body.services.find((service) => service.id === "syncer").health.ok, true);
  assert.equal(healthRequests.some((request) => request.url === "http://mcp:3333/health"), true);
  assert.equal(response.body.config.dashboardUrl, "http://localhost:11300");
});

test("system off stops all services concurrently", async () => {
  let releaseFirstStop;
  const firstStop = new Promise((resolve) => {
    releaseFirstStop = resolve;
  });
  const docker = fakeDocker({
    stopContainer: async (name) => {
      docker.stopped.push(name);
      if (name === "anything-obsidian-anythingllm") await firstStop;
    },
  });
  const app = createDashboardServer({ docker, jobs: fakeJobs(), env: {} });

  const responsePromise = request(app, "POST", "/api/system/off");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(docker.stopped, [
    "anything-obsidian-anythingllm",
    "anything-obsidian-mcp",
    "anything-obsidian-syncer",
  ]);
  releaseFirstStop();
  assert.equal((await responsePromise).status, 200);
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

test("vault actions reject unknown action ids and start an allowed scoped job", async () => {
  const jobs = fakeJobs();
  const registry = fakeRegistry();
  await registry.create({ id: "work" });
  const app = createDashboardServer({
    docker: fakeDocker({ running: new Set(["anything-obsidian-anythingllm"]) }),
    jobs,
    registry,
    env: {},
  });

  assert.equal((await request(app, "POST", "/api/vaults/work/actions/rm-all")).status, 404);
  const response = await request(app, "POST", "/api/vaults/work/actions/doctor");
  assert.equal(response.status, 202);
  assert.equal(response.body.actionId, "doctor");
});

test("actions return conflict when job preconditions fail", async () => {
  const registry = fakeRegistry();
  await registry.create({ id: "work" });
  const app = createDashboardServer({
    docker: fakeDocker(),
    jobs: {
      latest: () => null,
      get: () => null,
      async start() {
        throw new Error("Embed changed requires AnythingLLM to be running");
      },
    },
    registry,
    env: {},
  });

  const response = await request(app, "POST", "/api/vaults/work/actions/embed");

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

function fakeDocker({ running = new Set(), stopContainer } = {}) {
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
    stopContainer: stopContainer || (async function (name) {
      this.stopped.push(name);
    }),
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
    list: () => Array.from(store.values()),
    async start(vaultId, actionId) {
      const job = { id: "job1", vaultId, actionId, status: "queued" };
      store.set(job.id, job);
      return job;
    },
  };
}

function fakeRegistry() {
  const vaults = [];
  return {
    async list() { return vaults; },
    async get(id) { return vaults.find((vault) => vault.id === id) || null; },
    async create(vault) { vaults.push(vault); return vault; },
    async remove(id) {
      const index = vaults.findIndex((vault) => vault.id === id);
      return index === -1 ? null : vaults.splice(index, 1)[0];
    },
    async update(id, changes) {
      const vault = vaults.find((candidate) => candidate.id === id);
      return vault ? Object.assign(vault, changes) : null;
    },
  };
}

function fakeVaultStorage() {
  return {
    cloned: [],
    imported: [],
    async clone(input) {
      this.cloned.push(input);
      return {
        name: "Work", id: "work", directory: "work", repositoryUrl: input.repositoryUrl,
        gitRemote: "origin", gitBranch: "main",
      };
    },
    async import(input) {
      this.imported.push(input);
      return { repositoryUrl: "https://github.com/acme/personal.git", gitRemote: "origin", gitBranch: "main" };
    },
  };
}

function fakeSecrets() {
  return {
    saved: [],
    removed: [],
    async save(id, auth) { this.saved.push({ id, auth }); },
    async remove(id) { this.removed.push(id); },
  };
}

function validVaultPayload() {
  return {
    repositoryUrl: "https://github.com/acme/work.git",
    syncIntervalSeconds: 300,
    enabled: true,
    accessMode: "open",
    allowlist: [],
    repositoryVisibility: "private",
    gitUserName: "Work Bot",
    gitUserEmail: "work@example.test",
    gitAuthMode: "https-token",
    gitAuth: { mode: "https-token", username: "oauth2", token: "work-secret" },
  };
}

async function request(server, method, path, body) {
  return await new Promise((resolve) => {
    const chunks = [];
    const req = new Readable({
      read() {
        if (body !== undefined) this.push(JSON.stringify(body));
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
