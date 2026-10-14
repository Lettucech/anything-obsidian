import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { createFileJobStore } from "./job-store.mjs";
import { createLocalJobManager } from "./local-jobs.mjs";

const dirs = [];
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function storeDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "anything-obsidian-jobs-"));
  dirs.push(dir);
  return dir;
}

const settledJob = (id, overrides = {}) => ({
  id, vaultId: "v", actionId: "doctor", label: "Run doctor",
  status: "succeeded", startedAt: "2026-10-14T00:00:00.000Z",
  finishedAt: "2026-10-14T00:00:01.000Z", exitCode: 0, logs: "", error: null,
  ...overrides,
});

test("save writes atomically and load round-trips jobs", async () => {
  const dir = await storeDir();
  const store = createFileJobStore({ filePath: path.join(dir, "state", "jobs.json") });
  const jobs = [settledJob("job-1"), settledJob("job-2", { status: "failed", exitCode: 3 })];

  await store.save(jobs);

  assert.equal(existsSync(store.filePath), true);
  assert.deepEqual(await store.load(), jobs);
});

test("load marks interrupted queued and running jobs as failed", async () => {
  const dir = await storeDir();
  const store = createFileJobStore({ filePath: path.join(dir, "jobs.json") });
  await store.save([
    settledJob("job-done"),
    settledJob("job-running", { status: "running", exitCode: null, finishedAt: null }),
    settledJob("job-queued", { status: "queued", exitCode: null, finishedAt: null }),
  ]);

  const restored = await store.load();
  assert.equal(restored[0].status, "succeeded");
  assert.equal(restored[1].status, "failed");
  assert.equal(restored[1].error, "Interrupted by restart");
  assert.equal(restored[2].status, "failed");
  assert.match(restored[2].finishedAt, /^20\d{2}-/);
});

test("housekeeping trims to maxJobs keeping the newest", async () => {
  const dir = await storeDir();
  const store = createFileJobStore({ filePath: path.join(dir, "jobs.json"), maxJobs: 3 });
  const saved = await store.save([1, 2, 3, 4, 5].map((n) => settledJob(`job-${n}`)));

  assert.deepEqual(saved.map((job) => job.id), ["job-3", "job-4", "job-5"]);
  assert.deepEqual((await store.load()).map((job) => job.id), ["job-3", "job-4", "job-5"]);
});

test("housekeeping trims oldest jobs until the file fits maxBytes", async () => {
  const dir = await storeDir();
  const bigLogs = "x".repeat(1000);
  const store = createFileJobStore({ filePath: path.join(dir, "jobs.json"), maxBytes: 3000 });
  const jobs = [1, 2, 3, 4].map((n) => settledJob(`job-${n}`, { logs: bigLogs }));

  const saved = await store.save(jobs);

  assert.equal(saved.length, 2);
  assert.deepEqual(saved.map((job) => job.id), ["job-3", "job-4"]);
  assert.ok(readFileSync(store.filePath, "utf8").length <= 3000 + 100);
});

test("a corrupt or missing store file is treated as empty history", async () => {
  const dir = await storeDir();
  const corrupt = createFileJobStore({ filePath: path.join(dir, "corrupt.json") });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(corrupt.filePath, "{not json");

  assert.deepEqual(await corrupt.load(), []);

  const missing = createFileJobStore({ filePath: path.join(dir, "missing.json") });
  assert.deepEqual(await missing.load(), []);
});

test("local job manager persists jobs across manager restarts", async () => {
  const dir = await storeDir();
  const filePath = path.join(dir, "jobs.json");
  const fixture = path.join(dir, "fixture.mjs");
  const { writeFile: put } = await import("node:fs/promises");
  await put(fixture, 'process.exit(0);');
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  const jobStore = createFileJobStore({ filePath });

  const first = createLocalJobManager({ env, workerPath: fixture, jobStore });
  const job = await first.start("work", "doctor", []);
  // Poll the file itself: a fresh manager would mark a still-running job as
  // interrupted on restore, which is correct boot behavior but not this test.
  await waitFor(() => {
    try {
      const stored = JSON.parse(readFileSync(jobStore.filePath, "utf8"));
      return ["succeeded", "failed"].includes(stored.jobs.find((entry) => entry.id === job.id)?.status ?? "") || null;
    } catch {
      return null;
    }
  });
  const second = createLocalJobManager({ env, workerPath: fixture, jobStore });
  assert.equal(second.get(job.id).status, "succeeded");
  assert.equal(second.latest().id, job.id);

  // A manager restoring a job that claims to still be running marks it interrupted.
  const { writeFile: put2 } = await import("node:fs/promises");
  await put2(filePath, JSON.stringify({ version: 1, jobs: [settledJob("job-stale", { status: "running", exitCode: null, finishedAt: null })] }));
  const third = createLocalJobManager({ env, workerPath: fixture, jobStore });
  assert.equal(third.get("job-stale").status, "failed");
  assert.equal(third.get("job-stale").error, "Interrupted by restart");
});

test("without a job store nothing is persisted", async () => {
  const dir = await storeDir();
  const jobsPath = path.join(dir, "jobs.json");
  const fixture = path.join(dir, "fixture.mjs");
  const { writeFile: put } = await import("node:fs/promises");
  await put(fixture, 'process.exit(0);');

  const manager = createLocalJobManager({ env: { PATH: process.env.PATH }, workerPath: fixture });
  const job = await manager.start("work", "doctor", []);
  await waitFor(() => settled(manager, job.id));

  assert.equal(existsSync(jobsPath), false);
});

function settled(manager, jobId) {
  const current = manager.get(jobId);
  return ["succeeded", "failed"].includes(current.status) ? current : null;
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
