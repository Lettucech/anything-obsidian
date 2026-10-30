import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createSourceManager } from "./sources.mjs";
import { writeJson } from "../lib/state.mjs";

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "any-obs-source-"));
  const calls = [],
    gitCalls = [],
    purges = [];
  const options = {
    dataDir: root,
    baseUrl: "http://upstream.test",
    apiKey: "secret-key",
    embedVault: async (args) => {
      calls.push(args);
      await args.onProgress({ phase: "embedding", completed: 1, total: 1 });
      return { uploaded: 1, removed: 0, verified: true };
    },
    purge: async (args) => {
      purges.push(args);
      return { purged: true };
    },
    runGit: async (args) => {
      gitCalls.push(args);
      if (args[0] === "clone") {
        await mkdir(path.join(args[4], ".git"), { recursive: true });
        await writeFile(path.join(args[4], ".git", "HEAD"), "ref: refs/heads/main");
      }
    },
    ...overrides,
  };
  const manager = createSourceManager(options);
  await manager.ready;
  t.after(async () => {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  });
  const create = (id = "team", changes = {}) =>
    manager.create({ id, kind: "dir", ref: root, workspace: "shared", ...changes });
  const finish = (job) =>
    waitFor(() => !["running", "queued"].includes(manager.job(job.id)?.status)).then(() =>
      manager.job(job.id),
    );
  return { root, manager, options, calls, gitCalls, purges, create, finish };
}
async function waitFor(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition timed out");
}

test("validates source identity, kind, directory, target and schedule", async (t) => {
  const f = await fixture(t);
  await f.create();
  await assert.rejects(f.create(), /already exists/);
  await assert.rejects(f.create("Bad"), /lowercase/);
  await assert.rejects(f.create("bad", { kind: "unknown" }), /kind/);
  await assert.rejects(f.create("bad", { ref: "relative" }), /absolute/);
  await assert.rejects(f.create("bad", { workspace: "" }), /target/);
  await assert.rejects(f.create("bad", { intervalSeconds: -1 }), /non-negative/);
});

test("refresh is persisted before acceptance, reports progress and forwards force rebuild", async (t) => {
  const f = await fixture(t);
  await f.create();
  const job = await f.manager.requestRefresh("team", { force: true });
  const stored = JSON.parse(await readFile(f.root + "/jobs.json", "utf8"));
  assert.equal(stored.jobs[0].id, job.id);
  assert.equal((await f.finish(job)).status, "succeeded");
  assert.equal(f.calls[0].all, true);
  assert.equal(f.calls[0].config.documentFolder, "anything-obsidian-vault-team");
  assert.match(f.calls[0].config.stateDir, /manifests\/team$/);
  assert.match(job.logs, /embedding/);
  assert.equal(job.progress.total, 1);
  assert.ok((await f.manager.get("team")).lastRefresh);
});

test("concurrent manual refreshes and scheduler ticks coalesce while a source is active", async (t) => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const f = await fixture(t, {
    embedVault: async () => {
      await gate;
      return {};
    },
  });
  t.after(release);
  await f.create();
  const jobs = await Promise.all([
    f.manager.requestRefresh("team"),
    f.manager.requestRefresh("team"),
  ]);
  assert.equal(jobs[0].id, jobs[1].id);
  assert.deepEqual(await f.manager.runDueSources(), []);
  assert.deepEqual(await f.manager.runDueSources(), []);
  assert.equal(f.manager.listJobs().length, 1);
  await assert.rejects(f.manager.requestRefresh("team", { force: true }), { statusCode: 409 });
  release();
  await f.finish(jobs[0]);
});

