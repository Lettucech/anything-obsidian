import { readFile } from "node:fs/promises";

export async function loadEnvFile(filePath) {
  try {
    return loadEnvText(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

export function loadEnvText(text) {
  const values = {};

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    if (!/^[A-Z0-9_]+$/.test(key)) continue;
    values[key] = parseEnvValue(trimmed.slice(index + 1).trim());
  }

  return values;
}

export function resolveConfig(env) {
  return {
    anythingllmBaseUrl: stripTrailingSlash(
      env.ANYTHINGLLM_BASE_URL ?? "http://anythingllm:3001",
    ),
    apiKey: env.ANYTHINGLLM_API_KEY ?? "",
    workspaceSlug: env.ANYTHINGLLM_WORKSPACE_SLUG ?? "obsidian",
    vaultPath: env.VAULT_PATH ?? "/vault",
    gitRemote: env.KB_GIT_REMOTE ?? "origin",
    gitBranch: env.KB_GIT_BRANCH ?? "main",
    gitAutoPull: bool(env.KB_GIT_AUTO_PULL, true),
    gitAutoPush: bool(env.KB_GIT_AUTO_PUSH, true),
    gitUserName: env.KB_GIT_USER_NAME ?? "anything-obsidian",
    gitUserEmail: env.KB_GIT_USER_EMAIL ?? "anything-obsidian@local",
    gitAuthUsername: env.KB_GIT_AUTH_USERNAME ?? "x-access-token",
    gitAuthToken: env.KB_GIT_AUTH_TOKEN ?? "",
    gitPushUrl: env.KB_GIT_PUSH_URL ?? "",
    mcpBaseUrl: stripTrailingSlash(env.ANYTHINGLLM_MCP_BASE_URL ?? "http://mcp:3333"),
    kbStateDir: env.KB_STATE_DIR ?? "",
    // Optional overrides; left undefined when unset so embeddableVaultFiles applies
    // its own DEFAULT_EMBED_EXTENSIONS / DEFAULT_EMBED_EXCLUDE_DIRS (single source).
    embedExtensions: env.KB_EMBED_EXTENSIONS,
    embedExcludeDirs: env.KB_EMBED_EXCLUDE_DIRS,
  };
}

function parseEnvValue(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function bool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}
