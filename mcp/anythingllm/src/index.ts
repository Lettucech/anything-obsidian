#!/usr/bin/env node
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { z } from "zod";
import { mcpHttpOptions } from "./http-config.js";
import { ANONYMOUS_IDENTITY, ADMIN_IDENTITY, loadVaults, resolveVault, visibleVaults, type CallerIdentity } from "./vault-registry.js";
import { loadAgentIdentities, resolveIdentity } from "./agent-identity.js";
import { createVaultFileService, type VaultFileService } from "./vault-files.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");

loadEnv({ path: path.join(repoRoot, ".env") });

const agentTokensPath = process.env.MCP_AGENT_TOKENS_PATH ?? "/workspace/.anything-obsidian-agent-tokens/agents.json";
const workspacesPath = process.env.ANYTHINGLLM_WORKSPACES_PATH ?? "/api/v1/workspaces";
const chatPathTemplate = process.env.ANYTHINGLLM_CHAT_PATH_TEMPLATE ?? "/api/v1/workspace/{slug}/chat";
const vectorSearchPathTemplate = process.env.ANYTHINGLLM_VECTOR_SEARCH_PATH_TEMPLATE ?? "/api/v1/workspace/{slug}/vector-search";

export type McpProfile = "local" | "lan";

export function createServer(profile: McpProfile = "local", identity: CallerIdentity = ANONYMOUS_IDENTITY) {
  const baseUrl = stripTrailingSlash(
    process.env.ANYTHINGLLM_BASE_URL ?? `http://localhost:${process.env.HOST_ANYTHINGLLM_PORT ?? "11301"}`,
  );
  const apiKey = process.env.ANYTHINGLLM_API_KEY;
  const vaultRegistryPath = process.env.VAULT_REGISTRY_PATH ?? "/workspace/.anything-obsidian-registry/vaults.json";
  const vaultsRoot = process.env.VAULTS_ROOT ?? "/vaults";
  const vaultFiles = createVaultFileService({
    vaultsRoot,
    registryPath: vaultRegistryPath,
    hostVaultsRoot: process.env.HOST_VAULTS_ROOT,
    identity,
  });

  const server = new McpServer({ name: "anything-obsidian", version: "0.3.0" });

  server.tool(
    "obsidian_vault_list",
    "List managed vault ids and names the caller can access for MCP selection. No repository, Git, or filesystem details are returned.",
    {},
    async () => asJsonContent({
      vaults: visibleVaults(await loadVaults(vaultRegistryPath), identity).map(({ id, name }) => ({ id, name })),
    }),
  );

  if (profile === "local") registerLocalVaultTools(server, vaultFiles);
  registerRagTools(server, { baseUrl, apiKey, vaultRegistryPath }, identity);
  return server;
}

function registerLocalVaultTools(server: McpServer, vaultFiles: VaultFileService) {
  server.tool(
    "obsidian_file_list",
    "List Markdown and Canvas files from one managed Obsidian vault. Paths are vault-relative and this tool is read-only.",
    {
      vaultId: z.string().min(1).optional(),
      path: z.string().optional(),
      maxEntries: z.number().int().positive().max(1_000).optional(),
    },
    async (input) => asJsonContent(await vaultFiles.listFiles(input)),
  );

  server.tool(
    "obsidian_file_read",
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
    "obsidian_vault_context",
    "Return local edit context for one managed vault: its host directory, policy files, non-secret sync settings, and source-of-truth boundaries. This tool is read-only and local-only.",
    { vaultId: z.string().min(1).optional() },
    async (input) => asJsonContent(await vaultFiles.context(input)),
  );

  server.tool(
    "obsidian_vault_directory",
    "Return the configured host directory for one managed vault. This tool is local-only so an agent can open the vault directly when it has local filesystem authority.",
    { vaultId: z.string().min(1).optional() },
    async (input) => asJsonContent(await vaultFiles.directory(input)),
  );
}

