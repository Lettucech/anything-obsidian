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
  assert.equal(config.gitAuthUsername, "x-access-token");
  assert.equal(config.gitAuthToken, "");
  assert.equal(config.mcpBaseUrl, "http://mcp:3333");
  assert.equal(config.kbStateDir, "");
});

test("worker config honors explicit container values", () => {
  const config = resolveConfig({
    ANYTHINGLLM_API_KEY: "key",
    ANYTHINGLLM_BASE_URL: "http://custom:3001",
    ANYTHINGLLM_WORKSPACE_SLUG: "notes",
    VAULT_PATH: "/mounted-vault",
    KB_GIT_AUTO_PULL: "false",
    KB_GIT_AUTO_PUSH: "0",
    KB_GIT_AUTH_USERNAME: "token-user",
    KB_GIT_AUTH_TOKEN: "secret",
    ANYTHINGLLM_MCP_BASE_URL: "http://mcp.special:3333",
    KB_STATE_DIR: "custom-state",
  });

  assert.equal(config.anythingllmBaseUrl, "http://custom:3001");
  assert.equal(config.workspaceSlug, "notes");
  assert.equal(config.vaultPath, "/mounted-vault");
  assert.equal(config.gitAutoPull, false);
  assert.equal(config.gitAutoPush, false);
  assert.equal(config.gitAuthUsername, "token-user");
  assert.equal(config.gitAuthToken, "secret");
  assert.equal(config.mcpBaseUrl, "http://mcp.special:3333");
  assert.equal(config.kbStateDir, "custom-state");
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

test("worker sync logs progress", async () => {
  const messages = [];
  const code = await runWorker(["sync"], {}, {
    logger: {
      info: (message) => messages.push(message),
      error: (message) => messages.push(message),
    },
    loadConfig: async () => ({ gitAutoPush: true }),
    syncVaultOnce: async () => ({ pushed: true, embedded: false }),
    embedVault: async () => ({ scanned: 3, uploaded: 2, removed: 1, workspaceSlug: "obsidian" }),
  });

  assert.equal(code, 0);
  assert.deepEqual(messages, [
    "Sync started",
    "Git sync completed; pushed=true",
    "Embedding started",
    "Embedding completed; scanned=3 uploaded=2 removed=1 workspace=obsidian",
    "Sync completed; embedded=true",
  ]);
});

test("worker autosync keeps syncing until stopped", async () => {
  const calls = [];
  const sleeps = [];
  const code = await runWorker(["autosync"], { KB_SYNC_INTERVAL_SECONDS: "12" }, {
    loadConfig: async () => ({ gitAutoPush: true }),
    syncVaultOnce: async (options) => {
      calls.push(["sync", options]);
      return { pushed: true, embedded: false };
    },
    embedVault: async (options) => {
      calls.push(["embed", options]);
      return { scanned: 0, uploaded: 0, removed: 0, workspaceSlug: "obsidian" };
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      if (sleeps.length === 2) return false;
      return true;
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(calls, [
    ["sync", { config: { gitAutoPush: true } }],
    ["embed", { config: { gitAutoPush: true }, all: false }],
    ["sync", { config: { gitAutoPush: true } }],
    ["embed", { config: { gitAutoPush: true }, all: false }],
  ]);
  assert.deepEqual(sleeps, [12_000, 12_000]);
});

test("worker autosync reads interval from loaded env", async () => {
  const sleeps = [];
  const code = await runWorker(["autosync"], {}, {
    loadEnv: async () => ({ KB_SYNC_INTERVAL_SECONDS: "7" }),
    loadConfig: async () => ({ gitAutoPush: false }),
    syncVaultOnce: async () => ({ pushed: true, embedded: false }),
    embedVault: async () => ({ scanned: 0, uploaded: 0, removed: 0, workspaceSlug: "obsidian" }),
    sleep: async (ms) => {
      sleeps.push(ms);
      return false;
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(sleeps, [7_000]);
});

test("worker autosync logs errors and retries later", async () => {
  let attempts = 0;
  const sleeps = [];
  const errors = [];
  const code = await runWorker(["autosync"], { KB_SYNC_INTERVAL_SECONDS: "bad" }, {
    logger: {
      info: () => {},
      error: (message) => errors.push(message),
    },
    loadConfig: async () => ({ gitAutoPush: true }),
    syncVaultOnce: async () => {
      attempts += 1;
      throw new Error("Missing ANYTHINGLLM_API_KEY in .env.");
    },
    embedVault: async () => {
      throw new Error("should not embed when sync fails");
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      return false;
    },
  });

  assert.equal(code, 0);
  assert.equal(attempts, 1);
  assert.deepEqual(sleeps, [300_000]);
  assert.deepEqual(errors, ["Autosync round failed: Missing ANYTHINGLLM_API_KEY in .env."]);
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
