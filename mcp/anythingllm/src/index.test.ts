import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./index.js";

async function toolNames(profile: "local" | "lan") {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(profile);
  const client = new Client({ name: "anything-obsidian-test-client", version: "0.1.0" });

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const result = await client.listTools();
  await client.close();
  await server.close();
  return result.tools.map((tool) => tool.name).sort();
}

test("local MCP exposes only read-only vault discovery and RAG tools", async () => {
  assert.deepEqual(await toolNames("local"), [
    "anythingllm_answer",
    "anythingllm_search_chunks",
    "obsidian_file_list",
    "obsidian_file_read",
    "obsidian_vault_context",
    "obsidian_vault_directory",
    "obsidian_vault_list",
  ]);
});

test("LAN MCP exposes only RAG and safe vault selection metadata", async () => {
  assert.deepEqual(await toolNames("lan"), [
    "anythingllm_answer",
    "anythingllm_search_chunks",
    "obsidian_vault_list",
  ]);
});
