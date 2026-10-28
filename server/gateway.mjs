#!/usr/bin/env node
// The any-obs gateway: IAM front door for a shared AnythingLLM. Holds the
// single admin API key, issues per-user tokens, enforces entitlements on
// every proxied call, fans searches out across entitled workspaces, serves
// a token-gated RAG-only MCP endpoint, and runs the shared-source pipeline
// that is the only writer to the shared workspace.
//
// Ports and posture: the gateway is the only compose service published to
// the LAN (default 21500). AnythingLLM itself is never published; its chat
// UI stays reachable only from the server host.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { createUserStore } from "./iam.mjs";
import { createGatewayConfig } from "./gateway-config.mjs";
import { decide } from "./proxy-rules.mjs";
import { fanoutSearch } from "./fanout.mjs";
import { createSourceManager } from "./sources.mjs";
import { joinUrl, stripTrailingSlash } from "./http-utils.mjs";

export const DEFAULT_GATEWAY_PORT = 21500;
const pkg = await readPackageInfo();
const dashboardRoot = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "dashboard");

export function createGatewayServer({
  env = process.env,
  userStore,
  sourceManager,
  gatewayConfig = createGatewayConfig({ dataDir: env.GATEWAY_DATA_DIR ? path.resolve(env.GATEWAY_DATA_DIR) : path.join(env.HOME ?? ".", ".anything-obsidian-gateway") }),
  anythingllmBaseUrl = env.ANYTHINGLLM_BASE_URL ?? "",
  anythingllmApiKey = env.ANYTHINGLLM_API_KEY ?? "",
  sharedWorkspaceSlug = env.SHARED_WORKSPACE_SLUG ?? "shared",
  adminToken = env.GATEWAY_ADMIN_TOKEN ?? "",
  bootstrapToken = env.GATEWAY_BOOTSTRAP_TOKEN ?? "",
  fetchImpl = fetch,
}) {
  const baseUrl = stripTrailingSlash(anythingllmBaseUrl);
  // Wizard-collected secrets live in the data volume; both are cached here
  // at boot and refreshed whenever setup writes them, so token checks stay
  // synchronous.
  let configuredAdminToken = "";
  let configuredApiKey = "";
  void gatewayConfig.load().then((state) => {
    configuredAdminToken = state.adminToken;
    configuredApiKey = state.apiKey;
  }).catch(() => {});

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://gateway");

      if (req.method === "GET" && url.pathname === "/health") {
        return await sendHealth(res);
      }

      if (url.pathname === "/api/setup/state" && req.method === "GET") {
        return sendJson(res, 200, await setupState());
      }

      if (url.pathname === "/api/setup/admin-token") {
        return await handleSetupAdminToken(req, res);
      }

      if (url.pathname === "/api/setup/api-key") {
        return await handleSetupApiKey(req, res);
      }

      const identity = resolveIdentity(req.headers.authorization);

      if (url.pathname === "/mcp") {
        if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
        if (!identity) return sendJson(res, 401, { error: "Bearer token required" });
        const body = await readRawBody(req);
        const server = buildMcpServer(identity);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
          transport.close();
          server.close();
        });
        await server.connect(transport);
        req.headers["content-type"] = "application/json";
        return await transport.handleRequest(req, res, body.length ? JSON.parse(body.toString("utf8")) : undefined);
      }

      if (url.pathname.startsWith("/api/gateway/")) {
        return await handleGatewayApi({ req, res, url, identity, body: await maybeJson(req) });
      }

      if (url.pathname.startsWith("/api/")) {
        return await handleProxy({ req, res, url, identity });
      }

      if (req.method === "GET") {
        return await serveDashboard(res, url.pathname);
      }

      return sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      if (!res.headersSent) return sendJson(res, status, { error: detail });
      res.end();
    }
  });

  async function serveDashboard(res, pathname) {
    const file = pathname === "/" ? "index.html" : pathname.replace(/^\/dashboard\/?/, "").replace(/^\/+/, "");
    if (!file || file.includes("..")) return serveDashboardFile(res, "index.html");
    return serveDashboardFile(res, file);
  }

  async function serveDashboardFile(res, file) {
    let body;
    try {
      const { readFile } = await import("node:fs/promises");
      body = await readFile(path.join(dashboardRoot, file));
    } catch {
      return sendJson(res, 404, { error: "Not found" });
    }
    res.writeHead(200, { "content-type": file.endsWith(".js") ? "text/javascript; charset=utf-8" : file.endsWith(".css") ? "text/css; charset=utf-8" : "text/html; charset=utf-8" });
    res.end(body);
  }

  function apiKeyActive() {
    // Env wins for non-interactive deployments; the wizard-collected key is
    // the default path.
    return anythingllmApiKey || configuredApiKey;
  }

  function adminTokenActive() {
    return adminToken || configuredAdminToken;
  }

  function resolveIdentity(header) {
    const match = /^Bearer\s+(.+)$/i.exec(String(header ?? ""));
    if (!match) return null;
    const token = match[1].trim();
    const activeAdmin = adminTokenActive();
    if (activeAdmin && token === activeAdmin) return { kind: "admin" };
    return userStore.verify(token);
  }

  async function sendHealth(res) {
    const state = await gatewayConfig.load();
    return sendJson(res, 200, {
      ok: true,
      name: "any-obs-gateway",
      version: pkg.version,
      sharedWorkspace: sharedWorkspaceSlug,
      configured: Boolean((anythingllmApiKey && adminToken) || (state.apiKey && state.adminToken)),
      needsSetup: await needsSetup(),
      users: (await userStore.list()).length,
    });
  }

  async function needsSetup() {
    if (anythingllmApiKey && adminToken) return false;
    return !(await gatewayConfig.configured());
  }

  async function setupState() {
    const needs = await needsSetup();
    const envBased = Boolean(anythingllmApiKey && adminToken);
    const state = await gatewayConfig.load();
    return {
      needsSetup: needs,
      anythingllmBaseUrl: baseUrl,
      anythingllmUiUrl: "http://localhost:21501",
      sharedWorkspace: sharedWorkspaceSlug,
      hasAdminCredential: Boolean(adminToken || state.adminToken),
      hasApiKey: Boolean(anythingllmApiKey || state.apiKey),
      // Hardened deployments preset a credential; the wizard then demands
      // it. Otherwise first-run runs as an open claim window.
      credentialRequired: Boolean(adminToken || bootstrapToken),
      envBased,
    };
  }

  // The setup endpoints only exist while the gateway is unconfigured; once
  // the wizard completes they disappear (403) so they can never re-open the
  // front door on a running deployment.
  async function guardSetup() {
    if (!(await needsSetup())) throw httpError(403, "Gateway is already configured; setup is closed");
  }

  function presentedBearer(req) {
    const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ""));
    return match?.[1]?.trim() ?? "";
  }

  // First contact follows the self-hosted claim model by default: with no
  // preset credential the first dashboard visitor mints the admin token, so
  // a fresh deployment should complete setup immediately. Operators who
  // want the window closed can preset GATEWAY_ADMIN_TOKEN (or a bootstrap
  // token) and the wizard demands it instead.
  function setupAuthorized(req) {
    if (!adminTokenActive() && !bootstrapToken) return true;
    const presented = presentedBearer(req);
    if (!presented) return false;
    if (adminTokenActive() && presented === adminTokenActive()) return true;
    return Boolean(bootstrapToken) && presented === bootstrapToken;
  }

  async function handleSetupAdminToken(req, res) {
    if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
    await guardSetup();

    // An env-preset admin token is the credential; the caller must prove
    // they hold it before anything is handed back.
    if (adminToken) {
      if (!setupAuthorized(req)) throw httpError(401, "Bearer token required (the preset gateway admin or bootstrap token)");
      return sendJson(res, 200, { adminToken, stored: false });
    }

    const state = await gatewayConfig.load();
    // Once minted, the credential is never displayed again — a later
    // visitor of the same wizard learns only that it is claimed.
    if (state.adminToken) return sendJson(res, 200, { alreadyClaimed: true });

    if (!setupAuthorized(req)) throw httpError(401, "Bearer token required (the preset gateway admin or bootstrap token)");
    const generated = randomBytes(24).toString("base64url");
    await gatewayConfig.save({ adminToken: generated });
    configuredAdminToken = generated;
    return sendJson(res, 201, { adminToken: generated, stored: true });
  }

  async function handleSetupApiKey(req, res) {
    if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
    await guardSetup();
    if (!setupAuthorized(req)) throw httpError(401, "Bearer token required (the preset gateway admin or bootstrap token)");
    const body = await maybeJson(req);
    const candidate = stripTrailingSlash(String(body?.apiKey ?? "").trim());
    if (!candidate) throw httpError(400, "apiKey is required");

    // Verify against AnythingLLM before storing anything.
    const probe = await fetchImpl(`${baseUrl}/api/v1/workspaces`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${candidate}` },
    });
    if (!probe.ok) {
      throw httpError(400, `AnythingLLM rejected this API key (HTTP ${probe.status})`);
    }

    await gatewayConfig.save({ apiKey: candidate });
    configuredApiKey = candidate;
    const workspace = await ensureSharedWorkspace({
      baseUrl, apiKey: candidate, slug: sharedWorkspaceSlug, fetchImpl,
    });
    return sendJson(res, 200, {
      configured: true,
      sharedWorkspace: workspace,
    });
  }

  async function handleGatewayApi({ req, res, url, identity, body }) {
    const requireIdentity = () => {
      if (!identity) throw httpError(401, "Bearer token required");
      return identity;
    };
    const requireAdmin = () => {
      const who = requireIdentity();
      if (who.kind !== "admin") throw httpError(403, "Gateway admin token required");
      return who;
    };

    if (url.pathname === "/api/gateway/users") {
      if (req.method === "GET") {
        requireAdmin();
        return sendJson(res, 200, { users: await userStore.list() });
      }
      if (req.method === "POST") {
        requireAdmin();
        const created = await userStore.create(body);
        return sendJson(res, 201, created);
      }
    }
    const userMatch = url.pathname.match(/^\/api\/gateway\/users\/([a-z0-9-]+)$/);
    if (userMatch && req.method === "DELETE") {
      requireAdmin();
      const removed = await userStore.remove(userMatch[1]);
      return removed ? sendJson(res, 200, { removed: true }) : sendJson(res, 404, { error: "User was not found" });
    }

    if (url.pathname === "/api/gateway/search" && req.method === "POST") {
      const who = requireIdentity();
      const entitlements = await entitlementsFor(who);
      return sendJson(res, 200, await fanoutSearch({
        query: String(body?.query ?? ""),
        topN: clampTopN(body?.topN),
        scoreThreshold: typeof body?.scoreThreshold === "number" ? body.scoreThreshold : undefined,
        workspaces: entitlements.read,
        baseUrl,
        apiKey: apiKeyActive(),
        fetchImpl,
      }));
    }

    if (url.pathname === "/api/gateway/sources") {
      if (req.method === "GET") {
        requireIdentity();
        return sendJson(res, 200, { sources: await sourceManager.list() });
      }
      if (req.method === "POST") {
        requireAdmin();
        return sendJson(res, 201, await sourceManager.create(body));
      }
    }
    const sourceMatch = url.pathname.match(/^\/api\/gateway\/sources\/([a-z0-9-]+)$/);
    if (sourceMatch && req.method === "DELETE") {
      requireAdmin();
      const removed = await sourceManager.remove(sourceMatch[1]);
      return removed ? sendJson(res, 200, { removed: true }) : sendJson(res, 404, { error: "Source was not found" });
    }
    const refreshMatch = url.pathname.match(/^\/api\/gateway\/sources\/([a-z0-9-]+)\/refresh$/);
    if (refreshMatch && req.method === "POST") {
      requireIdentity();
      const source = await sourceManager.get(refreshMatch[1]);
      if (!source) return sendJson(res, 404, { error: "Source was not found" });
      return sendJson(res, 202, sourceManager.requestRefresh(source.id));
    }
    const jobMatch = url.pathname.match(/^\/api\/gateway\/jobs\/([a-z0-9-]+)$/);
    if (jobMatch && req.method === "GET") {
      requireIdentity();
      const job = sourceManager.job(jobMatch[1]);
      return job ? sendJson(res, 200, job) : sendJson(res, 404, { error: "Job was not found" });
    }

    return sendJson(res, 404, { error: "Not found" });
  }

  async function handleProxy({ req, res, url, identity }) {
    const entitlements = identity ? await entitlementsFor(identity) : null;
    let bodyJson = null;
    if (req.method === "DELETE" && url.pathname === "/api/v1/document/remove-folder") {
      bodyJson = await maybeJson(req);
    }
    const decision = await decide({
      method: req.method,
      pathname: url.pathname,
      identity,
      body: bodyJson,
      entitlements,
    });

    if (decision.action === "deny") {
      return sendJson(res, decision.status, { error: decision.reason });
    }
    if (decision.action === "workspaces-list") {
      const workspaces = await anythingllmRequest("/api/v1/workspaces", { method: "GET" });
      const visible = (workspaces?.workspaces ?? []).filter((workspace) =>
        entitlements.read.includes(workspace.slug),
      );
      return sendJson(res, 200, { workspaces: visible });
    }

    const raw = bodyJson === null ? await readRawBody(req) : Buffer.from(JSON.stringify(bodyJson));
    const headers = {
      Accept: req.headers.accept ?? "application/json",
      Authorization: `Bearer ${apiKeyActive()}`,
    };
    if (raw.length) headers["content-type"] = contentType(req);
    const upstream = await fetchImpl(joinUrl(baseUrl, url.pathname + url.search), {
      method: req.method,
      headers,
      body: raw.length ? raw : undefined,
    });
    const buffer = Buffer.from(await upstream.arrayBuffer());

    if (decision.action === "create-workspace" && upstream.ok) {
      const data = safeJson(buffer.toString("utf8"));
      const slug = data?.workspace?.slug ?? data?.slug;
      if (slug) await userStore.recordOwnership(slug, identity.name);
    }

    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      ...(upstream.headers.get("content-length") ? { "content-length": String(buffer.length) } : {}),
    });
    res.end(buffer);
  }

  async function anythingllmRequest(apiPath, init) {
    const response = await fetchImpl(joinUrl(baseUrl, apiPath), {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        Authorization: `Bearer ${apiKeyActive()}`,
      },
    });
    const text = await response.text();
    if (!response.ok) throw httpError(502, `AnythingLLM API ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    return text ? safeJson(text) : null;
  }

  function buildMcpServer(identity) {
    const server = new McpServer({ name: "any-obs-gateway", version: pkg.version });

    server.tool(
      "any_obs_rag_search",
      "Search every RAG workspace this caller may read (the shared workspace plus owned personal workspaces) in one query. Each returned chunk carries the workspace it came from; read the source through that workspace's owner.",
      {
        query: z.string().min(1),
        topN: z.number().int().positive().max(20).default(4),
        scoreThreshold: z.number().min(0).max(1).optional(),
      },
      async ({ query, topN, scoreThreshold }) => {
        const entitlements = await entitlementsFor(identity);
        return asJson(await fanoutSearch({
          query, topN, scoreThreshold,
          workspaces: entitlements.read,
          baseUrl, apiKey: apiKeyActive(), fetchImpl,
        }));
      },
    );

    server.tool(
      "any_obs_rag_answer",
      "Ask AnythingLLM to answer from one workspace this caller may read (defaults to the shared workspace). Cross-workspace synthesis is not offered; use any_obs_rag_search to discover where knowledge lives first.",
      {
        question: z.string().min(1),
        workspace: z.string().min(1).optional(),
        mode: z.enum(["query", "chat"]).default("query"),
      },
      async ({ question, workspace, mode }) => {
        const entitlements = await entitlementsFor(identity);
        const slug = workspace ?? sharedWorkspaceSlug;
        if (!entitlements.read.includes(slug)) throw new Error(`Workspace is not readable by this caller: ${slug}`);
        const data = await anythingllmRequest(`/api/v1/workspace/${encodeURIComponent(slug)}/chat`, {
          method: "POST",
          body: JSON.stringify({ message: question, mode }),
        });
        return asJson(data);
      },
    );

    server.tool(
      "any_obs_shared_refresh",
      "Queue a refresh+reindex job for the shared knowledge base (git pull or directory re-read, then reindex into the shared workspace). Returns the job record; poll any_obs_job_get. Never synchronous.",
      { sourceId: z.string().min(1).optional() },
      async ({ sourceId }) => {
        const sources = (await sourceManager.list()).filter((source) =>
          source.enabled && (!sourceId || source.id === sourceId),
        );
        if (!sources.length) throw new Error(sourceId ? `Source was not found: ${sourceId}` : "No enabled shared sources");
        return asJson({ jobs: sources.map((source) => sourceManager.requestRefresh(source.id)) });
      },
    );

    server.tool(
      "any_obs_job_get",
      "Get one shared-source pipeline job's status (queued/running/succeeded/failed, embed counts, error).",
      { jobId: z.string().min(1) },
      async ({ jobId }) => {
        const job = sourceManager.job(jobId);
        if (!job) throw new Error(`Job was not found: ${jobId}`);
        return asJson(job);
      },
    );

    return server;
  }

  async function entitlementsFor(identity) {
    if (identity?.kind === "admin") {
      return { read: ["*"], write: ["*"] };
    }
    if (identity?.kind === "user") {
      return userStore.entitlements(identity.name);
    }
    return { read: [], write: [] };
  }
}

