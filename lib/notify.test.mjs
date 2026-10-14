import assert from "node:assert/strict";
import test from "node:test";

import { createNotifier } from "./notify.mjs";

test("darwin notifications go through osascript with quoted strings", async () => {
  const calls = [];
  const notifier = createNotifier({
    platform: "darwin",
    env: {},
    execFileImpl: async (command, args) => {
      calls.push({ command, args });
    },
  });

  assert.equal(await notifier.notify("Sync failed", "vault 'work' — boom \"x\""), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "osascript");
  assert.deepEqual(calls[0].args, [
    "-e",
    `display notification ${JSON.stringify("vault 'work' — boom \"x\"")} with title ${JSON.stringify("Sync failed")}`,
  ]);
});

test("linux notifications go through notify-send", async () => {
  const calls = [];
  const notifier = createNotifier({
    platform: "linux",
    env: {},
    execFileImpl: async (command, args) => {
      calls.push({ command, args });
    },
  });

  assert.equal(await notifier.notify("Sync failed", "work"), true);
  assert.deepEqual(calls[0], { command: "notify-send", args: ["Sync failed", "work"] });
});

test("AO_NOTIFY=0 disables notifications entirely", async () => {
  const calls = [];
  const notifier = createNotifier({
    platform: "darwin",
    env: { AO_NOTIFY: "0" },
    execFileImpl: async (...args) => {
      calls.push(args);
    },
  });

  assert.equal(await notifier.notify("t", "b"), false);
  assert.deepEqual(calls, []);
});

test("a failing notifier never throws and reports false", async () => {
  const lines = [];
  const notifier = createNotifier({
    platform: "darwin",
    env: {},
    execFileImpl: async () => {
      throw new Error("osascript not found");
    },
    logger: { error: (line) => lines.push(line) },
  });

  assert.equal(await notifier.notify("t", "b"), false);
  assert.equal(lines.length, 1);
});

test("unsupported platforms are a no-op", async () => {
  const notifier = createNotifier({ platform: "win32", env: {} });
  assert.equal(await notifier.notify("t", "b"), false);
});
