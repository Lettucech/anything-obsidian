#!/usr/bin/env node
import { realpathSync } from "node:fs";
import process from "node:process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { z } from "zod";

import { mcpHttpOptions } from "./http-config.mjs";
import { ADMIN_IDENTITY, ANONYMOUS_IDENTITY, loadVaults, loadWorkspace, resolveVault, visibleVaults } from "./vault-registry.mjs";
import { attributeRagResults } from "./rag-attribution.mjs";
import { loadAgentIdentities, resolveIdentity } from "./agent-identity.mjs";
import { createVaultFileService } from "./vault-files.mjs";
import { dashboardApi, registerManagementTools } from "./manage.mjs";
import { createSyncStatusStore, syncStatusPath } from "../lib/sync-status.mjs";
import { defaultConfigRoot, configPaths } from "../lib/app-config.mjs";

const { readFile } = await import("node:fs/promises");
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

const chatPathTemplate = process.env.ANYTHINGLLM_CHAT_PATH_TEMPLATE ?? "/api/v1/workspace/{slug}/chat";
const vectorSearchPathTemplate = process.env.ANYTHINGLLM_VECTOR_SEARCH_PATH_TEMPLATE ?? "/api/v1/workspace/{slug}/vector-search";

export function createServer(profile = "local", identity = ANONYMOUS_IDENTITY) {
  const baseUrl = stripTrailingSlash(process.env.ANYTHINGLLM_BASE_URL ?? "");
  const apiKey = process.env.ANYTHINGLLM_API_KEY;
  const vaultRegistryPath = process.env.VAULT_REGISTRY_PATH ?? defaultPaths().registryPath;
  const vaultsRoot = process.env.VAULTS_ROOT ?? "";
  const vaultFiles = createVaultFileService({
    vaultsRoot,
    registryPath: vaultRegistryPath,
    hostVaultsRoot: process.env.HOST_VAULTS_ROOT ?? vaultsRoot,
    identity,
  });

  const server = new McpServer({ name: "anything-obsidian", version: pkg.version });

  const syncStatuses = createSyncStatusStore({ filePath: syncStatusPath(process.env.VAULT_STATE_ROOT || defaultPaths().stateRoot) });

  server.tool(
    "any_obs_vault_list",
    "List managed vaults the caller can access, each with its id, name, and last sync outcome (status and time). No repository, Git, or filesystem details are returned.",
    {},
    async () => {
      const statuses = await syncStatuses.all();
      return asJsonContent({
        vaults: visibleVaults(await loadVaults(vaultRegistryPath), identity).map(({ id, name }) => ({
          id,
          name,
          lastSync: statuses[id]
            ? { status: statuses[id].status, finishedAt: statuses[id].finishedAt }
            : null,
        })),
      });
    },
  );

  if (profile === "local") {
    registerLocalVaultTools(server, vaultFiles);
    registerManagementTools(server, dashboardApi(), { z });
  }
  registerRagTools(server, { baseUrl, apiKey, vaultRegistryPath }, identity);
  return server;
}

function defaultPaths() {
  return configPaths(defaultConfigRoot());
}

function registerLocalVaultTools(server, vaultFiles) {
  server.tool(
    "any_obs_file_list",
    "List Markdown and Canvas files from one managed Obsidian vault. Paths are vault-relative and this tool is read-only.",
    {
      vaultId: z.string().min(1).optional(),
      path: z.string().optional(),
      maxEntries: z.number().int().positive().max(1_000).optional(),
    },
    async (input) => asJsonContent(await vaultFiles.listFiles(input)),
  );

  server.tool(
    "any_obs_file_read",
    "Read a bounded line range from a source-of-truth Obsidian file. This tool is read-only.",
    {
      vaultId: z.string().min(1).optional(),
      path: z.string().min(1),
      startLine: z.number().int().positive().optional(),
      maxLines: z.number().int().positive().max(1_000).optional(),
      maxBytes: z.number().int().positive().max(256 * 1024).optional(),
    },
    async (input) => asJsonContent(await vaultFiles.readFile(input)),
  );

  server.tool(
    "any_obs_vault_context",
    "Return local edit context for one managed vault: its host directory, policy files, non-secret sync settings, and source-of-truth boundaries. This tool is read-only and local-only.",
    { vaultId: z.string().min(1).optional() },
    async (input) => asJsonContent(await vaultFiles.context(input)),
  );

  server.tool(
    "any_obs_vault_directory",
    "Return the configured host directory for one managed vault. This tool is local-only so an agent can open the vault directly when it has local filesystem authority.",
    { vaultId: z.string().min(1).optional() },
    async (input) => asJsonContent(await vaultFiles.directory(input)),
  );
}