// The shared workspace is gateway state, not user state: make sure it exists
// once at boot. Never deletes anything.
export async function ensureSharedWorkspace({ baseUrl, apiKey, slug, name = "any-obs shared", fetchImpl = fetch }) {
  const root = stripTrailingSlash(baseUrl);
  const listResponse = await fetchImpl(`${root}/api/v1/workspaces`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
  });
  const listText = await listResponse.text();
  if (!listResponse.ok) throw new Error(`AnythingLLM API ${listResponse.status}`);
  const listed = safeJson(listText)?.workspaces ?? [];
  const existing = listed.find((workspace) => workspace.slug === slug);
  if (existing) return { slug, name: existing.name ?? slug, created: false };

  const createResponse = await fetchImpl(`${root}/api/v1/workspace/new`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ name }),
  });
  const createText = await createResponse.text();
  if (!createResponse.ok) throw new Error(`AnythingLLM API ${createResponse.status}`);
  const created = safeJson(createText)?.workspace;
  if (!created?.slug) throw new Error("AnythingLLM returned an invalid workspace");
  return { slug: created.slug, name: created.name ?? created.slug, created: true };
}

function httpError(status, message) {
  const error = new Error(message);
  error.statusCode = status;
  return error;
}

function clampTopN(value) {
  const parsed = Number(value ?? 4);
  if (!Number.isInteger(parsed) || parsed < 1) return 4;
  return Math.min(parsed, 20);
}

