import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";

import { createDashboardServer } from "./server.mjs";
import { createAgentTokenStore } from "../lib/agent-tokens.mjs";

test("vault routes clone a repository and create its managed workspace", async () => {
  const registry = fakeRegistry();
  const anythingllm = {
    async listWorkspaces() { return []; },
    async createWorkspace({ name }) {
      assert.equal(name, "Work");
      return { id: 1, name, slug: "work" };
    },
  };
  const secrets = fakeSecrets();
  const vaultStorage = fakeVaultStorage();
  const app = createDashboardServer({ jobs: fakeJobs(), registry, anythingllm, vaultStorage, secrets, env: nativeEnv(), native: nativePaths() });

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
  const app = createDashboardServer({ jobs: fakeJobs(), registry, anythingllm, vaultStorage: fakeVaultStorage(), secrets, env: nativeEnv(), native: nativePaths() });

  const created = await request(app, "POST", "/api/vaults", {
    sourceMode: "import", id: "personal", name: "Personal", directory: "personal",
    workspaceMode: "attach", workspaceSlug: "personal", repositoryVisibility: "public",
    gitUserName: "Personal Bot", gitUserEmail: "personal@example.test",
  });
  assert.equal(created.status, 201);
  assert.equal((await request(app, "DELETE", "/api/vaults/personal")).status, 204);
  assert.deepEqual(secrets.removed, ["personal"]);
  assert.deepEqual((await request(app, "GET", "/api/vaults")).body.vaults, []);
});

test("vault creation falls back to the vault id when an import has no display name", async () => {
  const createdWorkspaces = [];
  const app = createDashboardServer({
    jobs: fakeJobs(), registry: fakeRegistry(),
    anythingllm: {
      async listWorkspaces() { return []; },
      async createWorkspace({ name }) { createdWorkspaces.push(name); return { id: 3, name, slug: "diary" }; },
    },
    vaultStorage: fakeVaultStorage(), secrets: fakeSecrets(), env: nativeEnv(), native: nativePaths(),
  });

  const response = await request(app, "POST", "/api/vaults", {
    sourceMode: "import", id: "diary", directory: "diary", name: "",
    workspaceMode: "create", repositoryVisibility: "public",
    gitUserName: "Diary Bot", gitUserEmail: "diary@example.test",
  });

  assert.equal(response.status, 201);
  assert.deepEqual(createdWorkspaces, ["diary"]);
});

test("agent token routes create, list, and revoke MCP agent identities", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "anything-obsidian-dashboard-agents-"));
  const registry = fakeRegistry();
  await registry.create({ id: "secret-vault", allowlist: ["scout"] });
  const app = createDashboardServer({
    jobs: fakeJobs(), registry,
    anythingllm: { async listWorkspaces() { return []; } },
    vaultStorage: fakeVaultStorage(), secrets: fakeSecrets(),
    agentTokens: createAgentTokenStore({ rootPath: root }),
    env: nativeEnv(), native: nativePaths(),
  });

  assert.deepEqual((await request(app, "GET", "/api/agents")).body, { agents: [] });
  const created = await request(app, "POST", "/api/agents", { name: "scout" });
  assert.equal(created.status, 201);
  assert.equal(created.body.agent.name, "scout");
  assert.ok(created.body.token.length > 0);

  const duplicate = await request(app, "POST", "/api/agents", { name: "scout" });
  assert.equal(duplicate.status, 500);
  assert.match(duplicate.body.error, /Agent already exists/);

  const invalid = await request(app, "POST", "/api/agents", { name: "Bad Name" });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /lowercase dash-separated/);

  const removed = await request(app, "DELETE", "/api/agents/scout");
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body, { removed: true, referencedBy: ["secret-vault"] });
  assert.equal((await request(app, "DELETE", "/api/agents/scout")).status, 404);
});

