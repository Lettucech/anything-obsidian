import path from "node:path";

import { createVaultRegistry } from "../lib/vault-registry.mjs";
import { resolveConfig } from "./lib/env.mjs";

export async function loadVaultConfig(env, vaultId) {
  const registry = registryFor(env);
  const vault = await registry.get(vaultId);
  if (!vault) throw new Error(`Unknown vault: ${vaultId}`);

  const base = resolveConfig(env);
  const stateRoot = base.kbStateDir || "/workspace/.anything-obsidian-state";
  const stateDir = path.join(stateRoot, "manifests", vault.id);

  return {
    ...base,
    vaultId: vault.id,
    vaultPath: registry.resolvePath(vault),
    workspaceSlug: vault.workspaceSlug,
    gitRemote: vault.gitRemote,
    gitBranch: vault.gitBranch,
    stateDir,
    kbStateDir: stateDir,
    documentFolder: `anything-obsidian-vault/${vault.id}`,
    syncIntervalSeconds: vault.syncIntervalSeconds,
  };
}

export function registryFor(env) {
  return createVaultRegistry({
    rootPath: env.VAULTS_ROOT || "/vaults",
    registryPath: env.VAULT_REGISTRY_PATH || "/workspace/.anything-obsidian-registry/vaults.json",
  });
}
