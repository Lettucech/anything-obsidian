import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./index.js";
import { ANONYMOUS_IDENTITY, type CallerIdentity } from "./vault-registry.js";

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

async function listedVaults(profile: "local" | "lan", identity: CallerIdentity) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(profile, identity);
  const client = new Client({ name: "anything-obsidian-test-client", version: "0.1.0" });

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const result = await client.callTool({ name: "obsidian_vault_list", arguments: {} });
  await client.close();
  await server.close();
  const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text) as {
    vaults: Array<{ id: string }>;
  };
  return parsed.vaults.map((vault) => vault.id);
}

test("obsidian_vault_list is filtered by caller identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "anything-obsidian-mcp-index-"));
  const registryPath = path.join(root, "vaults.json");
  await writeFile(registryPath, JSON.stringify({
    vaults: [
      { id: "open-vault", name: "Open", directory: "open-vault", workspaceSlug: "open-vault", enabled: true, accessMode: "open", allowlist: [] },
      { id: "secret-vault", name: "Secret", directory: "secret-vault", workspaceSlug: "secret-vault", enabled: true, accessMode: "restricted", allowlist: ["scout"] },
      { id: "off-vault", name: "Off", directory: "off-vault", workspaceSlug: "off-vault", enabled: false, accessMode: "open", allowlist: [] },
    ],
  }));

  const previous = process.env.VAULT_REGISTRY_PATH;
  process.env.VAULT_REGISTRY_PATH = registryPath;
  try {
    assert.deepEqual(await listedVaults("local", ANONYMOUS_IDENTITY), ["open-vault"]);
    assert.deepEqual(await listedVaults("local", { kind: "agent", name: "scout" }), ["open-vault", "secret-vault"]);
    assert.deepEqual(await listedVaults("local", { kind: "agent", name: "other" }), ["open-vault"]);
    assert.deepEqual(await listedVaults("lan", { kind: "admin" }), ["open-vault", "secret-vault"]);
  } finally {
    if (previous === undefined) delete process.env.VAULT_REGISTRY_PATH;
    else process.env.VAULT_REGISTRY_PATH = previous;
  }
});