test("a failed source has a bounded retry schedule and does not lose its error", async (t) => {
  let clock = 1000000;
  const f = await fixture(t, {
    now: () => clock,
    embedVault: async () => {
      throw new Error("provider failed secret-key");
    },
  });
  await f.create("team", { intervalSeconds: 60 });
  await f.manager.runDueSources();
  const job = f.manager.listJobs()[0];
  await f.finish(job);
  assert.match(job.error, /provider failed \[redacted\]/);
  assert.equal(job.status, "failed");
  assert.deepEqual(await f.manager.runDueSources(), []);
  clock += 61000;
  assert.deepEqual(await f.manager.runDueSources(), ["team"]);
});

test("history and interrupted failures survive restart and can be retried", async (t) => {
  const f = await fixture(t);
  await f.create();
  await writeJson(f.root + "/jobs.json", {
    jobs: [
      {
        id: "job-interrupted",
        sourceId: "team",
        workspace: "shared",
        action: "refresh",
        force: true,
        status: "running",
      },
    ],
  });
  const restarted = createSourceManager(f.options);
  await restarted.ready;
  t.after(() => restarted.close());
  assert.equal(restarted.job("job-interrupted").status, "failed");
  assert.match(restarted.job("job-interrupted").error, /Interrupted/);
  const retried = await restarted.retry("job-interrupted");
  await waitFor(() => restarted.job(retried.id).finishedAt);
  assert.equal(retried.status, "succeeded");
  assert.equal(f.calls.at(-1).all, true);
});

test("source removal is a durable purge job and leaves source files intact", async (t) => {
  const f = await fixture(t);
  await f.create();
  await writeFile(f.root + "/notes.md", "keep me");
  const job = await f.manager.remove("team");
  assert.equal(job.action, "remove");
  assert.equal((await f.finish(job)).status, "succeeded");
  assert.equal(await f.manager.get("team"), null);
  assert.equal(f.purges.length, 1);
  assert.equal(await readFile(f.root + "/notes.md", "utf8"), "keep me");
});

test("failed cleanup retains a disabled source and can be retried", async (t) => {
  let successful = false;
  const f = await fixture(t, {
    purge: async () =>
      successful ? { purged: true } : { purged: false, errors: ["upstream offline"] },
  });
  await f.create();
  const job = await f.manager.remove("team");
  await f.finish(job);
  assert.equal(job.status, "failed");
  assert.equal((await f.manager.get("team")).cleanupPending, true);
  assert.equal((await f.manager.get("team")).enabled, false);
  await assert.rejects(f.manager.requestRefresh("team"), { statusCode: 404 });
  successful = true;
  const retry = await f.manager.retry(job.id);
  await f.finish(retry);
  assert.equal(await f.manager.get("team"), null);
});

test("cancel aborts the actual operation before the queue runs the next source", async (t) => {
  let started;
  const entered = new Promise((resolve) => (started = resolve));
  const f = await fixture(t, {
    embedVault: async ({ config, signal }) => {
      if (config.vaultId !== "slow") return {};
      started();
      await new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    },
  });
  await f.create("slow");
  await f.create("next");
  const first = await f.manager.requestRefresh("slow");
  await entered;
  const next = await f.manager.requestRefresh("next");
  await f.manager.cancel(first.id);
  await f.finish(next);
  assert.equal(first.status, "cancelled");
  assert.equal(next.status, "succeeded");
});

test("git sources clone once and pull on later refreshes; resolver keys are read per job", async (t) => {
  let key = "one";
  const f = await fixture(t, { apiKey: async () => key });
  await f.create("team", { kind: "git", ref: "https://git.example/team.git", branch: "release" });
  await f.finish(await f.manager.requestRefresh("team"));
  key = "two";
  await f.finish(await f.manager.requestRefresh("team"));
  assert.deepEqual(f.gitCalls[0].slice(0, 4), [
    "clone",
    "--branch",
    "release",
    "https://git.example/team.git",
  ]);
  assert.deepEqual(f.gitCalls[1].slice(2), ["pull", "--ff-only"]);
  assert.deepEqual(
    f.calls.map((args) => args.config.apiKey),
    ["one", "two"],
  );
});
