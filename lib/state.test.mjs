import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { writeJson, withFileLock } from "./state.mjs";

test("independent worker processes serialize writes to the same state", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "any-obs-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeJson(root + "/counter.json", { value: 0 });
  const moduleUrl = new URL("./state.mjs", import.meta.url).href;
  const script = `import {readFile} from 'node:fs/promises'; import {writeJson,withFileLock} from ${JSON.stringify(moduleUrl)};
await withFileLock(${JSON.stringify(root + "/counter.lock")}, async()=>{const file=${JSON.stringify(root + "/counter.json")};const state=JSON.parse(await readFile(file,'utf8'));await new Promise(r=>setTimeout(r,20));await writeJson(file,{value:state.value+1});});`;
  const run = () =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let error = "";
      child.stderr.on("data", (data) => (error += data));
      child.once("error", reject);
      child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(error))));
    });
  await Promise.all(Array.from({ length: 5 }, run));
  assert.equal(JSON.parse(await readFile(root + "/counter.json", "utf8")).value, 5);
});

test("a cancelled waiter cannot steal a live operation's lock", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "any-obs-lock-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let release, entered;
  const gate = new Promise((resolve) => (release = resolve)),
    ready = new Promise((resolve) => (entered = resolve));
  const first = withFileLock(root + "/work.lock", async () => {
    entered();
    await gate;
  });
  await ready;
  const controller = new AbortController();
  const second = withFileLock(root + "/work.lock", () => assert.fail("waiter entered"), {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(second);
  release();
  await first;
});
