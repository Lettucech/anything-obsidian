#!/usr/bin/env node
import { timingSafeEqual } from "node:crypto";
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
import { loadVaults, resolveVault } from "./vault-registry.js";
import { createVaultFileService } from "./vault-files.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");

loadEnv({ path: path.join(repoRoot, ".env") });

const baseUrl = stripTrailingSlash(
  process.env.ANYTHINGLLM_BASE_URL ?? `http://localhost:${process.env.HOST_ANYTHINGLLM_PORT ?? "11301"}`,
);
const apiKey = process.env.ANYTHINGLLM_API_KEY;
const vaultRegistryPath = process.env.VAULT_REGISTRY_PATH ?? "/workspace/.anything-obsidian-registry/vaults.json";
const vaultsRoot = process.env.VAULTS_ROOT ?? "/vaults";
const workspacesPath = process.env.ANYTHINGLLM_WORKSPACES_PATH ?? "/api/v1/workspaces";
const chatPathTemplate = process.env.ANYTHINGLLM_CHAT_PATH_TEMPLATE ?? "/api/v1/workspace/{slug}/chat";
const vectorSearchPathTemplate = process.env.ANYTHINGLLM_VECTOR_SEARCH_PATH_TEMPLATE ?? "/api/v1/workspace/{slug}/vector-search";
const mcpPort = Number(process.env.MCP_PORT ?? process.env.HOST_MCP_PORT ?? 11333);
const vaultFiles = createVaultFileService({
  vaultsRoot,
  registryPath: vaultRegistryPath,
  hostVaultsRoot: process.env.HOST_VAULTS_ROOT,
});

export type McpProfile = "local" | "lan";

export function createServer(profile: McpProfile = "local") {
  const server = new McpServer({ name: "anything-obsidian", version: "0.2.0" });

  server.tool(
    "obsidian_vault_list",
    "List managed vault ids and names for MCP selection. No repository, Git, or filesystem details are returned.",
    {},
    async () => asJsonContent({ vaults: await safeVaultList() }),
  );

  if (profile === "local") registerLocalVaultTools(server);
  registerRagTools(server);
  return server;
}

function registerLocalVaultTools(server: McpServer) {
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
    "obsidian_vault_directory",
    "Return the configured host directory for one managed vault. This tool is local-only so an agent can open the vault directly when it has local filesystem authority.",
    { vaultId: z.string().min(1).optional() },
    async (input) => asJsonContent(await vaultFiles.directory(input)),
  );
}

function registerRagTools(server: McpServer) {
  server.tool(
    "anythingllm_answer",
    "Ask AnythingLLM to answer from one managed vault. Prefer anythingllm_search_chunks when an agent needs source chunks.",
    {
      question: z.string().min(1),
      vaultId: z.string().min(1).optional(),
      mode: z.enum(["query", "chat"]).default("query"),
    },
    async ({ question, vaultId, mode }) => {
      const vault = resolveVault(await loadVaults(vaultRegistryPath), vaultId);
      const data = await requestJson(chatPathTemplate.replace("{slug}", encodeURIComponent(vault.workspaceSlug)), {
        method: "POST",
        body: JSON.stringify({ message: question, mode }),
      });
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
      const vault = resolveVault(await loadVaults(vaultRegistryPath), vaultId);
      const data = await requestJson(vectorSearchPathTemplate.replace("{slug}", encodeURIComponent(vault.workspaceSlug)), {
        method: "POST",
        body: JSON.stringify({ query, topN, scoreThreshold }),
      });
      return asJsonContent(data);
    },
  );
}

async function safeVaultList() {
  return (await loadVaults(vaultRegistryPath)).map(({ id, name }) => ({ id, name }));
}

async function requestJson(pathOrUrl: string, init: RequestInit) {
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

export function hasBearerToken(authorization: string | undefined, token: string) {
  if (!token || authorization !== `Bearer ${token}`) return false;
  return timingSafeEqual(Buffer.from(authorization), Buffer.from(`Bearer ${token}`));
}

function startHttpServer(profile: McpProfile) {
  const token = process.env.MCP_AUTH_TOKEN ?? "";
  if (profile === "lan" && !token) throw new Error("MCP_AUTH_TOKEN is required for the LAN MCP profile");
  const app = createMcpExpressApp(mcpHttpOptions(process.env.MCP_ALLOWED_HOSTS));

  if (profile === "lan") {
    app.use((req: any, res: any, next: () => void) => {
      if (hasBearerToken(req.get("authorization"), token)) return next();
      return res.status(401).json({ error: "Bearer token required" });
    });
  }

  app.get("/health", (_: any, res: any) => {
    res.status(200).json({ ok: true, name: "anything-obsidian-mcp", profile, apiKeyConfigured: Boolean(apiKey) });
  });

  app.post("/mcp", async (req: any, res: any) => {
    const server = createServer(profile);
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

  app.listen(mcpPort, (error?: Error) => {
    if (error) {
      console.error("Failed to start MCP HTTP server:", error);
      process.exit(1);
    }
    console.error(`anything-obsidian ${profile} MCP HTTP server listening on ${mcpPort}`);
  });
}

function isEntryPoint() {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === __filename;
}

if (isEntryPoint()) {
  const profile: McpProfile = process.env.MCP_PROFILE === "lan" ? "lan" : "local";
  if (process.argv.includes("--http") || process.env.MCP_TRANSPORT === "http") {
    startHttpServer(profile);
  } else {
    const server = createServer(profile);
    await server.connect(new StdioServerTransport());
  }
}
