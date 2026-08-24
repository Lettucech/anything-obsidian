#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CONTROLLED_SERVICES, LOG_SERVICES, classifySystemState, publicConfig } from "./config.mjs";
import { DockerClient } from "./docker-client.mjs";
import { createJobManager } from "./jobs.mjs";
import { redactSecretsObject, redactSecretsText } from "./redact.mjs";
import { createVaultRegistry } from "../lib/vault-registry.mjs";
import { createVaultSecretStore } from "../lib/vault-secrets.mjs";
import { createAnythingllmClient } from "./anythingllm.mjs";
import { createVaultStorage } from "./vault-storage.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(__dirname, "public");

export function createDashboardServer({
  docker = new DockerClient(),
  jobs = createJobManager({ docker }),
  env = process.env,
  fetchImpl = fetch,
  registry = createVaultRegistry({
    rootPath: env.VAULTS_ROOT || "/vaults",
    registryPath: env.VAULT_REGISTRY_PATH || "/workspace/.anything-obsidian-registry/vaults.json",
  }),
  anythingllm = createAnythingllmClient({
    baseUrl: env.ANYTHINGLLM_BASE_URL || "http://anythingllm:3001",
    apiKey: env.ANYTHINGLLM_API_KEY || "",
    fetchImpl,
  }),
  vaultStorage = createVaultStorage({ registry }),
  secrets = createVaultSecretStore({
    rootPath: env.VAULT_SECRETS_PATH || "/workspace/.anything-obsidian-secrets",
  }),
} = {}) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/") {
        if (await dashboardReady(anythingllm)) return await serveStatic(res, url.pathname);
        return sendHtml(res, 200, dashboardSetupPage(publicConfig(env).anythingllmUrl));
      }
      if (req.method === "GET" && url.pathname === "/api/vaults") {
        return sendJson(res, 200, { vaults: await registry.list() });
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
        const { gitAuth, repositoryVisibility, sourceMode = "clone", workspaceMode = "create", ...request } = input;
        const validationError = validateVaultCreation({ sourceMode, repositoryVisibility, gitAuth, request });
        if (validationError) return sendJson(res, 400, { error: validationError });
        const effectiveGitAuth = gitAuthForVisibility(repositoryVisibility, gitAuth);
        await verifyAnythingllmConnection(anythingllm);
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
        let workspace;
        if (workspaceMode === "create") {
          workspace = await anythingllm.createWorkspace({ name: vaultInput.name });
        } else if (workspaceMode === "attach") {
          workspace = (await anythingllm.listWorkspaces()).find(
            (candidate) => candidate.slug === vaultInput.workspaceSlug,
          );
          if (!workspace) return sendJson(res, 400, { error: "Workspace was not found" });
        } else {
          return sendJson(res, 400, { error: "workspaceMode must be create or attach" });
        }
        const vault = await registry.create({ ...vaultInput, workspaceSlug: workspace.slug });
        await secrets.save(vault.id, effectiveGitAuth);
        return sendJson(res, 201, vault);
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
        if (vault) await secrets.remove(id);
        return vault ? sendJson(res, 204, {}) : sendJson(res, 404, { error: "Vault was not found" });
      }
      if (req.method === "GET" && url.pathname === "/api/status") {
        return sendJson(res, 200, await statusPayload({ docker, jobs, env, fetchImpl }));
      }
      if (req.method === "POST" && url.pathname === "/api/system/on") {
        for (const service of Object.values(CONTROLLED_SERVICES)) await docker.startContainer(service.name);
        return sendJson(res, 200, await statusPayload({ docker, jobs, env, fetchImpl }));
      }
      if (req.method === "POST" && url.pathname === "/api/system/off") {
        await Promise.all(
          Object.values(CONTROLLED_SERVICES).map((service) => docker.stopContainer(service.name)),
        );
        return sendJson(res, 200, await statusPayload({ docker, jobs, env, fetchImpl }));
      }
      if (req.method === "GET" && url.pathname === "/api/logs") {
        const id = url.searchParams.get("service") || "";
        const service = LOG_SERVICES[id];
        if (!service) return sendJson(res, 400, { error: `Unknown log service: ${id}` });
        const logs = redactSecretsText(await docker.containerLogs(service.name, { tail: 300 }));
        return sendJson(res, 200, { service: id, logs });
      }
      const vaultActionMatch = url.pathname.match(/^\/api\/vaults\/([a-z0-9-]+)\/actions\/([a-z-]+)$/);
      if (req.method === "POST" && vaultActionMatch) {
        const [, vaultId, actionId] = vaultActionMatch;
        if (!["sync", "embed", "embed-all", "doctor"].includes(actionId)) {
          return sendJson(res, 404, { error: `Unknown action: ${actionId}` });
        }
        if (!(await registry.get(vaultId))) return sendJson(res, 404, { error: "Vault was not found" });
        const snapshot = await serviceSnapshot({ docker, fetchImpl });
        try {
          const job = await jobs.start(vaultId, actionId, snapshot);
          return sendJson(res, 202, job);
        } catch (error) {
          return sendJson(res, 409, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
        const id = url.pathname.slice("/api/jobs/".length);
        const job = jobs.get(id);
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
      throw new Error("AnythingLLM rejected the dashboard API key. Add a valid ANYTHINGLLM_API_KEY to .env, then recreate the dashboard.");
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

async function statusPayload({ docker, jobs, env, fetchImpl }) {
  const services = await serviceSnapshot({ docker, fetchImpl });
  return redactSecretsObject({
    ok: true,
    systemState: classifySystemState(services),
    services,
    latestJob: jobs.latest(),
    jobs: jobs.list?.() ?? [],
    config: publicConfig(env),
  });
}

async function serviceSnapshot({ docker, fetchImpl }) {
  return await Promise.all(
    Object.values(CONTROLLED_SERVICES).map(async (service) => {
      const inspected = await docker.inspectContainer(service.name);
      const health = !inspected.running
        ? { ok: false, status: "not-running" }
        : service.health
          ? await probeHealth(fetchImpl, service.health.url, service.health.okStatus)
          : { ok: true, status: "running" };
      return { ...inspected, id: service.id, label: service.label, health };
    }),
  );
}

async function probeHealth(fetchImpl, url, okStatus) {
  try {
    const response = await fetchImpl(url);
    return { ok: response.status === okStatus || response.ok, status: response.status };
  } catch (error) {
    return { ok: false, status: error instanceof Error ? error.message : String(error) };
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
      <ol>
        <li>Open AnythingLLM and finish its initial setup.</li>
        <li>Go to <strong>Settings → Developer API</strong> and create an API key.</li>
        <li>Save it in this project's <code>.env</code> as <code>ANYTHINGLLM_API_KEY=...</code>.</li>
        <li>Run <code>docker compose up -d --force-recreate dashboard mcp</code>, then refresh this page.</li>
      </ol>
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.DASHBOARD_PORT || 3000);
  createDashboardServer().listen(port, "0.0.0.0", () => {
    console.error(`[anything-obsidian-dashboard] listening on ${port}`);
  });
}