function registerRagTools(server, { baseUrl, apiKey, vaultRegistryPath }, identity) {
  server.tool(
    "any_obs_rag_answer",
    "Ask AnythingLLM to answer from the unified index of every managed vault at once. The answer can draw on any vault; use anythingllm rag search when you need attributed source chunks.",
    {
      question: z.string().min(1),
      mode: z.enum(["query", "chat"]).default("query"),
    },
    async ({ question, mode }) => {
      const workspace = await requireUnifiedWorkspace(vaultRegistryPath);
      const data = await requestJson(chatPathTemplate.replace("{slug}", encodeURIComponent(workspace.slug)), {
        method: "POST",
        body: JSON.stringify({ message: question, mode }),
      }, { baseUrl, apiKey });
      return asJsonContent(data);
    },
  );

  server.tool(
    "any_obs_rag_search",
    "Search every RAG workspace this instance can see — its own unified index plus any gateway-granted shared workspaces — in one query. Chunks are merged by score and tagged with their workspace, vaultId, and vault-relative path so the source file can be read from the owning vault. vaultId optionally filters results to one vault. Prefer this for agent RAG.",
    {
      query: z.string().min(1),
      vaultId: z.string().min(1).optional(),
      topN: z.number().int().positive().max(20).default(4),
      scoreThreshold: z.number().min(0).max(1).optional(),
    },
    async ({ query, vaultId, topN, scoreThreshold }) => {
      const workspaces = await visibleRagWorkspaces(vaultRegistryPath, { baseUrl, apiKey });
      const vaults = await loadVaults(vaultRegistryPath);
      const accessible = visibleVaults(vaults, identity);
      if (vaultId) resolveVault(vaults, vaultId, identity);
      const accessibleIds = new Set(accessible.map((vault) => vault.id));
      const blockedVaultIds = vaults.filter((vault) => !accessibleIds.has(vault.id)).map((vault) => vault.id);

      const bodies = workspaces.map((slug) =>
        requestJson(vectorSearchPathTemplate.replace("{slug}", encodeURIComponent(slug)), {
          method: "POST",
          body: JSON.stringify({ query, topN, ...(scoreThreshold !== undefined ? { scoreThreshold } : {}) }),
        }, { baseUrl, apiKey })
          .then((data) => ({ slug, data }))
          .catch((error) => ({ slug, error: error instanceof Error ? error.message : String(error) })),
      );
      const responses = await Promise.all(bodies);

      const merged = [];
      const failures = [];
      const attribution = { attributed: 0, dropped: 0 };
      for (const response of responses) {
        if (response.error) {
          failures.push({ workspace: response.slug, error: response.error });
          continue;
        }
        const { data: enriched, summary } = attributeRagResults(response.data, {
          vaultIds: [...accessibleIds],
          filterVaultId: vaultId ?? "",
          blockedVaultIds,
        });
        attribution.attributed += summary.attributed;
        attribution.dropped += summary.dropped;
        for (const chunk of extractRagChunks(enriched)) {
          merged.push({ ...chunk, workspace: response.slug });
        }
      }
      merged.sort((a, b) => (typeof b.score === "number" ? b.score : 0) - (typeof a.score === "number" ? a.score : 0));
      const payload = {
        query,
        results: merged.slice(0, topN),
        vaultAttribution: attribution,
        workspaces: { searched: workspaces, failed: failures },
        ...(failures.length ? { note: "Results are partial: some workspaces failed to answer" } : {}),
      };
      return asJsonContent(payload);
    },
  );
}

// AnythingLLM has never committed to one vector-search response shape: find
// the first array of chunk-looking objects anywhere in the payload.
function extractRagChunks(data) {
  const chunks = [];
  walk(data);
  return chunks;

  function walk(value) {
    if (Array.isArray(value)) {
      if (value.some(looksLikeChunk)) {
        chunks.push(...value.filter(looksLikeChunk));
        return;
      }
      for (const item of value) walk(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const inner of Object.values(value)) {
        if (Array.isArray(inner) || (inner && typeof inner === "object")) walk(inner);
      }
    }
  }

  function looksLikeChunk(item) {
    return Boolean(item) && typeof item === "object" && !Array.isArray(item) &&
      (typeof item.text === "string" || typeof item.score === "number");
  }
}

