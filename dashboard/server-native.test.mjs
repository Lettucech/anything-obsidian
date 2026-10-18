import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";

import { createDashboardServer } from "./server.mjs";
import { WORKER_SCRIPT_PATH, createLocalJobManager } from "./local-jobs.mjs";
import { importTree } from "./import-tree.mjs";

function nativeApp({ env = nativeEnvObject(), anythingllm, spawnImpl, killImpl, execFileImpl, schedulerPidPath, schedulerLogPath } = {}) {
  return createDashboardServer({
    env,
    anythingllm: anythingllm || { async listWorkspaces() { return []; } },
    jobs: createLocalJobManager({ env }),
    native: {
      schedulerPidPath: schedulerPidPath || path.join(tmpdir(), `ao-native-${Math.random().toString(36).slice(2)}.pid`),
      schedulerLogPath: schedulerLogPath || path.join(tmpdir(), `ao-native-${Math.random().toString(36).slice(2)}.log`),
      spawnImpl: spawnImpl || (() => ({ pid: 1000, unref() {} })),
      killImpl,
      execFileImpl: execFileImpl || (async () => ({ stdout: "git version 2.39.0\n" })),
    },
  });
}

function nativeEnvObject() {
  return {
    VAULTS_ROOT: "/Users/x/Vaults",
    VAULT_REGISTRY_PATH: "/Users/x/Library/Application Support/anything-obsidian/registry/vaults.json",
    VAULT_SECRETS_PATH: "/Users/x/Library/Application Support/anything-obsidian/secrets",
    VAULT_STATE_ROOT: "/Users/x/Library/Application Support/anything-obsidian/state",
    AGENT_TOKENS_PATH: "/Users/x/Library/Application Support/anything-obsidian/agent-tokens",
    ANYTHINGLLM_BASE_URL: "http://localhost:11301",
    ANYTHINGLLM_API_KEY: "key",
    DASHBOARD_PORT: "21400",
    MCP_PORT: "21999",
    MCP_LAN_PORT: "21998",
  };
}

test("native paths are required", () => {
  const env = nativeEnvObject();
  assert.throws(() => createDashboardServer({ env }), /native paths are required/);
});

test("native status reports AnythingLLM, scheduler, and git services", async () => {
  const app = nativeApp();

  const response = await request(app, "GET", "/api/status");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.services.map((service) => service.id), ["anythingllm", "scheduler", "mcp", "mcp-lan", "git"]);
  const byId = Object.fromEntries(response.body.services.map((service) => [service.id, service]));
  assert.equal(byId.anythingllm.running, true);
  assert.equal(byId.anythingllm.health.ok, true);
  assert.equal(byId.scheduler.running, false);
  assert.equal(byId.mcp.running, false);
  assert.equal(byId["mcp-lan"].state, "off");
  assert.equal(byId.git.running, true);
  assert.match(byId.git.health.status, /git version/);
  assert.equal(response.body.systemState, "partial");
  assert.equal(response.body.config.dashboardUrl, "http://localhost:21400");
  assert.equal(response.body.config.anythingllmUrl, "http://localhost:11301");
  assert.equal(response.body.config.vaultsRoot, "/Users/x/Vaults");
});

test("native status reflects an unreachable AnythingLLM and a live scheduler", async () => {
  const pidPath = path.join(tmpdir(), `ao-native-live-${process.pid}.pid`);
  writeFileSync(pidPath, "4242\n");
  const app = nativeApp({
    anythingllm: { async listWorkspaces() { throw new Error("AnythingLLM API 401"); } },
    schedulerPidPath: pidPath,
    killImpl: (pid) => {
      if (pid === 4242) return;
      const error = new Error("ESRCH");
      error.code = "ESRCH";
      throw error;
    },
  });

  const response = await request(app, "GET", "/api/status");

  assert.equal(response.status, 200);
  const byId = Object.fromEntries(response.body.services.map((service) => [service.id, service]));
  assert.equal(byId.anythingllm.running, false);
  assert.match(byId.anythingllm.health.status, /401/);
  assert.equal(byId.scheduler.running, true);
  assert.match(byId.scheduler.state, /pid 4242/);
  assert.equal(byId.git.running, true);
  assert.equal(response.body.systemState, "partial");
});

