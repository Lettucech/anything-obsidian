import assert from "node:assert/strict";
import test from "node:test";

import { gitEnv, syncVaultOnce, shouldEmbedAfterSync } from "./watch-vault.mjs";

test("skips embedding when required git push fails", () => {
  assert.equal(
    shouldEmbedAfterSync({
      embedAfterSync: true,
      gitAutoPush: true,
      pushSucceeded: false,
    }),
    false,
  );
});

test("embeds when push is disabled or succeeds", () => {
  assert.equal(
    shouldEmbedAfterSync({
      embedAfterSync: true,
      gitAutoPush: false,
      pushSucceeded: false,
    }),
    true,
  );
  assert.equal(
    shouldEmbedAfterSync({
      embedAfterSync: true,
      gitAutoPush: true,
      pushSucceeded: true,
    }),
    true,
  );
});

test("git auth env is disabled when no auth token is configured", () => {
  assert.deepEqual(gitEnv({}), process.env);
});

test("git auth env uses askpass without putting token in command args", async () => {
  const calls = [];
  const config = {
    vaultPath: "/vault",
    gitRemote: "origin",
    gitBranch: "main",
    gitAutoPull: true,
    gitAutoPush: true,
    gitUserName: "anything-obsidian",
    gitUserEmail: "anything-obsidian@local",
    gitAuthUsername: "x-access-token",
    gitAuthToken: "ghp_secret",
  };

  await syncVaultOnce({
    config,
    deps: {
      run: async (command, args, options = {}) => {
        calls.push({ command, args, env: options.env });
      },
      capture: async () => "",
    },
  });

  const pull = calls.find((call) => call.args.includes("pull"));
  const push = calls.find((call) => call.args.includes("push"));

  assert.equal(pull.env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(pull.env.GIT_USERNAME, "x-access-token");
  assert.equal(pull.env.GIT_PASSWORD, "ghp_secret");
  assert.match(pull.env.GIT_ASKPASS, /git-askpass\.sh$/);
  assert.equal(push.env.GIT_PASSWORD, "ghp_secret");
  assert.equal(
    calls.some((call) => call.args.some((arg) => arg.includes("ghp_secret"))),
    false,
  );
});
