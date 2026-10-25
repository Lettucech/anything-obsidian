import path from "node:path";

import { createVaultRegistry } from "../lib/vault-registry.mjs";
import { createVaultSecretStore } from "../lib/vault-secrets.mjs";
import { configPaths, defaultConfigRoot } from "../lib/app-config.mjs";

function resolveBaseConfig(env) {
  return {
    anythingllmBaseUrl: stripTrailingSlash(env.ANYTHINGLLM_BASE_URL ?? ""),
    apiKey: env.ANYTHINGLLM_API_KEY ?? "",
    mcpBaseUrl: stripTrailingSlash(env.ANYTHINGLLM_MCP_BASE_URL ?? "http://127.0.0.1:21433"),
    vaultStateRoot: env.VAULT_STATE_ROOT ?? "",
  };
}

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}

export async function loadVaultConfig(env, vaultId) {
  const registry = registryFor(env);
  const vault = await registry.get(vaultId);
  if (!vault) throw new Error(`Unknown vault: ${vaultId}`);

  const base = resolveBaseConfig(env);
  const credential = await secretStoreFor(env).get(vault.id);
  const stateRoot = base.vaultStateRoot;
  const stateDir = path.join(stateRoot, "manifests", vault.id);

  return {
    ...base,
    vaultId: vault.id,
    vaultPath: registry.resolvePath(vault),
    workspaceSlug: vault.workspaceSlug,
    gitRemote: vault.gitRemote,
    gitBranch: vault.gitBranch,
    gitAutoPull: vault.gitAutoPull,
    gitAutoPush: vault.gitAutoPush,
    gitUserName: vault.gitUserName,
    gitUserEmail: vault.gitUserEmail,
    gitPushUrl: vault.gitPushUrl,
    gitCommitMessagePrefix: vault.gitCommitMessagePrefix,
    gitAuthUsername: credential?.username ?? "",
    gitAuthToken: credential?.token ?? "",
    stateDir,
    documentFolder: `anything-obsidian-vault-${vault.id}`,
    syncIntervalSeconds: vault.syncIntervalSeconds,
    embedAfterSync: vault.embedAfterSync,
    embedExtensions: vault.embedExtensions || undefined,
    embedExcludeDirs: vault.embedExcludeDirs || undefined,
  };
}

function defaultPaths() {
  return configPaths(defaultConfigRoot());
}

export function secretStoreFor(env) {
  return createVaultSecretStore({
    rootPath: env.VAULT_SECRETS_PATH || defaultPaths().secretsRoot,
  });
}

export function registryFor(env) {
  return createVaultRegistry({
    rootPath: env.VAULTS_ROOT || "",
    registryPath: env.VAULT_REGISTRY_PATH || defaultPaths().registryPath,
  });
}
