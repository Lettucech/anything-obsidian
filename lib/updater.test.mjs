import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { activateRelease, updateApplication } from "./updater.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "any-obs-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appDir = root + "/app",
    candidate = root + "/candidate";
  await mkdir(appDir);
  await mkdir(candidate);
  await writeFile(appDir + "/release", "old");
  await writeFile(appDir + "/package.json", "{}");
  await writeFile(candidate + "/release", "new");
  const calls = [];
  const controller = {
    start: async () => calls.push("start"),
    stop: async () => calls.push("stop"),
  };
  return { root, appDir, candidate, controller, calls };
}

test("preparation failure leaves the existing release and services untouched", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    updateApplication({
      appRoot: f.root,
      root: f.root + "/data",
      controller: f.controller,
      verify: async () => ({ ok: true }),
      log: () => {},
      prepare: async () => {
        throw new Error("npm failed");
      },
    }),
    /npm failed/,
  );
  assert.equal(await readFile(f.appDir + "/release", "utf8"), "old");
  assert.deepEqual(f.calls, []);
});

test("successful activation retains the previous release and verifies the replacement", async (t) => {
  const f = await fixture(t);
  await activateRelease({ ...f, verify: async () => ({ ok: true }) });
  assert.equal(await readFile(f.appDir + "/release", "utf8"), "new");
  assert.equal(await readFile(f.appDir + ".previous/release", "utf8"), "old");
  assert.deepEqual(f.calls, ["stop", "start"]);
});

test("failed activation restores and verifies the old release", async (t) => {
  const f = await fixture(t);
  let checks = 0;
  await assert.rejects(
    activateRelease({ ...f, verify: async () => ({ ok: ++checks > 1 }) }),
    /Previous release restored and verified/,
  );
  assert.equal(await readFile(f.appDir + "/release", "utf8"), "old");
  assert.deepEqual(f.calls, ["stop", "start", "stop", "start"]);
});
