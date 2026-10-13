import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { EventEmitter } from "node:events";

import {
  SERVER_SCRIPT_PATH,
  WORKER_SCRIPT_PATH,
  createLocalJobManager,
  readSchedulerStatus,
  startDashboardProcess,
  startSchedulerProcess,
  stopSchedulerProcess,
  tailLogFile,
  waitForHttp,
} from "./local-jobs.mjs";

const fixtures = [];
after(async () => {
  await Promise.all(fixtures.map((dir) => rm(dir, { recursive: true, force: true })));
});

test("local jobs spawn the worker with vault-scoped env and capture redacted logs", async () => {
  const fixture = await writeFixture(`
    process.stdout.write("ANYTHINGLLM_API_KEY=topsecret\\n");
    process.stdout.write(JSON.stringify({ args: process.argv.slice(2), vaultsRoot: process.env.VAULTS_ROOT }) + "\\n");
  `);
  const jobs = createLocalJobManager({
    env: minimalEnv("/Users/x/Vaults"),
    workerPath: fixture,
  });

  const job = await jobs.start("work", "sync", runningAnythingllm());
  assert.equal(job.status, "running");

  const finished = await waitFor(() => settled(jobs, job.id));

  assert.equal(finished.status, "succeeded");
  assert.equal(finished.exitCode, 0);
  assert.match(finished.logs, /"args":\["sync","--vault","work"\]/);
  assert.match(finished.logs, /"vaultsRoot":"\/Users\/x\/Vaults"/);
  assert.doesNotMatch(finished.logs, /topsecret/);
  assert.match(finished.logs, /\[redacted\]/);
  assert.ok(finished.finishedAt);
  assert.ok(finished.id.startsWith("job-"));
  assert.equal(finished.label, "Sync now");
});

test("local jobs report failure with the worker exit code", async () => {
  const fixture = await writeFixture(`process.stderr.write("boom\\n"); process.exit(3);`);
  const jobs = createLocalJobManager({ env: minimalEnv(), workerPath: fixture });

  const job = await jobs.start("work", "doctor", []);
  const finished = await waitFor(() => settled(jobs, job.id));

  assert.equal(finished.status, "failed");
  assert.equal(finished.exitCode, 3);
  assert.match(finished.error, /Worker exited with 3/);
  assert.match(finished.logs, /boom/);
});

test("local jobs mark spawn errors as failed without an exit code", async () => {
  const jobs = createLocalJobManager({
    env: minimalEnv(),
    workerPath: "does-not-exist.mjs",
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stdout = null;
      child.stderr = null;
      queueMicrotask(() => child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })));
      return child;
    },
  });

  const job = await jobs.start("work", "doctor", []);
  const finished = await waitFor(() => settled(jobs, job.id));

  assert.equal(finished.status, "failed");
  assert.equal(finished.exitCode, null);
  assert.match(finished.error, /spawn ENOENT/);
});

test("local jobs require AnythingLLM for gated actions and one job per vault", async () => {
  const fixture = await writeFixture(`await new Promise((resolve) => setTimeout(resolve, 150));`);
  const jobs = createLocalJobManager({ env: minimalEnv(), workerPath: fixture });

  await assert.rejects(() => jobs.start("work", "sync", []), /requires AnythingLLM to be running/);

  const first = await jobs.start("work", "sync", runningAnythingllm());
  await assert.rejects(() => jobs.start("work", "embed", runningAnythingllm()), /already running for vault 'work'/);
  const other = await jobs.start("rest", "doctor", []);
  assert.notEqual(first.id, other.id);

  await waitFor(() => settled(jobs, first.id));
  const again = await jobs.start("work", "doctor", []);
  assert.notEqual(again.id, first.id);
});

test("local jobs keep list and latest in insertion order", async () => {
  const fixture = await writeFixture(`process.exit(0);`);
  const jobs = createLocalJobManager({ env: minimalEnv(), workerPath: fixture });

  assert.equal(jobs.latest(), null);
  assert.deepEqual(jobs.list(), []);
  const first = await jobs.start("one", "doctor", []);
  const second = await jobs.start("two", "doctor", []);
  assert.deepEqual(jobs.list().map((job) => job.id), [first.id, second.id]);
  assert.equal(jobs.latest().id, second.id);
  assert.equal(jobs.get("missing"), null);
});