test("native system on starts the detached scheduler and system off stops it", async () => {
  const spawned = [];
  const child = { pid: 4321, unref() {} };
  const alive = new Set();
  const killImpl = (pid, signal) => {
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
  const schedulerPidPath = path.join(tmpdir(), `ao-native-onoff-${process.pid}.pid`);
  const app = nativeApp({
    spawnImpl: (nodePath, args, options) => {
      spawned.push({ nodePath, args, options });
      alive.add(child.pid);
      return child;
    },
    killImpl,
    schedulerPidPath,
  });

  const on = await request(app, "POST", "/api/system/on");
  assert.equal(on.status, 200);
  assert.equal(on.body.services.find((service) => service.id === "scheduler").running, true);
  assert.equal(on.body.systemState, "on");
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].args, [WORKER_SCRIPT_PATH, "scheduler"]);
  assert.equal(spawned[0].options.detached, true);
  assert.equal(spawned[0].options.env.VAULTS_ROOT, "/Users/x/Vaults");
  assert.equal(spawned[0].options.env.ANYTHINGLLM_API_KEY, "key");
  assert.equal(existsSync(schedulerPidPath), true);

  const off = await request(app, "POST", "/api/system/off");
  assert.equal(off.status, 200);
  assert.equal(off.body.services.find((service) => service.id === "scheduler").running, false);
  assert.equal(existsSync(schedulerPidPath), false);
});

test("native logs serve the scheduler log tail for the syncer alias", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ao-native-logs-"));
  const schedulerLogPath = path.join(root, "scheduler.log");
  await writeFile(schedulerLogPath, "ANYTHINGLLM_API_KEY=hunter2\nline-two\n");
  const app = nativeApp({ schedulerLogPath });

  const response = await request(app, "GET", "/api/logs?service=syncer");
  assert.equal(response.status, 200);
  assert.doesNotMatch(response.body.logs, /hunter2/);
  assert.match(response.body.logs, /\[redacted\]/);
  assert.match(response.body.logs, /line-two/);

  const alias = await request(app, "GET", "/api/logs?service=scheduler");
  assert.equal(alias.status, 200);
  const unknown = await request(app, "GET", "/api/logs?service=anythingllm");
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /Unknown log service/);
});

test("native setup page points at anything-obsidian init instead of docker", async () => {
  const app = nativeApp({
    anythingllm: { async listWorkspaces() { throw new Error("AnythingLLM API 403"); } },
  });

  const response = await requestText(app, "/");

  assert.equal(response.status, 200);
  assert.match(response.body, /AnythingLLM setup required/);
  assert.match(response.body, /anything-obsidian init/);
  assert.doesNotMatch(response.body, /docker compose/);
});

test("native vault actions start spawn-based jobs gated on the AnythingLLM probe", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ao-native-actions-"));
  const registryPath = path.join(root, "registry", "vaults.json");
  const env = { ...nativeEnvObject(), PATH: process.env.PATH, HOME: process.env.HOME, VAULT_REGISTRY_PATH: registryPath };
  await mkdir(path.dirname(registryPath), { recursive: true });
  await writeFile(registryPath, JSON.stringify({
    version: 1,
    vaults: [{ id: "work", name: "work", directory: "work", workspaceSlug: "work", gitUserName: "A", gitUserEmail: "a@b.c" }],
  }));
  const app = createDashboardServer({
    env,
    anythingllm: { async listWorkspaces() { return []; } },
    native: { schedulerPidPath: path.join(root, "s.pid"), schedulerLogPath: path.join(root, "s.log") },
  });

  const notFound = await request(app, "POST", "/api/vaults/missing/actions/sync");
  assert.equal(notFound.status, 404);

  const gated = await request(app, "POST", "/api/vaults/work/actions/sync");
  assert.equal(gated.status, 202);
  assert.equal(gated.body.vaultId, "work");

  const finished = await waitForJob(app, gated.body.id);
  assert.equal(finished.actionId, "sync");
  assert.equal(["succeeded", "failed"].includes(finished.status), true);
});

