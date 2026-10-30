import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { EventEmitter } from "node:events";

import { WORKER_SCRIPT_PATH, createLocalJobManager, tailLogFile } from "./local-jobs.mjs";

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
      queueMicrotask(() =>
        child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })),
      );
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
  await assert.rejects(
    () => jobs.start("work", "embed", runningAnythingllm()),
    /already running for vault 'work'/,
  );
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
  assert.deepEqual(
    jobs.list().map((job) => job.id),
    [first.id, second.id],
  );
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

function minimalEnv(vaultsRoot) {
  return {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: process.env.HOME || tmpdir(),
    ...(vaultsRoot ? { VAULTS_ROOT: vaultsRoot } : {}),
  };
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

test("a persistence failure rejects a job before any worker is spawned", async () => {
  let spawned = false;
  const jobs = createLocalJobManager({
    spawnImpl: () => {
      spawned = true;
    },
    jobStore: {
      loadSync: () => [],
      save: async () => {
        throw new Error("disk full");
      },
    },
  });
  await assert.rejects(jobs.start("work", "doctor"), /disk full/);
  assert.equal(spawned, false);
  assert.equal(jobs.list().length, 0);
});

test("service shutdown cannot turn an interrupted worker into a successful job", async () => {
  const fixture = await writeFixture(
    `process.on('SIGTERM',()=>process.exit(0)); console.log('worker ready'); setInterval(()=>{},100);`,
  );
  const jobs = createLocalJobManager({ workerPath: fixture, env: minimalEnv() });
  const job = await jobs.start("work", "doctor");
  await waitFor(() => job.logs.includes("worker ready"));
  await jobs.close();
  assert.equal(job.status, "failed");
  assert.match(job.error, /Interrupted/);
});