test("vault creation requires an explicit automatic-commit identity and private HTTPS credential", async () => {
  const vaultStorage = fakeVaultStorage();
  const secrets = fakeSecrets();
  const app = createDashboardServer({
    jobs: fakeJobs(), registry: fakeRegistry(),
    anythingllm: { async listWorkspaces() { return []; }, async createWorkspace() { return { slug: "work" }; } }, vaultStorage, secrets, env: nativeEnv(), native: nativePaths(),
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
    jobs: fakeJobs(), registry: fakeRegistry(),
    anythingllm: { async listWorkspaces() { return []; }, async createWorkspace() { return { slug: "work" }; } }, vaultStorage, secrets: fakeSecrets(), env: nativeEnv(), native: nativePaths(),
  });

  const response = await request(app, "POST", "/api/vaults", {
    ...validVaultPayload(), sourceMode: "import", gitAuth: { mode: "https-token", username: "", token: "" },
  });

  assert.equal(response.status, 400);
  assert.equal(vaultStorage.imported.length, 0);
});

test("vault creation checks AnythingLLM before cloning", async () => {
  const vaultStorage = fakeVaultStorage();
  const app = createDashboardServer({
    jobs: fakeJobs(), registry: fakeRegistry(), vaultStorage, secrets: fakeSecrets(), env: nativeEnv(), native: nativePaths(),
    anythingllm: {
      async listWorkspaces() { throw new Error("AnythingLLM API 403"); },
      async createWorkspace() { throw new Error("should not create a workspace"); },
    },
  });

  const response = await request(app, "POST", "/api/vaults", validVaultPayload());

  assert.equal(response.status, 500);
  assert.match(response.body.error, /rejected the dashboard API key/);
  assert.deepEqual(vaultStorage.cloned, []);
});

test("test connection validates Git and AnythingLLM without cloning or saving a vault", async () => {
  const vaultStorage = fakeVaultStorage();
  const registry = fakeRegistry();
  const anythingllm = { async listWorkspaces() { return []; } };
  const app = createDashboardServer({
    jobs: fakeJobs(), registry, anythingllm, vaultStorage, secrets: fakeSecrets(), env: nativeEnv(), native: nativePaths(),
  });

  const response = await request(app, "POST", "/api/vaults/test-connection", validVaultPayload());

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { git: { ok: true }, anythingllm: { ok: true } });
  assert.equal(vaultStorage.connectionTests.length, 1);
  assert.deepEqual(vaultStorage.cloned, []);
  assert.deepEqual(await registry.list(), []);
});

test("status returns classified system state and public config", async () => {
  const paths = nativePaths();
  writeFileSync(paths.schedulerPidPath, "9999\n");
  const app = createDashboardServer({
    jobs: fakeJobs(),
    env: { ...nativeEnv(), DASHBOARD_PORT: "21400" },
    native: { ...paths, killImpl: aliveKill(new Set([9999])), execFileImpl: async () => ({ stdout: "git version 2.39.0\n" }) },
  });

  const response = await request(app, "GET", "/api/status");

  assert.equal(response.status, 200);
  assert.equal(response.body.systemState, "partial");
  assert.deepEqual(response.body.services.map((service) => service.id), ["anythingllm", "scheduler", "mcp", "mcp-lan", "git"]);
  assert.equal(response.body.services.find((service) => service.id === "scheduler").health.ok, true);
  assert.equal(response.body.services.find((service) => service.id === "mcp").running, false);
  assert.equal(response.body.config.dashboardUrl, "http://localhost:21400");
});

test("dashboard root serves the management UI only after the AnythingLLM key is verified", async () => {
  const app = createDashboardServer({
    jobs: fakeJobs(), env: nativeEnv(), native: nativePaths(),
    anythingllm: { async listWorkspaces() { return []; } },
  });

  const response = await requestText(app, "/");

  assert.equal(response.status, 200);
  assert.match(response.body, /id="vault-dialog"/);
});

test("dashboard root serves a setup guide when the AnythingLLM key is invalid", async () => {
  const app = createDashboardServer({
    jobs: fakeJobs(), env: { ...nativeEnv(), ANYTHINGLLM_BASE_URL: "http://localhost:11401" }, native: nativePaths(),
    anythingllm: { async listWorkspaces() { throw new Error("AnythingLLM API 403"); } },
  });

  const response = await requestText(app, "/");

  assert.equal(response.status, 200);
  assert.match(response.body, /AnythingLLM setup required/);
  assert.match(response.body, /http:\/\/localhost:11401/);
  assert.doesNotMatch(response.body, /id="vault-dialog"/);
});