test("import tree lists only real subdirectories beneath the vault root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ao-import-tree-"));
  await mkdir(path.join(root, "personal-notes", "nested"), { recursive: true });
  await mkdir(path.join(root, ".hidden"), { recursive: true });
  await writeFile(path.join(root, "notes-file.md"), "not a directory");
  await symlink(path.join(root, "personal-notes"), path.join(root, "linked-notes"));

  const app = nativeApp({ env: { ...nativeEnvObject(), VAULTS_ROOT: root } });

  const rootListing = await request(app, "GET", "/api/import-tree");
  assert.equal(rootListing.status, 200);
  assert.deepEqual(rootListing.body.directories.map((entry) => entry.name), ["personal-notes"]);
  assert.equal(rootListing.body.insideRoot, true);
  assert.equal(rootListing.body.canUseHere, false);
  assert.equal(rootListing.body.directories[0].canImport, true);
  assert.equal(rootListing.body.directories[0].importMode, "managed");
  assert.equal(rootListing.body.importMode, null); // the root itself is never importable
  assert.equal(rootListing.body.parent, null);

  const nested = await request(app, "GET", `/api/import-tree?path=${encodeURIComponent(path.join(root, "personal-notes"))}`);
  assert.equal(nested.status, 200);
  assert.deepEqual(nested.body.directories.map((entry) => entry.name), ["nested"]);
  // A directory deeper than a direct child of the root can still be imported,
  // but only as a path the user owns (imported), never as a managed vault.
  assert.equal(nested.body.directories[0].canImport, true);
  assert.equal(nested.body.directories[0].importMode, "imported");
  assert.equal(nested.body.importMode, "managed"); // the current folder is itself a direct child
  assert.equal(nested.body.canUseHere, true);
  assert.equal(nested.body.parent, rootListing.body.root);
});

test("import tree browses outside the vault root and still rejects missing paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ao-import-tree-"));
  await mkdir(path.join(root, "vault-one"));
  const app = nativeApp({ env: { ...nativeEnvObject(), VAULTS_ROOT: root } });

  const outside = await request(app, "GET", `/api/import-tree?path=${encodeURIComponent("/etc")}`);
  assert.equal(outside.status, 200);
  assert.equal(outside.body.insideRoot, false);
  assert.equal(outside.body.canUseHere, true);
  assert.ok(outside.body.directories.length > 0);
  assert.ok(outside.body.directories.every((entry) => entry.importMode === "imported"));

  const missing = await request(app, "GET", `/api/import-tree?path=${encodeURIComponent(path.join(root, "does-not-exist"))}`);
  assert.equal(missing.status, 404);
});

test("import tree module is directly reusable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ao-import-tree-unit-"));
  await mkdir(path.join(root, "repo-a"));
  const tree = await importTree({ vaultsRoot: root });
  assert.deepEqual(tree.directories.map((entry) => entry.name), ["repo-a"]);
});

async function waitForJob(app, jobId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = await request(app, "GET", `/api/jobs/${encodeURIComponent(jobId)}`);
    if (["succeeded", "failed"].includes(job.body.status)) return job.body;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for job");
}

async function request(server, method, requestPath, body) {
  return await new Promise((resolve) => {
    const chunks = [];
    const req = new Readable({
      read() {
        if (body !== undefined) this.push(JSON.stringify(body));
        this.push(null);
      },
    });
    req.method = method;
    req.url = requestPath;

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

async function requestText(server, requestPath) {
  return await new Promise((resolve) => {
    const chunks = [];
    const req = new Readable({ read() { this.push(null); } });
    req.method = "GET";
    req.url = requestPath;
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
