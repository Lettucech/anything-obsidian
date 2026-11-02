import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createVaultRegistry } from "../lib/vault-registry.mjs";
import { createVaultSecretStore } from "../lib/vault-secrets.mjs";
import { loadVaultConfig } from "./vault-config.mjs";

test("loads the vault's own workspace, vault path, and embedding manifest directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "anything-obsidian-vaults-"));
  const registryPath = path.join(root, "registry", "vaults.json");
  const secretsPath = path.join(root, "secrets");
  const registry = createVaultRegistry({ rootPath: root, registryPath });
  await registry.create({
    id: "work",
    directory: "work",
    gitRemote: "origin",
    gitBranch: "main",
    gitAutoPull: false,
    gitAutoPush: false,
    gitUserName: "Work Bot",
    gitUserEmail: "work@example.test",
    gitPushUrl: "https://example.test/work.git",
    gitCommitMessagePrefix: "Sync work",
    embedAfterSync: false,
    embedExtensions: ".md,.canvas",
    embedExcludeDirs: ".git,.private",
  });
  await createVaultSecretStore({ rootPath: secretsPath }).save("work", {
    mode: "https-token",
    username: "oauth2",
    token: "work-token",
  });

  const originalFetch = globalThis.fetch;
  const created = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/v1/workspaces")
      return new Response(JSON.stringify({ workspaces: created }));
    if (parsed.pathname === "/api/v1/workspace/new") {
      const name = JSON.parse(init.body).name;
      created.push({ slug: name, name });
      return new Response(JSON.stringify({ workspace: { slug: name, name } }));
    }
    return new Response(JSON.stringify({}), { status: 404 });
  };
  try {
    const config = await loadVaultConfig(
      {
        VAULTS_ROOT: root,
        VAULT_REGISTRY_PATH: registryPath,
        VAULT_SECRETS_PATH: secretsPath,
        VAULT_STATE_ROOT: "/state",
        ANYTHINGLLM_BASE_URL: "http://upstream.test",
        ANYTHINGLLM_API_KEY: "key",
      },
      "work",
    );

    assert.equal(config.vaultPath, path.join(root, "work"));
    // A vault with no recorded slug gets its deterministic workspace minted.
    assert.match(config.workspaceSlug, /^any-obs-.*-work$/);
    assert.equal((await registry.get("work")).workspaceSlug, config.workspaceSlug);
    assert.equal(config.stateDir, "/state/manifests/work");
    assert.equal(config.documentFolder, "anything-obsidian-vault-work");
    assert.equal(config.gitAuthUsername, "oauth2");
    assert.equal(config.gitAuthToken, "work-token");
    assert.equal(config.gitAutoPull, false);
    assert.equal(config.gitAutoPush, false);
    assert.equal(config.gitUserName, "Work Bot");
    assert.equal(config.gitPushUrl, "https://example.test/work.git");
    assert.equal(config.embedAfterSync, false);
    assert.equal(config.embedExtensions, ".md,.canvas");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a queued worker cannot re-index a vault after removal begins or its registration changes", async (t) => {
  const { mkdir, writeFile, rm } = await import("node:fs/promises");
  const { loadVaultConfig } = await import("./vault-config.mjs");
  const root = await mkdtemp(path.join(tmpdir(), "any-obs-registration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = {
    VAULTS_ROOT: root + "/vaults",
    VAULT_REGISTRY_PATH: root + "/registry/vaults.json",
    VAULT_SECRETS_PATH: root + "/secrets",
    VAULT_STATE_ROOT: root + "/state",
    ANYTHINGLLM_BASE_URL: "http://fake.test",
    ANYTHINGLLM_API_KEY: "fake",
  };
  await mkdir(root + "/registry");
  const registry = {
    vaults: [{ id: "work", directory: "work", workspaceSlug: "shared", gitUserName: "Test", gitUserEmail: "x@y" }],
  };
  await writeFile(env.VAULT_REGISTRY_PATH, JSON.stringify(registry));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ workspaces: [{ slug: "shared" }] }));
  let config;
  try {
    config = await loadVaultConfig(env, "work");
  } finally {
    globalThis.fetch = originalFetch;
  }
  await config.assertRegistered();
  await mkdir(root + "/state/removals", { recursive: true });
  await writeFile(root + "/state/removals/work.json", "{}");
  await assert.rejects(config.assertRegistered(), /pending index cleanup/);
  await rm(root + "/state/removals/work.json");
  registry.vaults = [];
  await writeFile(env.VAULT_REGISTRY_PATH, JSON.stringify(registry));
  await assert.rejects(config.assertRegistered(), /no longer registered/);
});
