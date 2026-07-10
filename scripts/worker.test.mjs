import assert from "node:assert/strict";
import test from "node:test";

import { loadEnvText, resolveConfig } from "./lib/env.mjs";
import { runWorker } from "./worker.mjs";

test("parses simple env text without shell evaluation", () => {
  assert.deepEqual(loadEnvText("A=one\nB=\"two dollars $$\"\n# comment\n"), {
    A: "one",
    B: "two dollars $$",
  });
});

test("resolves Docker worker defaults", () => {
  const config = resolveConfig({
    ANYTHINGLLM_API_KEY: "key",
    HOST_VAULT_PATH: "/Users/me/vault",
  });

  assert.equal(config.anythingllmBaseUrl, "http://anythingllm:3001");
  assert.equal(config.apiKey, "key");
  assert.equal(config.workspaceSlug, "obsidian");
  assert.equal(config.vaultPath, "/vault");
  assert.equal(config.gitRemote, "origin");
  assert.equal(config.gitBranch, "main");
  assert.equal(config.gitAutoPull, true);
  assert.equal(config.gitAutoPush, true);
});

test("worker config honors explicit container values", () => {
  const config = resolveConfig({
    ANYTHINGLLM_API_KEY: "key",
    ANYTHINGLLM_BASE_URL: "http://custom:3001",
    ANYTHINGLLM_WORKSPACE_SLUG: "notes",
    VAULT_PATH: "/mounted-vault",
    KB_GIT_AUTO_PULL: "false",
    KB_GIT_AUTO_PUSH: "0",
  });

  assert.equal(config.anythingllmBaseUrl, "http://custom:3001");
  assert.equal(config.workspaceSlug, "notes");
  assert.equal(config.vaultPath, "/mounted-vault");
  assert.equal(config.gitAutoPull, false);
  assert.equal(config.gitAutoPush, false);
});

test("worker rejects unknown commands", async () => {
  assert.equal(await runWorker(["wat"], {}), 2);
});

test("worker help succeeds", async () => {
  assert.equal(await runWorker(["--help"], {}), 0);
});