test("local job logs are truncated to the configured line limit", async () => {
  const fixture = await writeFixture(`
    for (let index = 0; index < 600; index += 1) process.stdout.write("line-" + index + "\\n");
  `);
  const jobs = createLocalJobManager({ env: minimalEnv(), workerPath: fixture, logLimit: 50 });

  const job = await jobs.start("work", "doctor", []);
  const finished = await waitFor(() => settled(jobs, job.id));

  const lines = finished.logs.split("\n").filter((line) => line.length > 0);
  assert.ok(lines.length <= 50, `expected at most 50 lines, got ${lines.length}`);
  assert.equal(lines.at(-1), "line-599");
});

test("dashboard process spawns detached with a pid file and reports already-running", () => {
  const root = syntheticDir();
  const pidPath = path.join(root, "run", "dashboard.pid");
  const logPath = path.join(root, "logs", "dashboard.log");
  const spawned = [];
  const child = { pid: 5150, unref() { this.unreffed = true; } };
  const alive = new Set();
  const killImpl = (pid) => {
    if (!alive.has(pid)) {
      const error = new Error("ESRCH");
      error.code = "ESRCH";
      throw error;
    }
  };
  alive.add(5150);

  const started = startDashboardProcess({
    env: { DASHBOARD_PORT: "11500" },
    pidPath,
    logPath,
    spawnImpl: (nodePath, args, options) => {
      spawned.push({ nodePath, args, options });
      return child;
    },
    killImpl,
  });
  assert.deepEqual(started, { started: true, pid: 5150 });
  assert.deepEqual(spawned[0].args, [SERVER_SCRIPT_PATH]);
  assert.equal(spawned[0].options.detached, true);
  assert.equal(spawned[0].options.env.DASHBOARD_PORT, "11500");
  assert.equal(readFileSync(pidPath, "utf8"), "5150\n");

  const again = startDashboardProcess({
    env: {},
    pidPath,
    logPath,
    spawnImpl: () => {
      throw new Error("should not spawn twice");
    },
    killImpl,
  });
  assert.deepEqual(again, { started: false, alreadyRunning: true, pid: 5150 });
});

test("waitForHttp resolves true on any non-500 response and false on timeout", async () => {
  let attempts = 0;
  const ok = await waitForHttp("http://mock/api/status", {
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("ECONNREFUSED");
      return { status: 404 };
    },
    timeoutMs: 5000,
    sleep: async () => {},
  });
  assert.equal(ok, true);
  assert.equal(attempts, 2);

  const never = await waitForHttp("http://mock/api/status", {
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
    timeoutMs: 0,
    sleep: async () => {},
  });
  assert.equal(never, false);
});

test("scheduler process spawns detached, records its pid, and reports status", () => {
  const root = syntheticDir();
  const pidPath = path.join(root, "run", "scheduler.pid");
  const logPath = path.join(root, "logs", "scheduler.log");
  const spawned = [];
  const child = { pid: 4242, unref() { this.unreffed = true; } };

  const result = startSchedulerProcess({
    env: { VAULTS_ROOT: "/v" },
    pidPath,
    logPath,
    spawnImpl: (nodePath, args, options) => {
      spawned.push({ nodePath, args, options });
      return child;
    },
  });

  assert.deepEqual(result, { started: true, pid: 4242 });
  assert.equal(spawned.length, 1);
  assert.match(spawned[0].nodePath, /node$/);
  assert.deepEqual(spawned[0].args.slice(-2), [WORKER_SCRIPT_PATH, "scheduler"]);
  assert.equal(spawned[0].options.detached, true);
  assert.equal(spawned[0].options.stdio[1], spawned[0].options.stdio[2]);
  assert.equal(child.unreffed, true);
  assert.equal(readFileSync(pidPath, "utf8"), "4242\n");

  const status = readSchedulerStatus({ pidPath, killImpl: (pid) => alivePidsKill(new Set([4242]), pid) });
  assert.deepEqual(status, { running: true, pid: 4242 });
});

test("scheduler process start is a no-op while an instance is already running", () => {
  const root = syntheticDir();
  const pidPath = path.join(root, "scheduler.pid");
  writeFileSync(pidPath, "777\n");
  const spawned = [];

  const result = startSchedulerProcess({
    env: {},
    pidPath,
    logPath: path.join(root, "scheduler.log"),
    killImpl: (pid) => alivePidsKill(new Set([777]), pid),
    spawnImpl: () => {
      spawned.push("spawned");
      throw new Error("should not spawn");
    },
  });

  assert.deepEqual(result, { started: false, alreadyRunning: true, pid: 777 });
  assert.equal(spawned.length, 0);
});

