import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { doctor } from "./doctor.mjs";
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

test("worker embed command runs embedVault with all flag", async () => {
  const calls = [];
  const code = await runWorker(["embed", "--all"], {}, {
    loadConfig: async () => ({ workspaceSlug: "notes" }),
    embedVault: async (options) => {
      calls.push(options);
      return { scanned: 1, uploaded: 1, removed: 0, workspaceSlug: "notes" };
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(calls, [{ config: { workspaceSlug: "notes" }, all: true }]);
});

test("worker sync embeds after successful push", async () => {
  const calls = [];
  const code = await runWorker(["sync"], {}, {
    loadConfig: async () => ({ gitAutoPush: true }),
    syncVaultOnce: async (options) => {
      calls.push(["sync", options]);
      return { pushed: true, embedded: false };
    },
    embedVault: async (options) => {
      calls.push(["embed", options]);
      return { scanned: 0, uploaded: 0, removed: 0, workspaceSlug: "obsidian" };
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(calls, [
    ["sync", { config: { gitAutoPush: true } }],
    ["embed", { config: { gitAutoPush: true }, all: false }],
  ]);
});

test("worker sync skips embedding after unsuccessful push", async () => {
  let embedCalls = 0;
  const code = await runWorker(["sync"], {}, {
    loadConfig: async () => ({ gitAutoPush: true }),
    syncVaultOnce: async () => ({ pushed: false, embedded: false }),
    embedVault: async () => {
      embedCalls += 1;
    },
  });

  assert.equal(code, 0);
  assert.equal(embedCalls, 0);
});

test("worker doctor returns non-zero when a check fails", async () => {
  const code = await runWorker(["doctor"], {}, {
    loadConfig: async () => ({}),
    doctor: async () => ({
      ok: false,
      checks: [{ name: "vault mount", ok: false, message: "missing" }],
    }),
  });

  assert.equal(code, 1);
});

test("worker command errors return non-zero", async () => {
  const code = await runWorker(["embed"], {}, {
    loadConfig: async () => ({}),
    embedVault: async () => {
      throw new Error("boom");
    },
  });

  assert.equal(code, 1);
});

test("doctor checks vault mount and AnythingLLM with injected fetch", async () => {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "anything-obsidian-vault-"));
  const requests = [];

  try {
    const result = await doctor({
      config: {
        anythingllmBaseUrl: "http://anythingllm:3001",
        apiKey: "key",
        vaultPath,
      },
      fetchImpl: async (url, options = {}) => {
        requests.push({ url, options });
        return { ok: true, status: 200 };
      },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(
      result.checks.map((check) => [check.name, check.ok]),
      [
        ["vault mount", true],
        ["anythingllm api docs", true],
        ["anythingllm api key", true],
      ],
    );
    assert.deepEqual(requests, [
      { url: "http://anythingllm:3001/api/docs", options: {} },
      {
        url: "http://anythingllm:3001/api/v1/workspaces",
        options: { headers: { Authorization: "Bearer key" } },
      },
    ]);
  } finally {
    await rm(vaultPath, { force: true, recursive: true });
  }
});
