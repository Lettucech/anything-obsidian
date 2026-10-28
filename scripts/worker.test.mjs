import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { doctor } from "./doctor.mjs";
import { runWorker, syncAndEmbed } from "./worker.mjs";

test("vault config resolves service endpoints from the environment without docker defaults", async () => {
  const { loadVaultConfig } = await import("./vault-config.mjs");
  const root = await mkdtemp(path.join(tmpdir(), "anything-obsidian-vault-config-"));
  const env = {
    VAULTS_ROOT: path.join(root, "v"),
    VAULT_REGISTRY_PATH: path.join(root, "registry", "vaults.json"),
    VAULT_SECRETS_PATH: path.join(root, "secrets"),
    VAULT_STATE_ROOT: path.join(root, "state"),
    ANYTHINGLLM_BASE_URL: "http://custom:3001/",
    ANYTHINGLLM_API_KEY: "key",
  };
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(path.dirname(env.VAULT_REGISTRY_PATH), { recursive: true });
  await writeFile(env.VAULT_REGISTRY_PATH, JSON.stringify({
    workspace: { slug: "any-obs-custom-01", name: "Anything Obsidian" },
    vaults: [{ id: "work", name: "w", directory: "work", gitUserName: "A", gitUserEmail: "a@b" }],
  }));
  const config = await loadVaultConfig(env, "work");
  assert.equal(config.anythingllmBaseUrl, "http://custom:3001");
  assert.equal(config.mcpBaseUrl, "http://127.0.0.1:21433");
  assert.equal(config.vaultStateRoot, env.VAULT_STATE_ROOT);
  assert.equal(config.workspaceSlug, "any-obs-custom-01");
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
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              success: true,
              documents: [{ location: "anything-obsidian-vault-doctor/doctor-probe.json" }],
            }),
        };
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
        ["anythingllm upload probe", true],
        ["git remote", true],
        ["mcp health", true],
        ["embedder probe", true],
        ["index drift", true],
      ],
    );
    const normalized = requests.map(({ url, options }) => {
      const normalizedOptions = { ...options };
      if (normalizedOptions.body instanceof FormData) normalizedOptions.body = "<form-data>";
      return { url, options: normalizedOptions };
    });
    assert.deepEqual(normalized, [
      { url: "http://anythingllm:3001/api/docs", options: {} },
      {
        url: "http://anythingllm:3001/api/v1/workspaces",
        options: { headers: { Authorization: "Bearer key" } },
      },
      {
        url: "http://anythingllm:3001/api/v1/document/upload/anything-obsidian-vault-doctor",
        options: {
          method: "POST",
          headers: { Authorization: "Bearer key" },
          body: "<form-data>",
        },
      },
      {
        url: "http://anythingllm:3001/api/v1/document/remove-folder",
        options: {
          method: "DELETE",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: "Bearer key",
          },
          body: JSON.stringify({ name: "anything-obsidian-vault-doctor" }),
        },
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

test("worker sync records status and notifies on failure", async () => {
  const records = [];
  const notifications = [];
  const store = { record: async (vaultId, entry) => { records.push({ vaultId, entry }); return entry; } };
  const worker = {
    logger: { info() {}, error() {} },
    syncVaultOnce: async () => { throw new Error("git push rejected"); },
    shouldEmbedAfterSync: () => true,
    embedVault: async () => ({ scanned: 0, uploaded: 0, removed: 0 }),
    syncStatusStore: () => store,
    notify: async (title, body) => { notifications.push({ title, body }); },
  };

  await assert.rejects(
    () => syncAndEmbed({ worker, config: { vaultId: "work", gitAutoPush: true, embedAfterSync: true } }),
    /git push rejected/,
  );

  assert.deepEqual(records, [{ vaultId: "work", entry: { status: "failed", error: "git push rejected" } }]);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, "Anything Obsidian sync failed");
  assert.match(notifications[0].body, /work/);
});

test("worker sync records a successful run without notifying", async () => {
  const records = [];
  const notifications = [];
  const store = { record: async (vaultId, entry) => { records.push({ vaultId, entry }); return entry; } };
  const worker = {
    logger: { info() {}, error() {} },
    syncVaultOnce: async () => ({ pushed: true }),
    shouldEmbedAfterSync: () => true,
    embedVault: async () => ({ scanned: 2, uploaded: 2, removed: 0 }),
    syncStatusStore: () => store,
    notify: async (title, body) => { notifications.push({ title, body }); },
  };

  await syncAndEmbed({ worker, config: { vaultId: "work", gitAutoPush: true, embedAfterSync: true } });

  assert.deepEqual(records, [{ vaultId: "work", entry: { status: "succeeded", pushed: true, embedded: true } }]);
  assert.deepEqual(notifications, []);
});
