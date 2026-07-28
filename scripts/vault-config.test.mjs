import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createVaultRegistry } from "../lib/vault-registry.mjs";
import { loadVaultConfig } from "./vault-config.mjs";

test("loads a vault-scoped workspace, path, and embedding manifest directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "anything-obsidian-vaults-"));
  const registryPath = path.join(root, "registry", "vaults.json");
  const registry = createVaultRegistry({ rootPath: root, registryPath });
  await registry.create({ id: "work", directory: "work", workspaceSlug: "work-space", gitRemote: "origin", gitBranch: "main" });

  const config = await loadVaultConfig({
    VAULTS_ROOT: root,
    VAULT_REGISTRY_PATH: registryPath,
    KB_STATE_DIR: "/state",
  }, "work");

  assert.equal(config.vaultPath, path.join(root, "work"));
  assert.equal(config.workspaceSlug, "work-space");
  assert.equal(config.stateDir, "/state/manifests/work");
  assert.equal(config.documentFolder, "anything-obsidian-vault/work");
});