function registerRagTools(
  server: McpServer,
  { baseUrl, apiKey, vaultRegistryPath }: { baseUrl: string; apiKey?: string; vaultRegistryPath: string },
  identity: CallerIdentity,
) {
  server.tool(
    "anythingllm_answer",
    "Ask AnythingLLM to answer from one managed vault. Prefer anythingllm_search_chunks when an agent needs source chunks.",
    {
      question: z.string().min(1),
      vaultId: z.string().min(1).optional(),
      mode: z.enum(["query", "chat"]).default("query"),
    },
    async ({ question, vaultId, mode }) => {
      const vault = resolveVault(await loadVaults(vaultRegistryPath), vaultId, identity);
      const data = await requestJson(chatPathTemplate.replace("{slug}", encodeURIComponent(vault.workspaceSlug)), {
        method: "POST",
        body: JSON.stringify({ message: question, mode }),
      }, { baseUrl, apiKey });
      return asJsonContent(data);
    },
  );

  server.tool(
    "anythingllm_search_chunks",
    "Search one managed vault vector index and return matching source chunks. Prefer this for agent RAG.",
    {
      query: z.string().min(1),
      vaultId: z.string().min(1).optional(),
      topN: z.number().int().positive().max(20).default(4),
      scoreThreshold: z.number().min(0).max(1).optional(),
    },
    async ({ query, vaultId, topN, scoreThreshold }) => {
      const vault = resolveVault(await loadVaults(vaultRegistryPath), vaultId, identity);
      const data = await requestJson(vectorSearchPathTemplate.replace("{slug}", encodeURIComponent(vault.workspaceSlug)), {
        method: "POST",
        body: JSON.stringify({ query, topN, scoreThreshold }),
      }, { baseUrl, apiKey });
      return asJsonContent(data);
    },
  );
}

async function requestJson(pathOrUrl: string, init: RequestInit, { baseUrl, apiKey }: { baseUrl: string; apiKey?: string }) {
  if (!apiKey) {
    throw new Error("Missing ANYTHINGLLM_API_KEY. Finish AnythingLLM setup, add the key to .env, then recreate the MCP service.");
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

function parseJson(text: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function asJsonContent(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function startHttpServer(profile: McpProfile) {
  const adminToken = process.env.MCP_AUTH_TOKEN ?? "";
  if (profile === "lan" && !adminToken) throw new Error("MCP_AUTH_TOKEN is required for the LAN MCP profile");
  const app = createMcpExpressApp(mcpHttpOptions(process.env.MCP_ALLOWED_HOSTS));

  app.get("/health", (_: any, res: any) => {
    res.status(200).json({ ok: true, name: "anything-obsidian-mcp", profile, apiKeyConfigured: Boolean(process.env.ANYTHINGLLM_API_KEY) });
  });

  app.post("/mcp", async (req: any, res: any) => {
    const identity = resolveIdentity(req.get("authorization"), {
      adminToken,
      agents: await loadAgentIdentities(agentTokensPath),
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

  app.get("/mcp", (_: any, res: any) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  });

  app.listen(mcpPort(), (error?: Error) => {
    if (error) {
      console.error("Failed to start MCP HTTP server:", error);
      process.exit(1);
    }
    console.error(`anything-obsidian ${profile} MCP HTTP server listening on ${mcpPort()}`);
  });
}

function mcpPort() {
  return Number(process.env.MCP_PORT ?? process.env.HOST_MCP_PORT ?? 11333);
}

function isEntryPoint() {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === __filename;
}

if (isEntryPoint()) {
  const profile: McpProfile = process.env.MCP_PROFILE === "lan" ? "lan" : "local";
  if (process.argv.includes("--http") || process.env.MCP_TRANSPORT === "http") {
    startHttpServer(profile);
  } else {
    const server = createServer(profile, ADMIN_IDENTITY);
    await server.connect(new StdioServerTransport());
  }
}