test("system off stops the scheduler and clears its pid file", async () => {
  const paths = nativePaths();
  writeFileSync(paths.schedulerPidPath, "1234\n");
  const app = createDashboardServer({
    jobs: fakeJobs(), env: nativeEnv(),
    native: { ...paths, killImpl: aliveKill(new Set([1234])) },
  });

  const response = await request(app, "POST", "/api/system/off");

  assert.equal(response.status, 200);
  assert.equal(existsSync(paths.schedulerPidPath), false);
});

test("system on starts the scheduler process and reports it running", async () => {
  const paths = nativePaths();
  const app = createDashboardServer({
    jobs: fakeJobs(), env: nativeEnv(),
    native: {
      ...paths,
      spawnImpl: () => {
        writeFileSync(paths.schedulerPidPath, "2345\n");
        return { pid: 2345, unref() {} };
      },
      killImpl: aliveKill(new Set([2345])),
    },
  });

  const response = await request(app, "POST", "/api/system/on");

  assert.equal(response.status, 200);
  assert.equal(response.body.services.find((service) => service.id === "scheduler").running, true);
});

test("logs reject unknown service ids", async () => {
  const app = createDashboardServer({ jobs: fakeJobs(), env: nativeEnv(), native: nativePaths() });

  const response = await request(app, "GET", "/api/logs?service=/var/run/docker.sock");

  assert.equal(response.status, 400);
  assert.match(response.body.error, /Unknown log service/);
});

test("vault actions reject unknown action ids and start an allowed scoped job", async () => {
  const jobs = fakeJobs();
  const registry = fakeRegistry();
  await registry.create({ id: "work" });
  const app = createDashboardServer({
    jobs,
    registry,
    env: nativeEnv(), native: nativePaths(),
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
    jobs: {
      latest: () => null,
      get: () => null,
      async start() {
        throw new Error("Embed changed requires AnythingLLM to be running");
      },
    },
    registry,
    env: nativeEnv(), native: nativePaths(),
  });

  const response = await request(app, "POST", "/api/vaults/work/actions/embed");

  assert.equal(response.status, 409);
  assert.match(response.body.error, /requires AnythingLLM/);
});

test("static files do not serve traversal-looking paths", async () => {
  const app = createDashboardServer({ jobs: fakeJobs(), env: nativeEnv(), native: nativePaths() });

  const response = await request(app, "GET", "/..%2fserver.mjs");

  assert.equal([403, 404].includes(response.status), true);
  assert.notEqual(response.body, "#!/usr/bin/env node");
});

test("static files return not found instead of server error", async () => {
  const app = createDashboardServer({ jobs: fakeJobs(), env: nativeEnv(), native: nativePaths() });

  const response = await request(app, "GET", "/missing.css");

  assert.equal(response.status, 404);
  assert.match(response.body.error, /Not found/);
});

function nativeEnv() {
  const root = "/tmp/anything-obsidian-server-fixture";
  return {
    VAULTS_ROOT: "/vaults",
    VAULT_REGISTRY_PATH: `${root}/registry/vaults.json`,
    VAULT_SECRETS_PATH: `${root}/secrets`,
    VAULT_STATE_ROOT: `${root}/state`,
    AGENT_TOKENS_PATH: `${root}/agent-tokens`,
    DASHBOARD_PORT: "21400",
    ANYTHINGLLM_BASE_URL: "http://localhost:11301",
  };
}

function nativePaths() {
  const root = mkdtempSync(path.join(tmpdir(), `anything-obsidian-server-${Math.random().toString(36).slice(2)}`));
  return {
    schedulerPidPath: path.join(root, "scheduler.pid"),
    schedulerLogPath: path.join(root, "scheduler.log"),
    jobStorePath: path.join(root, "jobs.json"),
  };
}

function aliveKill(alive) {
  return (pid, signal = 0) => {
    if (signal !== 0) {
      alive.delete(pid);
      return;
    }
    if (!alive.has(pid)) {
      const error = new Error("ESRCH");
      error.code = "ESRCH";
      throw error;
    }
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
    connectionTests: [],
    async testConnection(input) {
      this.connectionTests.push(input);
    },
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

async function requestText(server, path) {
  return await new Promise((resolve) => {
    const chunks = [];
    const req = new Readable({ read() { this.push(null); } });
    req.method = "GET";
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
      resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") });
      return res;
    };
    server.emit("request", req, res);
  });
}
