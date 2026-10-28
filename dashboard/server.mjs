#!/usr/bin/env node
import { execFile as nodeExecFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { classifySystemState, publicConfig } from "./config.mjs";
import { createLocalJobManager, readSchedulerStatus, startSchedulerProcess, stopSchedulerProcess, tailLogFile } from "./local-jobs.mjs";
import { redactSecretsObject, redactSecretsText } from "./redact.mjs";
import { createVaultRegistry } from "../lib/vault-registry.mjs";
import { createVaultSecretStore } from "../lib/vault-secrets.mjs";
import { createAgentTokenStore } from "../lib/agent-tokens.mjs";
import { createAnythingllmClient } from "./anythingllm.mjs";
import { createVaultStorage } from "./vault-storage.mjs";
import { importTree } from "./import-tree.mjs";
import { createFileJobStore } from "./job-store.mjs";
import { createSyncStatusStore } from "../lib/sync-status.mjs";
import { createServiceManager } from "../lib/autostart.mjs";
import { rotateLogs } from "../lib/log-rotate.mjs";
import { compareVersions, currentVersionValue, fetchLatestVersion } from "../lib/update-check.mjs";
import { ensureUnifiedWorkspace, purgeVaultEmbeddings } from "../lib/unified-workspace.mjs";
import { configPaths, defaultConfigRoot } from "../lib/app-config.mjs";
import { randomBytes } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(__dirname, "public");
const NATIVE_LOG_IDS = new Set(["syncer", "scheduler"]);

export function createDashboardServer({
  env = process.env,
  jobs,
  fetchImpl = fetch,
  native = {},
  platform = process.platform,
  launchctl,
  systemctl,
  registry = createVaultRegistry({
    rootPath: env.VAULTS_ROOT || "",
    registryPath: env.VAULT_REGISTRY_PATH || "",
  }),
  anythingllm = createAnythingllmClient({
    baseUrl: env.ANYTHINGLLM_BASE_URL || "",
    apiKey: env.ANYTHINGLLM_API_KEY || "",
    fetchImpl,
  }),
  vaultStorage = createVaultStorage({ registry }),
  secrets = createVaultSecretStore({
    rootPath: env.VAULT_SECRETS_PATH || "",
  }),
  agentTokens = createAgentTokenStore({
    rootPath: env.AGENT_TOKENS_PATH || "",
  }),
} = {}) {
  if (!native?.schedulerPidPath) {
    throw new Error("native paths are required (schedulerPidPath, schedulerLogPath)");
  }
  const jobManager = jobs
    || createLocalJobManager({ env, jobStore: native.jobStorePath ? createFileJobStore({ filePath: native.jobStorePath }) : null });
  const context = { env, fetchImpl, native, anythingllm, registry, jobs: jobManager, platform, launchctl, systemctl };
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/") {
        if (await dashboardReady(anythingllm)) return await serveStatic(res, url.pathname);
        return sendHtml(res, 200, dashboardSetupPage(publicConfig(env).anythingllmUrl));
      }
      if (req.method === "GET" && url.pathname === "/api/vaults") {
        const vaults = await registry.list();
        const syncStatus = native.lastSyncPath ? await createSyncStatusStore({ filePath: native.lastSyncPath }).all() : {};
        return sendJson(res, 200, { vaults: vaults.map((vault) => ({ ...vault, lastSync: syncStatus[vault.id] ?? null })) });
      }
      if (req.method === "POST" && url.pathname === "/api/vaults/test-connection") {
        const input = await readJsonBody(req);
        const { gitAuth, repositoryVisibility, repositoryUrl } = input;
        const validationError = validateRepositoryConnection({ repositoryVisibility, gitAuth });
        if (validationError) return sendJson(res, 400, { error: validationError });
        await testVaultConnection({ vaultStorage, anythingllm, repositoryUrl, gitAuth: gitAuthForVisibility(repositoryVisibility, gitAuth) });
        return sendJson(res, 200, { git: { ok: true }, anythingllm: { ok: true } });
      }
      if (req.method === "POST" && url.pathname === "/api/vaults") {
        const input = await readJsonBody(req);
        const { gitAuth, repositoryVisibility, sourceMode = "clone", workspaceMode, workspaceSlug, ...request } = input;
        const validationError = validateVaultCreation({ sourceMode, repositoryVisibility, gitAuth, request });
        if (validationError) return sendJson(res, 400, { error: validationError });
        const effectiveGitAuth = gitAuthForVisibility(repositoryVisibility, gitAuth);
        await verifyAnythingllmConnection(anythingllm);
        // One unified workspace per instance; the legacy per-vault
        // workspaceMode/attach fields only seed the first-time attach.
        await ensureUnifiedWorkspace({
          registry,
          anythingllm,
          stateRoot: stateRootFor(env),
          attachSlug: workspaceMode === "attach" && workspaceSlug ? String(workspaceSlug) : "",
        });
        let discovered;
        if (sourceMode === "clone") {
          await vaultStorage.testConnection({ repositoryUrl: request.repositoryUrl, gitAuth: effectiveGitAuth });
          discovered = await vaultStorage.clone({ ...request, gitAuth: effectiveGitAuth });
        } else if (sourceMode === "import") {
          discovered = await vaultStorage.import(request);
        } else {
          return sendJson(res, 400, { error: "sourceMode must be clone or import" });
        }
        const vaultInput = {
          ...request,
          ...discovered,
          gitAuthMode: effectiveGitAuth?.mode === "https-token" ? "https-token" : "none",
        };
        const vault = await registry.create(vaultInput);
        await secrets.save(vault.id, effectiveGitAuth);
        return sendJson(res, 201, vault);
      }
      if (req.method === "GET" && url.pathname === "/api/workspace") {
        return sendJson(res, 200, { workspace: await registry.getWorkspace() });
      }
      if (req.method === "POST" && url.pathname === "/api/workspace/attach") {
        const input = await readJsonBody(req);
        const slug = String(input?.slug ?? "").trim();
        if (!slug) return sendJson(res, 400, { error: "slug is required" });
        const workspace = (await anythingllm.listWorkspaces()).find((candidate) => candidate.slug === slug);
        if (!workspace) return sendJson(res, 400, { error: "Workspace was not found" });
        await registry.setWorkspace(workspace);
        // Switching the unified workspace invalidates every embed manifest.
        const stateRoot = stateRootFor(env);
        if (stateRoot) {
          const { rm } = await import("node:fs/promises");
          await rm(path.join(stateRoot, "manifests"), { recursive: true, force: true });
        }
        return sendJson(res, 200, { workspace });
      }
      if (req.method === "PATCH" && url.pathname.startsWith("/api/vaults/")) {
        const id = url.pathname.slice("/api/vaults/".length);
        const input = await readJsonBody(req);
        const { gitAuth, ...changes } = input;
        const vault = await registry.update(id, changes);
        if (vault && gitAuth) await secrets.save(id, gitAuth);
        return vault ? sendJson(res, 200, vault) : sendJson(res, 404, { error: "Vault was not found" });
      }
      if (req.method === "DELETE" && url.pathname.startsWith("/api/vaults/")) {
        const id = url.pathname.slice("/api/vaults/".length);
        const vault = await registry.remove(id);
        if (!vault) return sendJson(res, 404, { error: "Vault was not found" });
        await secrets.remove(id);
        // The repository and user files stay; the vault's derived chunks must
        // leave the shared index or they would pollute every search.
        const workspace = await registry.getWorkspace();
        if (workspace) {
          const purge = await purgeVaultEmbeddings({
            baseUrl: env.ANYTHINGLLM_BASE_URL || "",
            apiKey: env.ANYTHINGLLM_API_KEY || "",
            workspaceSlug: workspace.slug,
            vaultId: vault.id,
            stateRoot: stateRootFor(env),
            fetchImpl,
          });
          if (!purge.purged) console.error(`Embedding purge for vault '${vault.id}' incomplete:`, purge.errors);
        }
        return sendJson(res, 204, {});
      }
      if (req.method === "GET" && url.pathname === "/api/agents") {
        return sendJson(res, 200, { agents: await agentTokens.list() });
      }
      if (req.method === "POST" && url.pathname === "/api/agents") {
        const input = await readJsonBody(req);
        const name = String(input?.name ?? "").trim();
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
          return sendJson(res, 400, { error: "Agent name must be lowercase dash-separated text" });
        }
        const { agent, token } = await agentTokens.create(name);
        return sendJson(res, 201, { agent, token });
      }
      if (req.method === "DELETE" && url.pathname.startsWith("/api/agents/")) {
        const name = url.pathname.slice("/api/agents/".length);
        const removed = await agentTokens.remove(name);
        if (!removed) return sendJson(res, 404, { error: "Agent was not found" });
        const vaults = await registry.list();
        const referencedBy = vaults
          .filter((vault) => Array.isArray(vault.allowlist) && vault.allowlist.includes(name))
          .map((vault) => vault.id);
        return sendJson(res, 200, { removed: true, referencedBy });
      }
      if (req.method === "GET" && url.pathname === "/api/status") {
        return sendJson(res, 200, await statusPayload(context));
      }
      if (req.method === "POST" && url.pathname === "/api/system/on") {
        startSchedulerProcess({
          env: { ...env },
          pidPath: native.schedulerPidPath,
          logPath: native.schedulerLogPath,
          spawnImpl: native.spawnImpl,
          killImpl: native.killImpl,
        });
        return sendJson(res, 200, await statusPayload(context));
      }
      if (req.method === "POST" && url.pathname === "/api/system/off") {
        await stopSchedulerProcess({ pidPath: native.schedulerPidPath, killImpl: native.killImpl });
        return sendJson(res, 200, await statusPayload(context));
      }
      if (url.pathname === "/api/autostart") {
        const manager = serviceManagerFor(context);
        if (req.method === "GET") {
          const enabled = await manager.enabled();
          const lanEnabled = await manager.lanEnabled();
          const services = enabled || lanEnabled ? await manager.status() : null;
          return sendJson(res, 200, { enabled, lanEnabled, ...(services ? { services } : {}) });
        }
        if (req.method === "POST") {
          const input = await readJsonBody(req);
          if (input.action !== "on" && input.action !== "off") {
            return sendJson(res, 400, { error: "action must be on or off" });
          }
          if (input.action === "on") {
            await manager.enable({
              dashboardLogPath: native.schedulerLogPath.replace(/scheduler\.log$/, "dashboard.log"),
              schedulerLogPath: native.schedulerLogPath,
              mcpLogPath: native.schedulerLogPath.replace(/scheduler\.log$/, "mcp.log"),
            });
          } else {
            await manager.disable();
          }
          const enabled = await manager.enabled();
          return sendJson(res, 200, { enabled, lanEnabled: await manager.lanEnabled() });
        }
      }
      if (url.pathname === "/api/lan") {
        const manager = serviceManagerFor(context);
        if (req.method === "GET") {
          return sendJson(res, 200, { enabled: await manager.lanEnabled() });
        }
        if (req.method === "POST") {
          const input = await readJsonBody(req);
          if (input.action === "token") {
            if (!String(input.token ?? "").trim()) return sendJson(res, 400, { error: "token is required" });
            await registryUpdateLanToken(env, String(input.token).trim());
            return sendJson(res, 200, { tokenConfigured: true });
          }
          if (input.action !== "on" && input.action !== "off") {
            return sendJson(res, 400, { error: "action must be on, off, or token" });
          }
          if (input.action === "off") {
            await manager.disableLan();
            return sendJson(res, 200, { enabled: false });
          }
          let lanToken = await readLanToken(env);
          let generated = null;
          if (!lanToken) {
            generated = randomBytes(24).toString("base64url");
            await registryUpdateLanToken(env, generated);
            lanToken = generated;
          }
          await manager.enableLan({ mcpLanLogPath: native.schedulerLogPath.replace(/scheduler\.log$/, "mcp-lan.log") });
          return sendJson(res, 200, { enabled: true, ...(generated ? { token: generated } : {}) });
        }
      }
      if (req.method === "GET" && url.pathname === "/api/logs") {
        const id = url.searchParams.get("service") || "";
        if (!NATIVE_LOG_IDS.has(id)) return sendJson(res, 400, { error: `Unknown log service: ${id}` });
        const logs = redactSecretsText(tailLogFile(native.schedulerLogPath));
        return sendJson(res, 200, { service: id, logs });
      }
      if (req.method === "GET" && url.pathname === "/api/import-tree") {
        try {
          const tree = await importTree({
            vaultsRoot: env.VAULTS_ROOT || "",
            requestedPath: url.searchParams.get("path") || "",
          });
          return sendJson(res, 200, tree);
        } catch (error) {
          return sendJson(res, error?.statusCode || 500, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      const vaultActionMatch = url.pathname.match(/^\/api\/vaults\/([a-z0-9-]+)\/actions\/([a-z-]+)$/);
      if (req.method === "POST" && vaultActionMatch) {
        const [, vaultId, actionId] = vaultActionMatch;
        if (!["sync", "embed", "embed-all", "doctor"].includes(actionId)) {
          return sendJson(res, 404, { error: `Unknown action: ${actionId}` });
        }
        if (!(await registry.get(vaultId))) return sendJson(res, 404, { error: "Vault was not found" });
        const snapshot = await serviceSnapshot(context);
        try {
          const job = await jobManager.start(vaultId, actionId, snapshot);
          return sendJson(res, 202, job);
        } catch (error) {
          return sendJson(res, 409, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
        const id = url.pathname.slice("/api/jobs/".length);
        const job = jobManager.get(id);
        return job ? sendJson(res, 200, job) : sendJson(res, 404, { error: `Unknown job: ${id}` });
      }
      if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
        return await serveStatic(res, url.pathname);
      }
      return sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

function validateVaultCreation({ sourceMode, repositoryVisibility, gitAuth, request }) {
  if (!String(request.gitUserName ?? "").trim()) return "Git commit author name is required";
  if (!String(request.gitUserEmail ?? "").trim()) return "Git commit email is required";
  // Importing a directory that already lives on this machine never contacts a
  // remote, so clone credentials cannot be verified (or used) for it.
  if (sourceMode === "import" && String(request.importPath ?? "").trim()) return "";
  return validateRepositoryConnection({ repositoryVisibility, gitAuth });
}

function validateRepositoryConnection({ repositoryVisibility, gitAuth }) {
  if (!['public', 'private'].includes(repositoryVisibility)) {
    return "repositoryVisibility must be public or private";
  }
  if (repositoryVisibility === "private" && (!String(gitAuth?.username ?? "").trim() || !String(gitAuth?.token ?? "").trim())) {
    return "Private repositories require an HTTPS username and token";
  }
  return "";
}

function gitAuthForVisibility(repositoryVisibility, gitAuth) {
  return repositoryVisibility === "public" ? { mode: "none" } : gitAuth;
}

async function testVaultConnection({ vaultStorage, anythingllm, repositoryUrl, gitAuth }) {
  await vaultStorage.testConnection({ repositoryUrl, gitAuth });
  await verifyAnythingllmConnection(anythingllm);
}

async function verifyAnythingllmConnection(anythingllm) {
  try {
    await anythingllm.listWorkspaces();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/AnythingLLM API (401|403)/.test(detail)) {
      throw new Error("AnythingLLM rejected the configured API key. Re-run: anything-obsidian init --vaults-root <path> --url <url> --api-key <key>");
    }
    throw error;
  }
}

async function dashboardReady(anythingllm) {
  try {
    await verifyAnythingllmConnection(anythingllm);
    return true;
  } catch {
    return false;
  }
}

function serviceManagerFor({ env, native, platform, launchctl, systemctl }) {
  return createServiceManager({
    platform,
    ...(env.HOME ? { homedir: env.HOME } : {}),
    ...(launchctl ? { launchctl } : {}),
    ...(systemctl ? { systemctl } : {}),
    logsRoot: path.dirname(native.schedulerLogPath || path.join(os.homedir(), "logs")),
  });
}

function stateRootFor(env) {
  return env.VAULT_STATE_ROOT || configPaths(defaultConfigRoot({ env })).stateRoot;
}

async function configStoreFor(env) {
  const { createAppConfigStore, defaultConfigRoot } = await import("../lib/app-config.mjs");
  const rootDir = env.ANYTHING_OBSIDIAN_HOME || defaultConfigRoot({ env });
  return createAppConfigStore({ rootDir });
}

async function readLanToken(env) {
  const config = await (await configStoreFor(env)).load();
  return config?.lanToken ?? null;
}

async function registryUpdateLanToken(env, token) {
  const store = await configStoreFor(env);
  const config = await store.load();
  if (!config) throw new Error("This app is not initialized yet. Run: anything-obsidian init");
  await store.save({ ...config, lanToken: token });
}

async function statusPayload(context) {
  const { jobs, env, fetchImpl, native, anythingllm, registry, platform, launchctl, systemctl } = context;
  const services = await serviceSnapshot({ anythingllm, native, fetchImpl, env });
  let lanEnabled = false;
  try {
    lanEnabled = await serviceManagerFor(context).lanEnabled();
  } catch {
    lanEnabled = false;
  }
  const current = await currentVersionValue();
  const latest = await fetchLatestVersion({ fetchImpl });
  return redactSecretsObject({
    ok: true,
    systemState: classifySystemState(services),
    services,
    workspace: await registry.getWorkspace(),
    latestJob: jobs.latest(),
    jobs: jobs.list?.() ?? [],
    config: publicConfig(env),
    update: { current, latest, available: Boolean(latest) && compareVersions(current, latest) < 0 },
    lan: { enabled: lanEnabled },
  });
}

async function serviceSnapshot({ anythingllm, native, fetchImpl, env = {} }) {
  // Ports come from the service environment so a test never probes whatever
  // happens to be listening on the real machine's MCP ports.
  const mcpPort = Number(env.MCP_PORT ?? 21433);
  const mcpLanPort = Number(env.MCP_LAN_PORT ?? 21444);
  const [anythingllmHealth, schedulerStatus, gitHealth, mcpHealth, mcpLanHealth] = await Promise.all([
    probeAnythingllm(anythingllm),
    Promise.resolve(readSchedulerStatus({ pidPath: native.schedulerPidPath, killImpl: native.killImpl })),
    probeGit(native.execFileImpl || promisify(nodeExecFile)),
    probeHttp(fetchImpl, `http://127.0.0.1:${mcpPort}/health`),
    probeHttp(fetchImpl, `http://127.0.0.1:${mcpLanPort}/health`),
  ]);
  return [
    {
      id: "anythingllm",
      label: "AnythingLLM",
      found: true,
      running: anythingllmHealth.ok,
      state: anythingllmHealth.ok ? "connected" : "unreachable",
      health: anythingllmHealth,
    },
    {
      id: "scheduler",
      label: "Scheduler",
      found: true,
      running: schedulerStatus.running,
      state: schedulerStatus.running ? `running (pid ${schedulerStatus.pid})` : "stopped",
      health: { ok: schedulerStatus.running, status: schedulerStatus.running ? "running" : "stopped" },
    },
    {
      id: "mcp",
      label: "MCP",
      found: true,
      powerManaged: false,
      running: mcpHealth.ok,
      state: mcpHealth.ok ? "running (loopback 21433)" : "stopped",
      health: mcpHealth.ok ? mcpHealth : { ok: false, status: "stopped" },
    },
    {
      id: "mcp-lan",
      label: "MCP (LAN)",
      found: true,
      powerManaged: false,
      running: mcpLanHealth.ok,
      state: mcpLanHealth.ok ? "running (21444, token required)" : "off",
      health: mcpLanHealth.ok ? mcpLanHealth : { ok: true, status: "off by default" },
    },
    {
      id: "git",
      label: "Git",
      found: true,
      running: gitHealth.ok,
      state: gitHealth.ok ? "available" : "missing",
      health: gitHealth,
    },
  ];
}

async function probeHttp(fetchImpl, url) {
  try {
    const response = await (fetchImpl || fetch)(url);
    return { ok: response.ok, status: response.status };
  } catch {
    return { ok: false, status: "not running" };
  }
}

async function probeAnythingllm(anythingllm) {
  try {
    await anythingllm.listWorkspaces();
    return { ok: true, status: "ok" };
  } catch (error) {
    return { ok: false, status: error instanceof Error ? error.message : String(error) };
  }
}

async function probeGit(execFileImpl) {
  try {
    const { stdout } = await execFileImpl("git", ["--version"]);
    return { ok: true, status: String(stdout).trim() || "available" };
  } catch {
    return { ok: false, status: "git command not found" };
  }
}

async function serveStatic(res, pathname) {
  const file = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const fullPath = path.resolve(publicRoot, file);
  const relative = path.relative(publicRoot, fullPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return sendJson(res, 403, { error: "Forbidden" });
  let body;
  try {
    body = await readFile(fullPath);
  } catch (error) {
    if (error?.code === "ENOENT") return sendJson(res, 404, { error: "Not found" });
    throw error;
  }
  res.writeHead(200, { "content-type": contentType(file) });
  res.end(body);
}

function contentType(file) {
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "text/html; charset=utf-8";
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendHtml(res, status, body) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

function dashboardSetupPage(anythingllmUrl) {
  const anythingllm = escapeHtml(anythingllmUrl);
  const steps = `<ol>
        <li>Open AnythingLLM and finish its initial setup.</li>
        <li>Go to <strong>Settings → Developer API</strong> and create an API key.</li>
        <li>Run <code>anything-obsidian init</code> and enter the URL and API key.</li>
        <li>Restart with <code>anything-obsidian start</code>, then refresh this page.</li>
      </ol>`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#111a2b" />
    <title>Anything Obsidian setup</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #111a2b; color: #f6f8ff; }
      body { display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 24px; box-sizing: border-box; }
      main { width: min(620px, 100%); padding: clamp(28px, 6vw, 52px); border: 1px solid #314260; border-radius: 20px; background: #18243a; box-shadow: 0 28px 80px rgb(0 0 0 / 28%); }
      p { color: #b8c4d9; line-height: 1.6; } ol { padding-left: 1.3rem; color: #dce5f5; line-height: 1.8; } code { padding: .15rem .35rem; border-radius: 5px; background: #0e1728; } a { display: inline-block; margin-top: 12px; border-radius: 9px; padding: 10px 14px; color: #07111e; background: #92d8ff; font-weight: 700; text-decoration: none; }
    </style>
  </head>
  <body>
    <main>
      <p>Anything Obsidian</p>
      <h1>AnythingLLM setup required</h1>
      <p>The dashboard could not verify a valid <code>ANYTHINGLLM_API_KEY</code>, so vault management is unavailable until setup is complete.</p>
      ${steps}
      <a href="${anythingllm}" target="_blank" rel="noreferrer">Open AnythingLLM</a>
    </main>
  </body>
</html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

async function readJsonBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64 * 1024) throw new Error("Request body is too large");
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new Error("Request body must be JSON");
  }
}

if (import.meta.url === entryUrl()) {
  rotateLogs({ logsRoot: path.join(path.dirname(process.env.AO_LAST_SYNC_PATH || ""), "logs") }).catch(() => {});
  const port = Number(process.env.DASHBOARD_PORT || 21400);
  createDashboardServer({
    native: {
      schedulerPidPath: process.env.AO_SCHEDULER_PID_PATH,
      schedulerLogPath: process.env.AO_SCHEDULER_LOG_PATH,
      jobStorePath: process.env.AO_JOB_STORE_PATH,
      lastSyncPath: process.env.AO_LAST_SYNC_PATH,
    },
  }).listen(port, "127.0.0.1", () => {
    console.error(`[anything-obsidian-dashboard] listening on 127.0.0.1:${port}`);
  });
}

function entryUrl() {
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return pathToFileURL(path.resolve(process.argv[1])).href;
  }
}
