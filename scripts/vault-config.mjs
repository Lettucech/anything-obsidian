import path from "node:path";

import { createVaultRegistry } from "../lib/vault-registry.mjs";
import { createVaultSecretStore } from "../lib/vault-secrets.mjs";
import { configPaths, defaultConfigRoot } from "../lib/app-config.mjs";
import { ensureUnifiedWorkspace, vaultDocumentFolder } from "../lib/unified-workspace.mjs";
import { createAnythingllmClient } from "../dashboard/anythingllm.mjs";

function resolveBaseConfig(env) {
  return {
    anythingllmBaseUrl: stripTrailingSlash(env.ANYTHINGLLM_BASE_URL ?? ""),
    apiKey: env.ANYTHINGLLM_API_KEY ?? "",
    mcpBaseUrl: stripTrailingSlash(env.ANYTHINGLLM_MCP_BASE_URL ?? "http://127.0.0.1:21503"),
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
  const stateRoot = base.vaultStateRoot || defaultPaths().stateRoot;
  const stateDir = path.join(stateRoot, "manifests", vault.id);

  // Headless callers (scheduler, worker commands) must survive the legacy
  // per-vault registry without a dashboard round-trip.
  let workspace = await registry.getWorkspace();
  if (!workspace) {
    ({ workspace } = await ensureUnifiedWorkspace({
      registry,
      anythingllm: createAnythingllmClient({
        baseUrl: base.anythingllmBaseUrl,
        apiKey: base.apiKey,
      }),
      stateRoot,
    }));
  }

  return {
    ...base,
    vaultId: vault.id,
    vaultPath: registry.resolvePath(vault),
    workspaceSlug: workspace.slug,
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
    documentFolder: vaultDocumentFolder(vault.id),
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
