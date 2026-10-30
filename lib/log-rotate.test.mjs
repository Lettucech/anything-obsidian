import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile, open } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { rotateLogs } from "./log-rotate.mjs";

const dirs = [];
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function freshRoot() {
  const dir = await mkdtemp(path.join(tmpdir(), "anything-obsidian-log-rotate-"));
  dirs.push(dir);
  return dir;
}

test("small logs are left alone", async () => {
  const root = await freshRoot();
  await writeFile(path.join(root, "scheduler.log"), "tiny");

  const rotated = await rotateLogs({ logsRoot: root });

  assert.deepEqual(rotated, []);
  assert.equal(existsSync(path.join(root, "scheduler.log.1")), false);
});

test("an oversized log is rotated to .1 and the old .1 chain shifts", async () => {
  const root = await freshRoot();
  const big = "x".repeat(1000);
  await writeFile(path.join(root, "dashboard.log"), big);
  await writeFile(path.join(root, "dashboard.log.1"), "old-1");
  await writeFile(path.join(root, "dashboard.log.2"), "old-2");
  await writeFile(path.join(root, "scheduler.log"), "small");

  const rotated = await rotateLogs({ logsRoot: root, maxBytes: 500 });

  assert.deepEqual(rotated, [{ file: "dashboard.log", sizeBytes: 1000 }]);
  assert.equal((await stat(path.join(root, "dashboard.log"))).size, 0);
  assert.equal((await stat(path.join(root, "dashboard.log.1"))).size, 1000);
  assert.equal((await readFile(path.join(root, "dashboard.log.2")))?.toString(), "old-1");
  assert.equal(existsSync(path.join(root, "dashboard.log.3")), false);
  assert.equal(existsSync(path.join(root, "scheduler.log")), true);
});

test("a missing logs directory is a no-op", async () => {
  const rotated = await rotateLogs({ logsRoot: path.join(await freshRoot(), "nope") });
  assert.deepEqual(rotated, []);
});

test("an already-open supervisor log descriptor continues writing to the current log after rotation", async () => {
  const root = await freshRoot();
  const file = path.join(root, "gateway.log");
  const handle = await open(file, "a");
  try {
    await handle.write("old output");
    await rotateLogs({ logsRoot: root, maxBytes: 2 });
    await handle.write("new output");
    assert.equal(await readFile(file, "utf8"), "new output");
    assert.equal(await readFile(`${file}.1`, "utf8"), "old output");
  } finally {
    await handle.close();
  }
});
