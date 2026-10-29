import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createSourceManager } from "./sources.mjs";

test("sources validate ids, kinds, and refs before entering the registry", async () => {
  const { manager } = await setup();

  assert.equal((await manager.create({ id: "team-kb", kind: "git", ref: "https://git.example/team/kb.git", workspace: "company-kb" })).kind, "git");
  await assert.rejects(() => manager.create({ id: "team-kb", ref: "x", workspace: "company-kb" }), /Source already exists/);
  await assert.rejects(() => manager.create({ id: "Bad Id", ref: "x", workspace: "company-kb" }), /lowercase dash-separated/);
  await assert.rejects(() => manager.create({ id: "ok", ref: "", workspace: "company-kb" }), /ref is required/);
  await assert.rejects(() => manager.create({ id: "ok", kind: "dir", ref: "relative/path" }), /absolute path/);
  await assert.rejects(() => manager.create({ id: "ok", ref: "https://x.git" }), /target a workspace/);
  assert.equal((await manager.list()).length, 1);
  assert.deepEqual(await manager.remove("team-kb"), { id: "team-kb", kind: "git", ref: "https://git.example/team/kb.git", workspace: "company-kb", branch: "main", intervalSeconds: 600, embedExtensions: "", embedExcludeDirs: "", enabled: true, lastRefresh: null });
  assert.equal(await manager.remove("team-kb"), null);
});

test("a dir source reindexes its directory into its target workspace via the embed pipeline", async () => {
  const captured = captureEmbed();
  const { manager } = await setup({ embedVault: captured.embedVault });
  const dir = await mkdtemp(path.join(tmpdir(), "any-obs-source-dir-"));
  await manager.create({ id: "handbook", kind: "dir", ref: dir, workspace: "company-kb" });

  const job = manager.requestRefresh("handbook");
  await waitFor(() => manager.job(job.id).status === "succeeded");

  assert.equal(captured.embeds.length, 1);
  const config = captured.embeds[0].config;
  assert.equal(config.workspaceSlug, "company-kb");
  assert.equal(config.vaultId, "handbook");
  assert.equal(config.vaultPath, dir);
  assert.equal(config.documentFolder, "anything-obsidian-vault-handbook");
  assert.match(config.stateDir, /manifests[\\/]handbook$/);
  const refreshed = await manager.get("handbook");
  assert.ok(refreshed.lastRefresh);
});

test("a git source clones first, then pulls on later refreshes", async () => {
  const { manager, gitCalls } = await setup({ embedVault: captureEmbed().embedVault });
  await manager.create({ id: "team-kb", kind: "git", ref: "https://git.example/team/kb.git", branch: "release", workspace: "company-kb" });

  const first = manager.requestRefresh("team-kb");
  await waitFor(() => manager.job(first.id).status === "succeeded");
  assert.deepEqual(gitCalls[0], ["clone", "--branch", "release", "https://git.example/team/kb.git", gitCalls[0][4]]);

  const second = manager.requestRefresh("team-kb");
  await waitFor(() => manager.job(second.id).status === "succeeded");
  assert.equal(gitCalls[1][0], "-C");
  assert.deepEqual(gitCalls[1].slice(2), ["pull", "--ff-only"]);
  assert.equal(gitCalls.length, 2);
});

test("refresh jobs run one at a time and failures surface on the job", async () => {
  let running = 0;
  let peak = 0;
  const embeds = [];
  const embedVault = async ({ config }) => {
    running += 1;
    peak = Math.max(peak, running);
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (config.vaultId === "broken") throw new Error("embed exploded");
      embeds.push(config.vaultId);
      return { scanned: 1, uploaded: 1, removed: 0, workspaceSlug: config.workspaceSlug };
    } finally {
      running -= 1;
    }
  };
  const { manager } = await setup({ embedVault });
  const dir = await mkdtemp(path.join(tmpdir(), "any-obs-source-dir-"));
  await manager.create({ id: "one", kind: "dir", ref: dir, workspace: "company-kb" });
  await manager.create({ id: "broken", kind: "dir", ref: dir, workspace: "company-kb" });

  const jobs = [manager.requestRefresh("one"), manager.requestRefresh("broken"), manager.requestRefresh("one")];
  await waitFor(() => jobs.every((job) => manager.job(job.id).finishedAt));

  assert.equal(peak, 1);
  assert.deepEqual(jobs.map((job) => manager.job(job.id).status), ["succeeded", "failed", "succeeded"]);
  assert.match(manager.job(jobs[1].id).error, /embed exploded/);
  assert.deepEqual(embeds, ["one", "one"]);
});