function contentType(req) {
  return req.headers["content-type"] ?? "application/octet-stream";
}

async function maybeJson(req) {
  const raw = await readRawBody(req);
  if (!raw.length) return {};
  const parsed = safeJson(raw.toString("utf8"));
  return parsed ?? {};
}

function readRawBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(httpError(413, "Request body is too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function asJson(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

async function readPackageInfo() {
  const { readFile } = await import("node:fs/promises");
  try {
    return JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  } catch {
    return { version: "0.0.0" };
  }
}

if (import.meta.url === entryUrl()) {
  const env = process.env;
  if (!env.ANYTHINGLLM_BASE_URL) {
    console.error("ANYTHINGLLM_BASE_URL is required (inside compose this is http://anythingllm:3001)");
    process.exit(1);
  }
  if (!env.ANYTHINGLLM_API_KEY && !env.GATEWAY_ADMIN_TOKEN && !env.GATEWAY_BOOTSTRAP_TOKEN) {
    console.error("[any-obs-gateway] unconfigured — the setup dashboard is in its first-run claim window: the first visitor mints the admin credential, so complete setup now (or preset GATEWAY_ADMIN_TOKEN before deploy to require it)");
  }
  const dataDir = env.GATEWAY_DATA_DIR
    ? path.resolve(env.GATEWAY_DATA_DIR)
    : path.join(env.HOME ?? ".", ".anything-obsidian-gateway");
  const sharedWorkspaceSlug = env.SHARED_WORKSPACE_SLUG ?? "shared";
  const gatewayConfig = createGatewayConfig({ dataDir });
  const userStore = createUserStore({ dataDir, sharedWorkspaceSlug });
  const sourceManager = createSourceManager({
    dataDir,
    baseUrl: env.ANYTHINGLLM_BASE_URL,
    apiKey: env.ANYTHINGLLM_API_KEY ?? "",
    sharedWorkspaceSlug,
  });

  const bootstrap = async () => {
    // Env-provided secrets win (non-interactive deploys); otherwise the
    // dashboard wizard collects them into the data volume.
    if (!env.ANYTHINGLLM_API_KEY || !env.GATEWAY_ADMIN_TOKEN) {
      const state = await gatewayConfig.load();
      if (state.adminToken && state.apiKey) {
        console.error("[any-obs-gateway] credentials loaded from the data volume");
        if (!env.ANYTHINGLLM_API_KEY) {
          const probe = await ensureSharedWorkspace({
            baseUrl: env.ANYTHINGLLM_BASE_URL,
            apiKey: state.apiKey,
            slug: sharedWorkspaceSlug,
          }).catch((error) => ({ error }));
          if (probe?.error) console.error(`[any-obs-gateway] shared workspace not verified yet: ${probe.error?.message ?? probe.error}`);
          else console.error(`[any-obs-gateway] shared workspace '${probe.slug}' ready`);
        }
        return;
      }
      console.error("[any-obs-gateway] not configured yet — open the dashboard and run the setup wizard");
      return;
    }
    const workspace = await ensureSharedWorkspace({
      baseUrl: env.ANYTHINGLLM_BASE_URL,
      apiKey: env.ANYTHINGLLM_API_KEY,
      slug: sharedWorkspaceSlug,
    }).catch((error) => ({ error }));
    if (workspace?.error) console.error(`[any-obs-gateway] shared workspace not verified yet: ${workspace.error?.message ?? workspace.error}`);
    else console.error(`[any-obs-gateway] shared workspace '${workspace.slug}' ready`);
  };
  bootstrap();

  const port = Number(env.GATEWAY_PORT ?? DEFAULT_GATEWAY_PORT);
  createGatewayServer({
    userStore,
    sourceManager,
    gatewayConfig,
    anythingllmBaseUrl: env.ANYTHINGLLM_BASE_URL,
    anythingllmApiKey: env.ANYTHINGLLM_API_KEY ?? "",
    sharedWorkspaceSlug,
    adminToken: env.GATEWAY_ADMIN_TOKEN ?? "",
  }).listen(port, env.GATEWAY_BIND ?? "0.0.0.0", () => {
    console.error(`[any-obs-gateway] listening on ${env.GATEWAY_BIND ?? "0.0.0.0"}:${port} (shared workspace: ${sharedWorkspaceSlug})`);
  });

  setInterval(() => {
    sourceManager.runDueSources().catch((error) => {
      console.error(`[any-obs-gateway] scheduled refresh failed: ${error?.message ?? error}`);
    });
  }, 30_000).unref();
}

function entryUrl() {
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return pathToFileURL(path.resolve(process.argv[1])).href;
  }
}
