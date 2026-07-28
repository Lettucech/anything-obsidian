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

test("resolves only global service and worker infrastructure settings", () => {
  const config = resolveConfig({
    ANYTHINGLLM_API_KEY: "key",
    ANYTHINGLLM_BASE_URL: "http://custom:3001",
    ANYTHINGLLM_MCP_BASE_URL: "http://mcp.special:3333",
    VAULT_STATE_ROOT: "custom-state",
  });

  assert.equal(config.anythingllmBaseUrl, "http://custom:3001");
  assert.equal(config.mcpBaseUrl, "http://mcp.special:3333");
  assert.equal(config.vaultStateRoot, "custom-state");
  assert.equal(config.gitRemote, undefined);
});

test("worker rejects unknown commands", async () => {
  assert.equal(await runWorker(["wat"], {}), 2);
});

test("worker help succeeds", async () => {
  assert.equal(await runWorker(["--help"], {}), 0);
});

test("worker embed command runs embedVault with all flag", async () => {
  const calls = [];
  const code = await runWorker(["embed", "--all", "--vault", "work"], {}, {
    loadVaultConfig: async () => ({ workspaceSlug: "notes" }),
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
  const config = { gitAutoPush: true, embedAfterSync: true };
  const code = await runWorker(["sync", "--vault", "work"], {}, {
    loadVaultConfig: async () => config,
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
    ["sync", { config }],
    ["embed", { config, all: false }],
  ]);
});

test("worker sync skips embedding after unsuccessful push", async () => {
  let embedCalls = 0;
  const code = await runWorker(["sync", "--vault", "work"], {}, {
    loadVaultConfig: async () => ({ gitAutoPush: true, embedAfterSync: true }),
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
  const code = await runWorker(["sync", "--vault", "work"], {}, {
    logger: {
      info: (message) => messages.push(message),
      error: (message) => messages.push(message),
    },
    loadVaultConfig: async () => ({ gitAutoPush: true, embedAfterSync: true }),
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

test("worker requires a vault id for a managed command", async () => {
  assert.equal(await runWorker(["sync"], {}), 1);
});

test("worker doctor returns non-zero when a check fails", async () => {
  const code = await runWorker(["doctor", "--vault", "work"], {}, {
    loadVaultConfig: async () => ({}),
    doctor: async () => ({
      ok: false,
      checks: [{ name: "vault mount", ok: false, message: "missing" }],
    }),
  });

  assert.equal(code, 1);
});

test("worker command errors return non-zero", async () => {
  const code = await runWorker(["embed", "--vault", "work"], {}, {
    loadVaultConfig: async () => ({}),
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
        mcpBaseUrl: "http://mcp:3333",
        apiKey: "key",
        workspaceSlug: "obsidian",
        vaultPath,
        gitRemote: "origin",
        gitBranch: "main",
      },
      fetchImpl: async (url, options = {}) => {
        requests.push({ url, options });
        return { ok: true, status: 200 };
      },
      runGit: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
      readManifest: async () => ({ files: {} }),
    });

    assert.equal(result.ok, true);
    assert.deepEqual(
      result.checks.map((check) => [check.name, check.ok]),
      [
        ["vault mount", true],
        ["anythingllm api docs", true],
        ["anythingllm api key", true],
        ["git remote", true],
        ["mcp health", true],
        ["embedder probe", true],
        ["index drift", true],
      ],
    );
    assert.deepEqual(requests, [
      { url: "http://anythingllm:3001/api/docs", options: {} },
      {
        url: "http://anythingllm:3001/api/v1/workspaces",
        options: { headers: { Authorization: "Bearer key" } },
      },
      { url: "http://mcp:3333/health", options: {} },
      {
        url: "http://anythingllm:3001/api/v1/workspace/obsidian/vector-search",
        options: {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: "Bearer key",
          },
          body: JSON.stringify({ query: "doctor", topN: 1 }),
        },
      },
    ]);
  } finally {
    await rm(vaultPath, { force: true, recursive: true });
  }
});
