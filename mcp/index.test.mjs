import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./index.mjs";
import { ANONYMOUS_IDENTITY } from "./vault-registry.mjs";

async function toolNames(profile) {
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

test("local MCP exposes read-only vault tools, RAG tools, and management tools", async () => {
  assert.deepEqual(await toolNames("local"), [
    "any_obs_agent_create",
    "any_obs_agent_revoke",
    "any_obs_autostart",
    "any_obs_file_list",
    "any_obs_file_read",
    "any_obs_job_get",
    "any_obs_lan",
    "any_obs_rag_answer",
    "any_obs_rag_search",
    "any_obs_status",
    "any_obs_vault_add",
    "any_obs_vault_context",
    "any_obs_vault_directory",
    "any_obs_vault_doctor",
    "any_obs_vault_embed",
    "any_obs_vault_list",
    "any_obs_vault_remove",
    "any_obs_vault_sync",
    "any_obs_vault_update",
  ]);
});

test("LAN MCP exposes only RAG and safe vault selection metadata", async () => {
  assert.deepEqual(await toolNames("lan"), [
    "any_obs_rag_answer",
    "any_obs_rag_search",
    "any_obs_vault_list",
  ]);
});

async function listedVaults(profile, identity) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(profile, identity);
  const client = new Client({ name: "anything-obsidian-test-client", version: "0.1.0" });

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const result = await client.callTool({ name: "any_obs_vault_list", arguments: {} });
  await client.close();
  await server.close();
  const parsed = JSON.parse(result.content[0].text);
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
