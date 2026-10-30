import { chmod, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { writeJson } from "./state.mjs";
import { syncStatusPath } from "./sync-status.mjs";

export const DEFAULT_DASHBOARD_PORT = 21502;

export function defaultConfigRoot({
  env = process.env,
  platform = process.platform,
  homedir = os.homedir(),
} = {}) {
  if (env.ANYTHING_OBSIDIAN_HOME) return path.resolve(env.ANYTHING_OBSIDIAN_HOME);
  if (platform === "darwin")
    return path.join(homedir, "Library", "Application Support", "anything-obsidian");
  if (platform === "win32")
    return path.join(env.APPDATA || path.join(homedir, "AppData", "Roaming"), "anything-obsidian");
  return path.join(env.XDG_CONFIG_HOME || path.join(homedir, ".config"), "anything-obsidian");
}

export function configPaths(rootDir) {
  const root = path.resolve(rootDir);
  return {
    root,
    configPath: path.join(root, "config.json"),
    registryPath: path.join(root, "registry", "vaults.json"),
    secretsRoot: path.join(root, "secrets"),
    agentTokensRoot: path.join(root, "agent-tokens"),
    stateRoot: path.join(root, "state"),
    logsRoot: path.join(root, "logs"),
    runRoot: path.join(root, "run"),
    schedulerPidPath: path.join(root, "run", "scheduler.pid"),
    schedulerLogPath: path.join(root, "logs", "scheduler.log"),
    dashboardPidPath: path.join(root, "run", "dashboard.pid"),
    dashboardLogPath: path.join(root, "logs", "dashboard.log"),
    mcpLogPath: path.join(root, "logs", "mcp.log"),
    mcpLanLogPath: path.join(root, "logs", "mcp-lan.log"),
    jobStorePath: path.join(root, "state", "jobs.json"),
    displayRoot: path.join(root, "display"),
  };
}

export function createAppConfigStore({ rootDir = defaultConfigRoot() } = {}) {
  const paths = configPaths(rootDir);

  return {
    paths,
    async load() {
      try {
        return normalizeConfig(JSON.parse(await readFile(paths.configPath, "utf8")));
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
    },
    async save(input) {
      const config = normalizeConfig(input);
      await mkdir(paths.root, { recursive: true, mode: 0o700 });
      await chmod(paths.root, 0o700);
      await writeJson(paths.configPath, config);
      await ensureLayout(paths);
      return config;
    },
    async ensureLayout() {
      return ensureLayout(paths);
    },
  };
}

export async function ensureLayout(paths) {
  for (const dir of [
    paths.registryPath && path.dirname(paths.registryPath),
    paths.secretsRoot,
    paths.agentTokensRoot,
    paths.stateRoot,
    paths.logsRoot,
    paths.runRoot,
  ]) {
    await mkdir(dir, { recursive: true });
  }
  await chmod(paths.secretsRoot, 0o700);
}

function normalizeConfig(input = {}) {
  const vaultsRoot = expandTilde(String(input.vaultsRoot ?? "").trim());
  if (!path.isAbsolute(vaultsRoot)) {
    throw new Error("vaultsRoot must be an absolute path");
  }
  const anythingllmBaseUrl = stripTrailingSlash(String(input.anythingllmBaseUrl ?? "").trim());
  let parsedUrl;
  try {
    parsedUrl = new URL(anythingllmBaseUrl);
  } catch {
    throw new Error("anythingllmBaseUrl must be an HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("anythingllmBaseUrl must be an HTTP(S) URL");
  }
  const apiKey = String(input.apiKey ?? "").trim();
  if (!apiKey) throw new Error("apiKey is required");

  const dashboardPort = Number(input.dashboardPort ?? DEFAULT_DASHBOARD_PORT);
  if (!Number.isInteger(dashboardPort) || dashboardPort < 1 || dashboardPort > 65535) {
    throw new Error("dashboardPort must be an integer between 1 and 65535");
  }
  const lanToken = String(input.lanToken ?? "").trim();
  if (parsedUrl.username || parsedUrl.password)
    throw new Error("Keep URL credentials in the API key field");
  return {
    vaultsRoot,
    anythingllmBaseUrl,
    apiKey,
    dashboardPort,
    ...(lanToken ? { lanToken } : {}),
    ...(input.mcpAllowedHosts ? { mcpAllowedHosts: String(input.mcpAllowedHosts) } : {}),
    ...(input.notifications === false ? { notifications: false } : {}),
  };
}

export function nativeEnv(config, paths, { env = process.env } = {}) {
  return {
    ...(env.AO_CONTAINER === "1"
      ? { AO_CONTAINER: "1", AO_CONTAINER_ROLE: env.AO_CONTAINER_ROLE }
      : {}),
    PATH: env.PATH,
    HOME: env.HOME,
    AO_NOTIFY: env.AO_CONTAINER === "1" || config.notifications === false ? "0" : "1",
    MCP_ALLOWED_HOSTS: config.mcpAllowedHosts || "",
    VAULTS_ROOT: config.vaultsRoot,
    VAULT_REGISTRY_PATH: paths.registryPath,
    VAULT_SECRETS_PATH: paths.secretsRoot,
    VAULT_STATE_ROOT: paths.stateRoot,
    AGENT_TOKENS_PATH: paths.agentTokensRoot,
    ANYTHINGLLM_BASE_URL: config.anythingllmBaseUrl,
    ANYTHINGLLM_API_KEY: config.apiKey,
    DASHBOARD_PORT: String(config.dashboardPort),
    AO_SCHEDULER_PID_PATH: paths.schedulerPidPath,
    AO_SCHEDULER_LOG_PATH: paths.schedulerLogPath,
    AO_JOB_STORE_PATH: paths.jobStorePath,
    AO_LAST_SYNC_PATH: syncStatusPath(paths.stateRoot),
    AO_DASHBOARD_URL: `http://127.0.0.1:${config.dashboardPort}`,
    ANYTHING_OBSIDIAN_HOME: paths.root,
    HOST_VAULTS_ROOT: config.vaultsRoot,
  };
}

export function expandTilde(value, homedir = os.homedir()) {
  if (value === "~") return homedir;
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(homedir, value.slice(2));
  return value;
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}
