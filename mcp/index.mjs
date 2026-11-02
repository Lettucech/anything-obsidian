#!/usr/bin/env node
import { isContainer } from "../lib/deployment.mjs";
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
import { extractChunks, mergeChunksByScore, partialResultsNote, retrievalHint, vectorSearchJson } from "../lib/fanout.mjs";
import { ADMIN_IDENTITY, ANONYMOUS_IDENTITY, loadVaults, resolveVault, visibleVaults } from "./vault-registry.mjs";
import { attributeRagResults } from "./rag-attribution.mjs";
import { resolveIdentity } from "./agent-identity.mjs";
import { createVaultFileService } from "./vault-files.mjs";
import { dashboardApi, registerManagementTools } from "./manage.mjs";
import { createSyncStatusStore, syncStatusPath } from "../lib/sync-status.mjs";
import { defaultConfigRoot, configPaths } from "../lib/app-config.mjs";

const { readFile } = await import("node:fs/promises");
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

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
  // Search-first (2026-11): the chat-based any_obs_rag_answer was retired
  // with the unified workspace — a chat call answers from exactly one
  // workspace, which the per-vault model has N of. Agents retrieve
  // attributed chunks here and synthesize themselves, where the
  // conversation context lives. AnythingLLM is a pure RAG index engine for
  // any-obs: no any-obs code path touches its LLM anymore.
  server.tool(
    "any_obs_rag_search",
    "Search every RAG workspace this instance can see — one workspace per managed vault, plus any server-granted shared workspaces — in one query. Chunks are merged by score, tagged with their workspace, vaultId, and vault-relative path, and every vault's best chunk is guaranteed a slot, so divergent copies of the same information surface together. Read the chunks and synthesize; when versions from different vaults disagree, point both out and ask which is current. vaultId optionally filters to one vault.",
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

      // Fan-out mechanics live in lib/fanout.mjs, shared with the server
      // plane; attribution stays here because only this side knows the
      // local vault registry.
      const responses = await Promise.all(workspaces.map((slug) =>
        vectorSearchJson({
          slug,
          query,
          topN,
          scoreThreshold,
          baseUrl,
          apiKey,
          pathTemplate: vectorSearchPathTemplate,
        })
          .then((data) => ({ slug, data }))
          .catch((error) => ({ slug, error: error instanceof Error ? error.message : String(error) })),
      ));

      const answered = [];
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
        answered.push({ slug: response.slug, chunks: extractChunks(enriched) });
      }
      const note = partialResultsNote(failures);
      const results = mergeChunksByScore({ answered, topN });
      const payload = {
        query,
        results,
        ...retrievalHint(results, scoreThreshold),
        vaultAttribution: attribution,
        workspaces: { searched: workspaces, failed: failures },
        ...(note ? { note } : {}),
      };
      return asJsonContent(payload);
    },
  );
}

// One query across everything the configured key can see. Against plain
// AnythingLLM that is every workspace on the instance — one per managed
// vault plus anything else the operator keeps there; against a server it is
// the filtered list the proxy answers with — the caller's per-vault and
// granted shared workspaces. What the configured key can see is the source
// of truth; an empty answer is an error worth explaining.
async function visibleRagWorkspaces(_vaultRegistryPath, { baseUrl, apiKey }) {
  const data = await requestJson("/api/v1/workspaces", { method: "GET" }, { baseUrl, apiKey });
  const slugs = (data?.workspaces ?? []).map((workspace) => workspace.slug).filter(Boolean);
  if (slugs.length) return slugs;
  throw new Error("No RAG workspaces are visible yet. Add a vault to create this instance's own workspace, or ask your server admin to grant a shared workspace to your user.");
}

async function requestJson(pathOrUrl, init, { baseUrl, apiKey }) {
  if (!apiKey) {
    throw new Error("Missing ANYTHINGLLM_API_KEY. Finish AnythingLLM setup and re-run: anything-obsidian setup");
  }
  if (!baseUrl) {
    throw new Error("Missing ANYTHINGLLM_BASE_URL. Re-run: anything-obsidian setup");
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

// One MCP HTTP listener. The standalone CLI entry uses it directly; the
// merged single-process app entry creates the local (21503) listener at
// boot, so it must return the server handle and report bind failures
// instead of exiting the process.
export function createMcpHttpListener({
  profile = "local",
  port,
  bind,
  adminToken,
  allowedHosts,
  env = process.env,
} = {}) {
  const effectiveAdminToken = adminToken ?? env.MCP_AUTH_TOKEN ?? "";
  const container = isContainer(env);
  if (container && !effectiveAdminToken)
    throw new Error("MCP_AUTH_TOKEN is required for network MCP");
  const bindHost = bind ?? (container ? "0.0.0.0" : "127.0.0.1");
  const listenPort = port ?? mcpPort(env);
  const app = createMcpExpressApp(mcpHttpOptions(allowedHosts ?? env.MCP_ALLOWED_HOSTS, { host: bindHost }));

  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true, name: "anything-obsidian-mcp", profile, configRoot: env.ANYTHING_OBSIDIAN_HOME, apiKeyConfigured: Boolean(env.ANYTHINGLLM_API_KEY) });
  });

  app.post("/mcp", async (req, res) => {
    const identity = resolveIdentity(req.get("authorization"), {
      adminToken: effectiveAdminToken,
    });
    if (container && identity.kind === "anonymous") {
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

  return new Promise((resolve, reject) => {
    const server = app.listen(listenPort, bindHost, (error) => {
      if (error) return reject(error);
      console.error(`anything-obsidian ${profile} MCP HTTP server listening on ${bindHost}:${listenPort}`);
      resolve(server);
    });
  });
}

function mcpPort(env = process.env) {
  return Number(env.MCP_PORT ?? 21503);
}

if (process.argv[1] && import.meta.url === entryUrl()) {
  const profile = "local";
  if (process.argv.includes("--http") || process.env.MCP_TRANSPORT === "http") {
    createMcpHttpListener({ profile }).catch((error) => {
      console.error("Failed to start MCP HTTP server:", error);
      process.exit(1);
    });
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
