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
import { loadVaults, resolveVault } from "./vault-registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");

loadEnv({ path: path.join(repoRoot, ".env") });

const baseUrl = stripTrailingSlash(
  process.env.ANYTHINGLLM_BASE_URL ??
    `http://localhost:${process.env.HOST_ANYTHINGLLM_PORT ?? "11301"}`,
);
const apiKey = process.env.ANYTHINGLLM_API_KEY;
const vaultRegistryPath = process.env.VAULT_REGISTRY_PATH ?? "/workspace/.anything-obsidian-registry/vaults.json";
const workspacesPath =
  process.env.ANYTHINGLLM_WORKSPACES_PATH ?? "/api/v1/workspaces";
const chatPathTemplate =
  process.env.ANYTHINGLLM_CHAT_PATH_TEMPLATE ?? "/api/v1/workspace/{slug}/chat";
const vectorSearchPathTemplate =
  process.env.ANYTHINGLLM_VECTOR_SEARCH_PATH_TEMPLATE ??
  "/api/v1/workspace/{slug}/vector-search";
const mcpPort = Number(process.env.MCP_PORT ?? process.env.HOST_MCP_PORT ?? 11333);
const useHttp =
  process.argv.includes("--http") || process.env.MCP_TRANSPORT === "http";

function createServer() {
  const server = new McpServer({
    name: "anything-obsidian",
    version: "0.1.0",
  });

  server.tool(
    "anythingllm_vaults",
    "List managed vaults visible to MCP. Restricted vault policies are shown but are not enforced until caller identity exists.",
    {},
    async () => {
      return asJsonContent({ vaults: await loadVaults(vaultRegistryPath) });
    },
  );

  server.tool(
    "anythingllm_query",
    "Ask AnythingLLM to answer from one managed vault. Prefer anythingllm_vector_search when an agent needs source chunks.",
    {
      question: z.string().min(1),
      vaultId: z.string().min(1).optional(),
      mode: z.enum(["query", "chat"]).default("query"),
    },
    async ({ question, vaultId, mode }) => {
      const vault = resolveVault(await loadVaults(vaultRegistryPath), vaultId);
      const slug = encodeURIComponent(vault.workspaceSlug);
      const apiPath = chatPathTemplate.replace("{slug}", slug);
      const data = await requestJson(apiPath, {
        method: "POST",
        body: JSON.stringify({ message: question, mode }),
      });
      return asJsonContent(data);
    },
  );

  server.tool(
    "anythingllm_vector_search",
    "Search one managed vault vector index and return matching source chunks. Prefer this for agent RAG.",
    {
      query: z.string().min(1),
      vaultId: z.string().min(1).optional(),
      topN: z.number().int().positive().max(20).default(4),
      scoreThreshold: z.number().min(0).max(1).optional(),
    },
    async ({ query, vaultId, topN, scoreThreshold }) => {
      const vault = resolveVault(await loadVaults(vaultRegistryPath), vaultId);
      const slug = encodeURIComponent(vault.workspaceSlug);
      const apiPath = vectorSearchPathTemplate.replace("{slug}", slug);
      const data = await requestJson(apiPath, {
        method: "POST",
        body: JSON.stringify({ query, topN, scoreThreshold }),
      });
      return asJsonContent(data);
    },
  );

  return server;
}

async function requestJson(pathOrUrl: string, init: RequestInit) {
  if (!apiKey) {
    throw new Error(
      "Missing ANYTHINGLLM_API_KEY. Finish AnythingLLM setup, add the key to .env, then recreate the MCP service.",
    );
  }

  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `${baseUrl}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;

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

  if (!response.ok) {
    const detail = typeof data === "string" ? data : JSON.stringify(data);
    throw new Error(`AnythingLLM API ${response.status}: ${detail}`);
  }

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
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

if (useHttp) {
  const app = createMcpExpressApp(mcpHttpOptions());

  app.get("/health", (_: any, res: any) => {
    res.status(200).json({
      ok: true,
      name: "anything-obsidian-mcp",
      apiKeyConfigured: Boolean(apiKey),
    });
  });

  app.post("/mcp", async (req: any, res: any) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        transport.close();
        server.close();
      });
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", async (_: any, res: any) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });

  app.listen(mcpPort, (error?: Error) => {
    if (error) {
      console.error("Failed to start MCP HTTP server:", error);
      process.exit(1);
    }
    console.error(`anything-obsidian MCP HTTP server listening on ${mcpPort}`);
  });
} else {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