test("scheduler stop terminates the recorded pid and clears the pid file", async () => {
  const root = syntheticDir();
  const pidPath = path.join(root, "scheduler.pid");
  writeFileSync(pidPath, "555\n");
  const alive = new Set([555]);
  const signals = [];
  const killImpl = (pid, signal) => {
    if (signal !== 0) {
      signals.push(signal);
      alive.delete(pid);
      return;
    }
    alivePidsKill(alive, pid);
  };

  const result = await stopSchedulerProcess({ pidPath, killImpl, graceMs: 50, sleep: async () => {} });

  assert.deepEqual(result, { stopped: true, pid: 555 });
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(readSchedulerStatus({ pidPath, killImpl }).running, false);
  assert.equal(existsSync(pidPath), false);
});

test("scheduler stop escalates to SIGKILL when a process refuses to exit", async () => {
  const root = syntheticDir();
  const pidPath = path.join(root, "scheduler.pid");
  writeFileSync(pidPath, "556\n");
  const signals = [];
  const killImpl = (pid, signal) => {
    signals.push(signal);
  };

  const result = await stopSchedulerProcess({ pidPath, killImpl, graceMs: 40, sleep: async () => {} });

  assert.deepEqual(result, { stopped: true, pid: 556 });
  assert.deepEqual(signals.filter((signal) => signal !== 0), ["SIGTERM", "SIGKILL"]);
});

test("scheduler stop with a stale pid file just clears it", async () => {
  const root = syntheticDir();
  const pidPath = path.join(root, "scheduler.pid");
  writeFileSync(pidPath, "999\n");

  const result = await stopSchedulerProcess({
    pidPath,
    killImpl: () => {
      const error = new Error("no process");
      error.code = "ESRCH";
      throw error;
    },
  });

  assert.deepEqual(result, { stopped: false, pid: 999 });
  assert.equal(existsSync(pidPath), false);
});

test("scheduler status reports not-running for missing or malformed pid files", () => {
  const root = syntheticDir();
  assert.deepEqual(readSchedulerStatus({ pidPath: path.join(root, "missing.pid") }), { running: false, pid: null });
  const pidPath = path.join(root, "bad.pid");
  writeFileSync(pidPath, "not-a-pid\n");
  assert.deepEqual(readSchedulerStatus({ pidPath }), { running: false, pid: null });
});

test("tailLogFile returns the last lines and tolerates a missing log", async () => {
  const root = syntheticDir();
  const logPath = path.join(root, "scheduler.log");
  assert.equal(tailLogFile(logPath), "");

  await writeFile(logPath, ["one", "two", "three", ""].join("\n"));
  assert.equal(tailLogFile(logPath, 2), "two\nthree");
  assert.equal(tailLogFile(logPath, 10), "one\ntwo\nthree");
});

let counter = 0;
function syntheticDir() {
  counter += 1;
  return mkdtempSync(path.join(tmpdir(), `anything-obsidian-local-jobs-`));
}

function alivePidsKill(alive, pid, signal = 0) {
  if (signal !== 0) throw new Error(`unexpected signal ${signal}`);
  if (!alive.has(pid)) {
    const error = new Error("ESRCH");
    error.code = "ESRCH";
    throw error;
  }
}

function minimalEnv(vaultsRoot) {
  return { PATH: process.env.PATH || "/usr/bin:/bin", HOME: process.env.HOME || tmpdir(), ...(vaultsRoot ? { VAULTS_ROOT: vaultsRoot } : {}) };
}

function runningAnythingllm() {
  return [{ id: "anythingllm", running: true, health: { ok: true } }];
}

function settled(jobs, jobId) {
  const current = jobs.get(jobId);
  return ["succeeded", "failed"].includes(current.status) ? current : null;
}

async function writeFixture(body) {
  const dir = await mkdtemp(path.join(tmpdir(), "anything-obsidian-fixture-"));
  const file = path.join(dir, "fixture.mjs");
  await writeFile(file, body.trim());
  fixtures.push(dir);
  return file;
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
}