// One query across everything the configured key can see. Against plain
// AnythingLLM that is exactly the instance's unified workspace (key = the
// instance's developer key); against a gateway it is the filtered list the
// proxy answers with — personal plus granted shared workspaces.
async function visibleRagWorkspaces(vaultRegistryPath, { baseUrl, apiKey }) {
  const workspace = await requireUnifiedWorkspace(vaultRegistryPath);
  try {
    const data = await requestJson("/api/v1/workspaces", { method: "GET" }, { baseUrl, apiKey });
    const slugs = (data?.workspaces ?? []).map((workspace) => workspace.slug).filter(Boolean);
    if (slugs.length && !slugs.includes(workspace.slug)) {
      return [workspace.slug, ...slugs];
    }
    return slugs.length ? slugs : [workspace.slug];
  } catch {
    // Plain AnythingLLM quirks should never break the primary workspace.
    return [workspace.slug];
  }
}

async function requireUnifiedWorkspace(vaultRegistryPath) {
  const workspace = await loadWorkspace(vaultRegistryPath);
  if (!workspace) {
    throw new Error("No unified workspace is configured yet. Add a vault from the dashboard (or run a worker embed) to initialise it.");
  }
  return workspace;
}

async function requestJson(pathOrUrl, init, { baseUrl, apiKey }) {
  if (!apiKey) {
    throw new Error("Missing ANYTHINGLLM_API_KEY. Finish AnythingLLM setup and re-run: anything-obsidian init");
  }
  if (!baseUrl) {
    throw new Error("Missing ANYTHINGLLM_BASE_URL. Re-run: anything-obsidian init");
  }
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${baseUrl}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  const data = text ? parseJson(text) : null;
  if (!response.ok) throw new Error(`AnythingLLM API ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return data;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function asJsonContent(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function startHttpServer(profile) {
  const adminToken = process.env.MCP_AUTH_TOKEN ?? "";
  if (profile === "lan" && !adminToken) throw new Error("MCP_AUTH_TOKEN is required for the LAN MCP profile");
  const bindHost = profile === "lan" ? "0.0.0.0" : "127.0.0.1";
  const app = createMcpExpressApp(mcpHttpOptions(process.env.MCP_ALLOWED_HOSTS, { host: bindHost }));

  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true, name: "anything-obsidian-mcp", profile, apiKeyConfigured: Boolean(process.env.ANYTHINGLLM_API_KEY) });
  });

  app.post("/mcp", async (req, res) => {
    const identity = resolveIdentity(req.get("authorization"), {
      adminToken,
      agents: await loadAgentIdentities(process.env.MCP_AGENT_TOKENS_PATH ?? path.join(defaultPaths().agentTokensRoot, "agents.json")),
    });
    if (profile === "lan" && identity.kind === "anonymous") {
      return res.status(401).json({ error: "Bearer token required" });
    }
    const server = createServer(profile, identity);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        transport.close();
        server.close();
      });
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  });

  app.get("/mcp", (_req, res) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  });

  const port = mcpPort(profile);
  app.listen(port, bindHost, (error) => {
    if (error) {
      console.error("Failed to start MCP HTTP server:", error);
      process.exit(1);
    }
    console.error(`anything-obsidian ${profile} MCP HTTP server listening on ${bindHost}:${port}`);
  });
}

function mcpPort(profile) {
  if (profile === "lan") return Number(process.env.MCP_LAN_PORT ?? 21504);
  return Number(process.env.MCP_PORT ?? 21503);
}

if (process.argv[1] && import.meta.url === entryUrl()) {
  const profile = process.argv.includes("--lan") || process.env.MCP_PROFILE === "lan" ? "lan" : "local";
  if (process.argv.includes("--http") || process.env.MCP_TRANSPORT === "http") {
    startHttpServer(profile);
  } else {
    const server = createServer(profile, ADMIN_IDENTITY);
    await server.connect(new StdioServerTransport());
  }
}

function entryUrl() {
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return pathToFileURL(path.resolve(process.argv[1])).href;
  }
}
