import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { createSyncStatusStore, syncStatusPath } from "./sync-status.mjs";

const dirs = [];
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function freshStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "anything-obsidian-sync-status-"));
  dirs.push(dir);
  return createSyncStatusStore({ filePath: path.join(dir, "state", "last-sync.json") });
}

test("record persists a normalized per-vault entry and get round-trips it", async () => {
  const store = await freshStore();

  const entry = await store.record("work", { status: "succeeded", pushed: true, embedded: false, finishedAt: "2026-10-15T00:00:00.000Z" });

  assert.deepEqual(entry, {
    status: "succeeded",
    finishedAt: "2026-10-15T00:00:00.000Z",
    pushed: true,
    embedded: false,
  });
  const reloaded = createSyncStatusStore({ filePath: store.filePath });
  assert.deepEqual(await reloaded.get("work"), entry);
  assert.equal(await reloaded.get("missing"), null);
});

test("record keeps a bounded error message on failures", async () => {
  const store = await freshStore();

  const entry = await store.record("work", { status: "failed", error: "x".repeat(900) });

  assert.equal(entry.status, "failed");
  assert.equal(entry.error.length, 500);
  assert.equal(await (await store.all()).work.status, "failed");
});

test("unknown status values normalize to succeeded", async () => {
  const store = await freshStore();
  const entry = await store.record("work", { status: "whatever" });
  assert.equal(entry.status, "succeeded");
});

test("a corrupt or missing file is treated as empty history", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "anything-obsidian-sync-status-"));
  dirs.push(dir);
  const filePath = path.join(dir, "last-sync.json");
  writeFileSync(filePath, "{not json");
  const corrupt = createSyncStatusStore({ filePath });
  assert.deepEqual(await corrupt.all(), {});

  const missing = createSyncStatusStore({ filePath: path.join(dir, "nope.json") });
  assert.deepEqual(await missing.all(), {});
});

test("syncStatusPath lives under the state root", () => {
  assert.equal(syncStatusPath("/data/state"), path.join("/data/state", "last-sync.json"));
});
