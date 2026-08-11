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
import { createVaultFileService } from "./vault-files.js";

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
const vaultsRoot = process.env.VAULTS_ROOT ?? "/vaults";
const dashboardBaseUrl = stripTrailingSlash(
  process.env.DASHBOARD_BASE_URL ?? `http://localhost:${process.env.HOST_DASHBOARD_PORT ?? "11300"}`,
);
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
const vaultFiles = createVaultFileService({
  vaultsRoot,
  registryPath: vaultRegistryPath,
  reindex: enqueueReindex,
});

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
    "obsidian_list_files",
    "List Markdown and Canvas files from one managed Obsidian vault. Paths are always vault-relative.",
    {
      vaultId: z.string().min(1).optional(),
      path: z.string().optional(),
      maxEntries: z.number().int().positive().max(1_000).optional(),
    },
    async (input) => asJsonContent(await vaultFiles.listFiles(input)),
  );

  server.tool(
    "obsidian_read_file",
    "Read a bounded line range from the source-of-truth Obsidian file and return its SHA-256 revision. Use the revision when writing a replacement or patch.",
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
    "obsidian_write_file",
    "Create a small Markdown or Canvas file, or replace one only when expectedSha256 matches the current source file. Successful writes queue an incremental RAG reindex.",
    {
      vaultId: z.string().min(1).optional(),
      path: z.string().min(1),
      content: z.string(),
      expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    },
    async (input) => asJsonContent(await vaultFiles.writeFile(input)),
  );

  server.tool(
    "obsidian_apply_patch",
    "Replace one unique text fragment in a source-of-truth Obsidian file. This is the preferred update path for large files and requires the current SHA-256 revision.",
    {
      vaultId: z.string().min(1).optional(),
      path: z.string().min(1),
      expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
      oldText: z.string().min(1),
      newText: z.string(),
    },
    async (input) => asJsonContent(await vaultFiles.applyPatch(input)),
  );

  server.tool(
    "obsidian_begin_upload",
    "Begin a resumable upload for a new large Markdown or Canvas file. Append bounded base64 chunks, then finish the upload to atomically publish and reindex it.",
    {
      vaultId: z.string().min(1).optional(),
      path: z.string().min(1),
      expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    },
    async (input) => asJsonContent(await vaultFiles.beginUpload(input)),
  );

  server.tool(
    "obsidian_append_upload",
    "Append one bounded, padded-base64 chunk to an Obsidian filesystem upload. This does not modify the vault or index until finish_upload succeeds.",
    {
      uploadId: z.string().uuid(),
      contentBase64: z.string().min(1),
    },
    async (input) => asJsonContent(await vaultFiles.appendUpload(input)),
  );

  server.tool(
    "obsidian_finish_upload",
    "Atomically publish a completed Obsidian upload and queue one incremental RAG reindex.",
    {
      uploadId: z.string().uuid(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    },
    async (input) => asJsonContent(await vaultFiles.finishUpload(input)),
  );

  server.tool(
    "obsidian_reindex",
    "Queue an incremental RAG reindex for a managed vault after an out-of-band source-file change.",
    { vaultId: z.string().min(1).optional() },
    async ({ vaultId }) => {
      const selected = resolveVault(await loadVaults(vaultRegistryPath), vaultId);
      return asJsonContent({ vaultId: selected.id, reindex: await enqueueReindex(selected.id) });
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

async function enqueueReindex(vaultId: string) {
  const response = await fetch(
    `${dashboardBaseUrl}/api/vaults/${encodeURIComponent(vaultId)}/actions/embed`,
    { method: "POST", headers: { Accept: "application/json" } },
  );
  const text = await response.text();
  const data = text ? parseJson(text) : null;
  if (!response.ok) {
    const detail = typeof data === "string" ? data : JSON.stringify(data);
    throw new Error(`Dashboard reindex API ${response.status}: ${detail}`);
  }
  return { jobId: typeof data === "object" && data && "id" in data ? String(data.id) : undefined };
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
