import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createVaultRegistry } from "../lib/vault-registry.mjs";
import { createVaultSecretStore } from "../lib/vault-secrets.mjs";
import { loadVaultConfig } from "./vault-config.mjs";

test("loads a vault-scoped workspace, path, and embedding manifest directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "anything-obsidian-vaults-"));
  const registryPath = path.join(root, "registry", "vaults.json");
  const secretsPath = path.join(root, "secrets");
  const registry = createVaultRegistry({ rootPath: root, registryPath });
  await registry.create({
    id: "work", directory: "work", workspaceSlug: "work-space", gitRemote: "origin", gitBranch: "main",
    gitAutoPull: false, gitAutoPush: false, gitUserName: "Work Bot", gitUserEmail: "work@example.test",
    gitPushUrl: "https://example.test/work.git", gitCommitMessagePrefix: "Sync work", embedAfterSync: false,
    embedExtensions: ".md,.canvas", embedExcludeDirs: ".git,.private",
  });
  await createVaultSecretStore({ rootPath: secretsPath }).save("work", { mode: "https-token", username: "oauth2", token: "work-token" });

  const config = await loadVaultConfig({
    VAULTS_ROOT: root,
    VAULT_REGISTRY_PATH: registryPath,
    VAULT_SECRETS_PATH: secretsPath,
    VAULT_STATE_ROOT: "/state",
  }, "work");

  assert.equal(config.vaultPath, path.join(root, "work"));
  assert.equal(config.workspaceSlug, "work-space");
  assert.equal(config.stateDir, "/state/manifests/work");
  assert.equal(config.documentFolder, "anything-obsidian-vault/work");
  assert.equal(config.gitAuthUsername, "oauth2");
  assert.equal(config.gitAuthToken, "work-token");
  assert.equal(config.gitAutoPull, false);
  assert.equal(config.gitAutoPush, false);
  assert.equal(config.gitUserName, "Work Bot");
  assert.equal(config.gitPushUrl, "https://example.test/work.git");
  assert.equal(config.embedAfterSync, false);
  assert.equal(config.embedExtensions, ".md,.canvas");
});