test("scheduled refreshes only queue enabled, due sources", async () => {
  let clock = 1_000_000;
  const { manager } = await setup({ embedVault: captureEmbed().embedVault, now: () => clock });
  const dirA = await mkdtemp(path.join(tmpdir(), "any-obs-due-a-"));
  const dirB = await mkdtemp(path.join(tmpdir(), "any-obs-due-b-"));
  await manager.create({ id: "due", kind: "dir", ref: dirA, intervalSeconds: 60, workspace: "company-kb" });
  await manager.create({ id: "paused", kind: "dir", ref: dirB, intervalSeconds: 60, enabled: false, workspace: "company-kb" });
  await manager.create({ id: "manual-only", kind: "dir", ref: dirB, intervalSeconds: 0, workspace: "company-kb" });

  assert.deepEqual(await manager.runDueSources(), ["due"]);
  await waitFor(() => manager.listJobs().length > 0 && manager.listJobs().every((job) => job.finishedAt));
  // Not due again within the interval.
  clock += 10_000;
  assert.deepEqual(await manager.runDueSources(), []);
  clock += 60_000;
  assert.deepEqual(await manager.runDueSources(), ["due"]);
});

test("the api key may be a resolver, picked up fresh by every job", async () => {
  let currentKey = "";
  const captured = [];
  const embedVault = async ({ config }) => {
    captured.push(config.apiKey);
    return { scanned: 1, uploaded: 1, removed: 0, workspaceSlug: config.workspaceSlug };
  };
  const dataDir = await mkdtemp(path.join(tmpdir(), "any-obs-sources-key-"));
  const manager = createSourceManager({
    dataDir,
    baseUrl: "http://anythingllm:3001",
    apiKey: async () => currentKey,
    embedVault,
    runGit: async () => "",
  });
  const dir = await mkdtemp(path.join(tmpdir(), "any-obs-sources-key-dir-"));
  await manager.create({ id: "handbook", kind: "dir", ref: dir, workspace: "company-kb" });

  // No key configured yet: the job fails with the gateway's own guidance,
  // not the client's init message.
  const first = manager.requestRefresh("handbook");
  await waitFor(() => manager.job(first.id).finishedAt);
  assert.equal(manager.job(first.id).status, "failed");
  assert.match(manager.job(first.id).error, /Settings tab/);

  // The key appears (as it does when saved in Settings) — the next job
  // picks it up without any restart.
  currentKey = "fresh-key";
  const second = manager.requestRefresh("handbook");
  await waitFor(() => manager.job(second.id).finishedAt);
  assert.equal(manager.job(second.id).status, "succeeded");
  // The empty-key run never reached the embedder (it fails in the pipeline).
  assert.deepEqual(captured, ["fresh-key"]);
});

async function setup(overrides = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "any-obs-gateway-sources-"));
  const gitCalls = [];
  const embeds = [];
  const manager = createSourceManager({
    dataDir,
    baseUrl: "http://anythingllm:3001",
    apiKey: "key",
        ...(overrides.embedVault ? { embedVault: overrides.embedVault } : {}),
    runGit: async (args) => {
      gitCalls.push(args);
      if (args[0] === "clone") {
        await mkdir(path.join(args[4], ".git"), { recursive: true });
        await writeFile(path.join(args[4], ".git", "HEAD"), "ref: refs/heads/main\n");
      }
      return "";
    },
    ...(overrides.now ? { now: overrides.now } : {}),
  });
  return { manager, gitCalls, embeds };
}

function captureEmbed() {
  const embeds = [];
  return { embeds, embedVault: async ({ config }) => {
    embeds.push({ config });
    return { scanned: 1, uploaded: 1, removed: 0, workspaceSlug: config.workspaceSlug };
  } };
}

async function waitFor(predicate, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not reached in time");
}
