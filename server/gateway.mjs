#!/usr/bin/env node
// The any-obs gateway: IAM front door for a shared AnythingLLM. It runs two
// planes with the same trust model as the client (loopback dashboard, LAN
// service):
//
//   public plane (21500, published): MCP endpoint, fan-out search, and the
//     user-token-authenticated AnythingLLM proxy. Every call needs a user
//     token; no dashboard, no admin surface lives here.
//   admin plane (21505, host loopback only): the dashboard, its setup
//     wizard, user/source management, and a full passthrough proxy for
//     recovery. Reaching it requires server access (SSH/physical), which
//     IS the admin proof — the same "loopback caller is the user's
//     delegate" rule the client dashboard has always used.
//
// The gateway remains the sole holder of the AnythingLLM developer key.
import { createServer } from "node:http";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
export const DEFAULT_GATEWAY_ADMIN_PORT = 21505;
const pkg = await readPackageInfo();
const dashboardRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "dashboard");

export function createGatewayServer({
  plane = "public",
  env = process.env,
  userStore,
  sourceManager,
  gatewayConfig = createGatewayConfig({ dataDir: defaultDataDir(env) }),
  anythingllmBaseUrl = env.ANYTHINGLLM_BASE_URL ?? "",
  anythingllmApiKey = env.ANYTHINGLLM_API_KEY ?? "",
  fetchImpl = fetch,
}) {
  if (plane !== "public" && plane !== "admin") throw new Error(`Unknown gateway plane: ${plane}`);
  const baseUrl = stripTrailingSlash(anythingllmBaseUrl);
  // The wizard-collected API key lives in the data volume; it is cached at
  // boot and refreshed whenever setup writes it. configReady is awaited at
  // the top of every request so no handler can race the initial load.
  let configuredApiKey = "";
  const configReady = gatewayConfig.load().then((state) => {
    configuredApiKey = state.apiKey;
  }).catch(() => {});

  return createServer(async (req, res) => {
    try {
      await configReady;
      const url = new URL(req.url || "/", "http://gateway");
      const identity = plane === "admin"
        ? { kind: "admin" } // loopback reach is the proof
        : publicIdentity(req.headers.authorization);

      if (req.method === "GET" && url.pathname === "/health") {
        return await sendHealth(res);
      }

      if (url.pathname.startsWith("/api/setup/") && plane !== "admin") {
        return sendJson(res, 404, { error: "Not found" });
      }
      if (plane === "admin" && url.pathname === "/api/setup/state" && req.method === "GET") {
        return sendJson(res, 200, await setupState());
      }
      if (plane === "admin" && url.pathname === "/api/setup/api-key") {
        return await handleSetupApiKey(req, res);
      }

      if (url.pathname === "/mcp") {
        if (plane !== "public") return sendJson(res, 404, { error: "Not found" });
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

      if (plane === "admin" && req.method === "GET") {
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

  function publicIdentity(header) {
    const match = /^Bearer\s+(.+)$/i.exec(String(header ?? ""));
    return match ? userStore.verify(match[1].trim()) : null;
  }

  function apiKeyActive() {
    return anythingllmApiKey || configuredApiKey;
  }

  async function sendHealth(res) {
    return sendJson(res, 200, {
      ok: true,
      name: "any-obs-gateway",
      plane,
      version: pkg.version,
      configured: Boolean(apiKeyActive()),
      users: (await userStore.list()).length,
    });
  }

  async function needsSetup() {
    return !apiKeyActive();
  }

  async function setupState() {
    return {
      needsSetup: await needsSetup(),
      anythingllmBaseUrl: baseUrl,
      anythingllmUiUrl: "http://localhost:21501",
      hasApiKey: Boolean(apiKeyActive()),
    };
  }

  // The setup endpoint only exists while the gateway has no key; once the
  // wizard completes it disappears (403) so it can never re-open. Later key
  // changes go through the admin plane's settings endpoints.
  async function handleSetupApiKey(req, res) {
    if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
    if (!(await needsSetup())) throw httpError(403, "Gateway is already configured; setup is closed");
    const body = await maybeJson(req);
    const candidate = stripTrailingSlash(String(body?.apiKey ?? "").trim());
    if (!candidate) throw httpError(400, "apiKey is required");
    await verifyAndStoreApiKey(candidate);
    return sendJson(res, 200, { configured: true });
  }

  async function verifyAndStoreApiKey(candidate) {
    // Verify against AnythingLLM before storing anything.
    const probe = await fetchImpl(`${baseUrl}/api/v1/workspaces`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${candidate}` },
    });
    if (!probe.ok) throw httpError(400, `AnythingLLM rejected this API key (HTTP ${probe.status})`);
    await gatewayConfig.save({ apiKey: candidate });
    configuredApiKey = candidate;
  }

  async function handleGatewayApi({ req, res, url, identity, body }) {
    const adminOnly = () => {
      // The admin plane is loopback (server access is the credential); over
      // the public plane only a user token carrying the admin role gets in.
      if (plane === "admin") return { kind: "admin" };
      if (identity?.kind === "user" && identity.role === "admin") return identity;
      throw httpError(404, "Not found");
    };

    if (url.pathname === "/api/gateway/settings") {
      adminOnly();
      if (req.method === "GET") {
        const state = await gatewayConfig.load();
        const key = apiKeyActive();
        let connected = false;
        if (key) {
          const probe = await fetchImpl(`${baseUrl}/api/v1/workspaces`, {
            headers: { Accept: "application/json", Authorization: `Bearer ${key}` },
          }).catch(() => null);
          connected = Boolean(probe?.ok);
        }
        return sendJson(res, 200, {
          anythingllmBaseUrl: baseUrl,
          // Never the full key — enough to recognise which one is configured.
          keyPreview: key ? `${key.slice(0, 4)}…${key.slice(-4)}` : "",
          envKey: Boolean(anythingllmApiKey),
          connected,
        });
      }
    }
    if (url.pathname === "/api/gateway/settings/api-key" && req.method === "POST") {
      adminOnly();
      const candidate = stripTrailingSlash(String(body?.apiKey ?? "").trim());
      if (!candidate) throw httpError(400, "apiKey is required");
      await verifyAndStoreApiKey(candidate);
      return sendJson(res, 200, { updated: true });
    }

    if (url.pathname === "/api/gateway/users") {
      if (req.method === "GET") {
        adminOnly();
        return sendJson(res, 200, { users: await userStore.list() });
      }
      if (req.method === "POST") {
        adminOnly();
        const created = await userStore.create(body);
        return sendJson(res, 201, created);
      }
    }
    const userMatch = url.pathname.match(/^\/api\/gateway\/users\/([a-z0-9-]+)$/);
    if (userMatch && req.method === "DELETE") {
      adminOnly();
      const removed = await userStore.remove(userMatch[1]);
      return removed ? sendJson(res, 200, { removed: true }) : sendJson(res, 404, { error: "User was not found" });
    }
    if (userMatch && req.method === "PATCH") {
      adminOnly();
      const updated = await userStore.updateRole(userMatch[1], body?.role);
      return updated ? sendJson(res, 200, updated) : sendJson(res, 404, { error: "User was not found" });
    }
    const resetMatch = url.pathname.match(/^\/api\/gateway\/users\/([a-z0-9-]+)\/reset-token$/);
    if (resetMatch && req.method === "POST") {
      adminOnly();
      const reset = await userStore.resetToken(resetMatch[1]);
      return reset ? sendJson(res, 200, reset) : sendJson(res, 404, { error: "User was not found" });
    }

    if (url.pathname === "/api/gateway/workspaces") {
      adminOnly();
      if (req.method === "GET") {
        // Two-way view: the registry, plus anything upstream the gateway
        // does not know about (workspaces made outside it, e.g. directly in
        // AnythingLLM during setup) so an admin can adopt or delete them.
        const registry = await userStore.workspaces();
        const known = new Set(registry.map((workspace) => workspace.slug));
        let untracked = [];
        try {
          const upstream = await anythingllmRequest("/api/v1/workspaces", { method: "GET" });
          untracked = (upstream?.workspaces ?? [])
            .filter((workspace) => workspace.slug && !known.has(workspace.slug))
            .map((workspace) => ({ slug: workspace.slug, name: workspace.name ?? workspace.slug }));
        } catch {
          untracked = [];
        }
        return sendJson(res, 200, { workspaces: registry, untracked });
      }
      if (req.method === "POST") {
        // Admin creates a workspace in AnythingLLM and registers it here:
        // kind "shared" starts ungranted and is fed by sources targeting it;
        // kind "personal" hands ownership to a user up front (also how
        // "attach an existing workspace" is done).
        const kind = body?.kind === "shared" ? "shared" : body?.kind === "personal" ? "personal" : null;
        if (!kind) throw httpError(400, 'kind must be "shared" or "personal"');
        const owner = String(body?.owner ?? "").trim();
        if (kind === "personal") {
          if (!owner) throw httpError(400, "A personal workspace requires an owner");
          if (!(await userStore.get(owner))) throw httpError(400, `Unknown owner: ${owner}`);
        }
        const created = await anythingllmRequest("/api/v1/workspace/new", {
          method: "POST",
          body: JSON.stringify({ name: String(body?.name ?? "").trim() || "untitled" }),
        });
        const slug = created?.workspace?.slug ?? created?.slug;
        if (!slug) throw httpError(502, "AnythingLLM returned an invalid workspace");
        const record = await userStore.recordWorkspace(slug, { kind, owner: kind === "personal" ? owner : null });
        return sendJson(res, 201, {
          workspace: { slug, kind, ...(kind === "personal" ? { owner: record.owner } : { grants: record.grants }) },
        });
      }
    }

    if (url.pathname === "/api/gateway/workspaces/adopt" && req.method === "POST") {
      adminOnly();
      // Register a workspace that already exists upstream (reverse scan):
      // nothing is created, the slug must exist in AnythingLLM.
      const slug = String(body?.slug ?? "").trim();
      const kind = body?.kind === "shared" ? "shared" : body?.kind === "personal" ? "personal" : null;
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw httpError(400, "slug is required");
      if (!kind) throw httpError(400, 'kind must be "shared" or "personal"');
      const owner = String(body?.owner ?? "").trim();
      if (kind === "personal") {
        if (!owner) throw httpError(400, "A personal workspace requires an owner");
        if (!(await userStore.get(owner))) throw httpError(400, `Unknown owner: ${owner}`);
      }
      if (await userStore.workspaceRecord(slug)) throw httpError(400, `Workspace is already tracked: ${slug}`);
      const upstream = await anythingllmRequest("/api/v1/workspaces", { method: "GET" });
      if (!(upstream?.workspaces ?? []).some((workspace) => workspace.slug === slug)) {
        throw httpError(400, `Workspace does not exist in AnythingLLM: ${slug}`);
      }
      const record = await userStore.recordWorkspace(slug, { kind, owner: kind === "personal" ? owner : null });
      return sendJson(res, 201, {
        workspace: { slug, kind, ...(kind === "personal" ? { owner: record.owner } : { grants: record.grants }) },
      });
    }

    const grantsMatch = url.pathname.match(/^\/api\/gateway\/workspaces\/([a-z0-9-]+)\/grants\/?([a-z0-9-]*)$/);
    if (grantsMatch && (req.method === "POST" || req.method === "DELETE")) {
      adminOnly();
      const [ , slug, grantedUser ] = grantsMatch;
      if (req.method === "POST") {
        const name = String(body?.user ?? grantedUser ?? "").trim();
        if (!name) throw httpError(400, "user is required");
        const grants = await userStore.grantWorkspaceAccess(slug, name);
        return sendJson(res, 200, { slug, grants });
      }
      if (!grantedUser) throw httpError(400, "user is required");
      const grants = await userStore.revokeWorkspaceAccess(slug, grantedUser);
      return sendJson(res, 200, { slug, grants });
    }

    const workspaceMatch = url.pathname.match(/^\/api\/gateway\/workspaces\/([a-z0-9-]+)$/);
    if (workspaceMatch && req.method === "DELETE") {
      adminOnly();
      const slug = workspaceMatch[1];
      const response = await fetchImpl(joinUrl(baseUrl, `/api/v1/workspace/${encodeURIComponent(slug)}`), {
        method: "DELETE",
        headers: { Accept: "application/json", Authorization: `Bearer ${apiKeyActive()}` },
      });
      // 404 means the workspace is already gone upstream; the ownership
      // record dies either way so no entitlement ever points at a ghost.
      if (!response.ok && response.status !== 404) {
        const text = await response.text().catch(() => "");
        throw httpError(502, `AnythingLLM API ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
      }
      await userStore.removeWorkspace(slug);
      return sendJson(res, 200, { removed: slug });
    }

    if (url.pathname === "/api/gateway/search" && req.method === "POST") {
      if (!identity) throw httpError(401, "Bearer token required");
      const entitlements = await entitlementsFor(identity);
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
        if (!identity) throw httpError(401, "Bearer token required");
        return sendJson(res, 200, { sources: await sourceManager.list() });
      }
      if (req.method === "POST") {
        adminOnly();
        return sendJson(res, 201, await sourceManager.create(body));
      }
    }
    const sourceMatch = url.pathname.match(/^\/api\/gateway\/sources\/([a-z0-9-]+)$/);
    if (sourceMatch && req.method === "DELETE") {
      adminOnly();
      const removed = await sourceManager.remove(sourceMatch[1]);
      return removed ? sendJson(res, 200, { removed: true }) : sendJson(res, 404, { error: "Source was not found" });
    }
    const refreshMatch = url.pathname.match(/^\/api\/gateway\/sources\/([a-z0-9-]+)\/refresh$/);
    if (refreshMatch && req.method === "POST") {
      if (!identity) throw httpError(401, "Bearer token required");
      const source = await sourceManager.get(refreshMatch[1]);
      if (!source) return sendJson(res, 404, { error: "Source was not found" });
      return sendJson(res, 202, sourceManager.requestRefresh(source.id));
    }
    const jobMatch = url.pathname.match(/^\/api\/gateway\/jobs\/([a-z0-9-]+)$/);
    if (jobMatch && req.method === "GET") {
      if (!identity) throw httpError(401, "Bearer token required");
      const job = sourceManager.job(jobMatch[1]);
      return job ? sendJson(res, 200, job) : sendJson(res, 404, { error: "Job was not found" });
    }

    return sendJson(res, 404, { error: "Not found" });
  }

  async function handleProxy({ req, res, url, identity }) {
    if (!identity) return sendJson(res, 401, { error: "Bearer token required" });
    const entitlements = await entitlementsFor(identity);
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
      if (slug && identity.kind === "user") await userStore.recordOwnership(slug, identity.name);
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
      "Ask AnythingLLM to answer from one workspace this caller may read. Cross-workspace synthesis is not offered; use any_obs_rag_search to discover where knowledge lives first.",
      {
        question: z.string().min(1),
        workspace: z.string().min(1),
        mode: z.enum(["query", "chat"]).default("query"),
      },
      async ({ question, workspace, mode }) => {
        const entitlements = await entitlementsFor(identity);
        if (!entitlements.read.includes(workspace)) throw new Error(`Workspace is not readable by this caller: ${workspace}`);
        const data = await anythingllmRequest(`/api/v1/workspace/${encodeURIComponent(workspace)}/chat`, {
          method: "POST",
          body: JSON.stringify({ message: question, mode }),
        });
        return asJson(data);
      },
    );

    server.tool(
      "any_obs_shared_refresh",
      "Queue a refresh+reindex job for the shared knowledge base (git pull or directory re-read, then reindex into the workspace its source targets). Returns the job records; poll any_obs_job_get. Never synchronous.",
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
}

function defaultDataDir(env) {
  return env.GATEWAY_DATA_DIR
    ? path.resolve(env.GATEWAY_DATA_DIR)
    : path.join(env.HOME ?? ".", ".anything-obsidian-gateway");
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
  const dataDir = defaultDataDir(env);
  const gatewayConfig = createGatewayConfig({ dataDir });
  const userStore = createUserStore({ dataDir });
  const sourceManager = createSourceManager({
    dataDir,
    baseUrl: env.ANYTHINGLLM_BASE_URL,
    apiKey: env.ANYTHINGLLM_API_KEY ?? "",
  });
  const shared = {
    userStore,
    sourceManager,
    gatewayConfig,
    anythingllmBaseUrl: env.ANYTHINGLLM_BASE_URL,
    anythingllmApiKey: env.ANYTHINGLLM_API_KEY ?? "",
  };

  const bootstrap = async () => {
    const state = await gatewayConfig.load();
    const key = env.ANYTHINGLLM_API_KEY || state.apiKey;
    if (!key) {
      console.error(`[any-obs-gateway] no AnythingLLM key yet — open the admin dashboard (loopback :${env.GATEWAY_ADMIN_PORT ?? DEFAULT_GATEWAY_ADMIN_PORT}) and run the setup wizard`);
      return;
    }
    const workspaces = await userStore.workspaces();
    if (!workspaces.some((workspace) => workspace.kind === "shared")) {
      console.error(`[any-obs-gateway] no shared workspaces yet — create one in the admin dashboard (Workspaces tab), then point shared sources at it`);
    }
  };
  bootstrap();

  const port = Number(env.GATEWAY_PORT ?? DEFAULT_GATEWAY_PORT);
  createGatewayServer({ ...shared, plane: "public" }).listen(port, env.GATEWAY_BIND ?? "0.0.0.0", () => {
    console.error(`[any-obs-gateway] public plane on ${env.GATEWAY_BIND ?? "0.0.0.0"}:${port} (MCP + user API; user token required)`);
  });

  const adminPort = Number(env.GATEWAY_ADMIN_PORT ?? DEFAULT_GATEWAY_ADMIN_PORT);
  createGatewayServer({ ...shared, plane: "admin" }).listen(adminPort, env.GATEWAY_ADMIN_BIND ?? "127.0.0.1", () => {
    console.error(`[any-obs-gateway] admin plane on ${env.GATEWAY_ADMIN_BIND ?? "127.0.0.1"}:${adminPort} (dashboard + setup; loopback reach is the credential)`);
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
