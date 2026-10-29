import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

test("vault_list entries carry the last sync outcome without error details", async () => {  const root = await mkdtemp(path.join(os.tmpdir(), "anything-obsidian-mcp-list-"));
  const registryPath = path.join(root, "vaults.json");
  const stateRoot = path.join(root, "state");
  await mkdir(stateRoot, { recursive: true });
  await writeFile(registryPath, JSON.stringify({
    vaults: [
      { id: "work", name: "Work", directory: "work", workspaceSlug: "work", enabled: true, accessMode: "open", allowlist: [] },
    ],
  }));
  await writeFile(path.join(stateRoot, "last-sync.json"), JSON.stringify({
    version: 1,
    vaults: { work: { status: "failed", finishedAt: "2026-10-15T00:00:00.000Z", error: "secret-ish detail" } },
  }));

  const previousRegistry = process.env.VAULT_REGISTRY_PATH;
  const previousState = process.env.VAULT_STATE_ROOT;
  process.env.VAULT_REGISTRY_PATH = registryPath;
  process.env.VAULT_STATE_ROOT = stateRoot;
  try {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer("local");
    const client = new Client({ name: "t", version: "0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "any_obs_vault_list", arguments: {} });
    await client.close();
    await server.close();
    const vaults = JSON.parse(result.content[0].text).vaults;
    assert.deepEqual(vaults, [
      { id: "work", name: "Work", lastSync: { status: "failed", finishedAt: "2026-10-15T00:00:00.000Z" } },
    ]);
  } finally {
    if (previousRegistry === undefined) delete process.env.VAULT_REGISTRY_PATH;
    else process.env.VAULT_REGISTRY_PATH = previousRegistry;
    if (previousState === undefined) delete process.env.VAULT_STATE_ROOT;
    else process.env.VAULT_STATE_ROOT = previousState;
  }
});

test("rag tools query the unified workspace with attribution and access filtering", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "anything-obsidian-mcp-rag-"));
  const registryPath = path.join(root, "vaults.json");
  await writeFile(registryPath, JSON.stringify({
    workspace: { slug: "any-obs-test-01", name: "Anything Obsidian" },
    vaults: [
      { id: "work", name: "Work", directory: "work", enabled: true, accessMode: "open", allowlist: [] },
      { id: "secret", name: "Secret", directory: "secret", enabled: true, accessMode: "restricted", allowlist: ["scout"] },
    ],
  }));

  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        results: [
          { score: 0.9, chunkSource: "work/notes/a.md" },
          { score: 0.8, chunkSource: "secret/notes/s.md" },
          { score: 0.7, chunkSource: "work/notes/b.md" },
        ],
      }),
    };
  };

  const previous = captureEnv({
    VAULT_REGISTRY_PATH: registryPath,
    ANYTHINGLLM_BASE_URL: "http://anythingllm.test",
    ANYTHINGLLM_API_KEY: "key",
  });
  try {
    const [client, server] = await connect("local", ANONYMOUS_IDENTITY);

    const search = JSON.parse((await client.callTool({
      name: "any_obs_rag_search",
      arguments: { query: "meeting notes" },
    })).content[0].text);
    assert.deepEqual(requests.at(-1).url, "http://anythingllm.test/api/v1/workspace/any-obs-test-01/vector-search");
    // The restricted vault is invisible to an anonymous caller even though
    // its chunks live in the shared index.
    assert.deepEqual(search.results.map((chunk) => [chunk.vaultId, chunk.vaultPath]), [
      ["work", "notes/a.md"],
      ["work", "notes/b.md"],
    ]);
    assert.deepEqual(search.vaultAttribution, { attributed: 2, dropped: 1 });

    const filtered = JSON.parse((await client.callTool({
      name: "any_obs_rag_search",
      arguments: { query: "meeting notes", vaultId: "work" },
    })).content[0].text);
    assert.deepEqual(filtered.results.map((chunk) => chunk.vaultPath), ["notes/a.md", "notes/b.md"]);

    const denied = await client.callTool({
      name: "any_obs_rag_search",
      arguments: { query: "anything", vaultId: "secret" },
    });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /restricted and this caller has no access/);

    const answer = JSON.parse((await client.callTool({
      name: "any_obs_rag_answer",
      arguments: { question: "what changed?" },
    })).content[0].text);
    assert.deepEqual(requests.at(-1).url, "http://anythingllm.test/api/v1/workspace/any-obs-test-01/chat");
    assert.equal(answer.results.length, 3);

    await client.close();
    await server.close();
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(previous);
  }
});

test("rag tools explain themselves when no unified workspace is configured yet", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "anything-obsidian-mcp-rag-empty-"));
  const registryPath = path.join(root, "vaults.json");
  await writeFile(registryPath, JSON.stringify({ vaults: [] }));

  const previous = captureEnv({ VAULT_REGISTRY_PATH: registryPath });
  try {
    const [client, server] = await connect("local", ANONYMOUS_IDENTITY);
    const result = await client.callTool({ name: "any_obs_rag_search", arguments: { query: "anything" } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /No unified workspace is configured yet/);
    await client.close();
    await server.close();
  } finally {
    restoreEnv(previous);
  }
});

async function connect(profile, identity) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(profile, identity);
  const client = new Client({ name: "anything-obsidian-test-client", version: "0.1.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return [client, server];
}

function captureEnv(overrides) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  return previous;
}

function restoreEnv(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test("rag_search fans out across every workspace the key can see and merges by score", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "anything-obsidian-mcp-fanout-"));
  const registryPath = path.join(root, "vaults.json");
  await writeFile(registryPath, JSON.stringify({
    workspace: { slug: "any-obs-own-01", name: "Anything Obsidian" },
    vaults: [
      { id: "work", name: "Work", directory: "work", enabled: true, accessMode: "open", allowlist: [] },
    ],
  }));

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body });
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/v1/workspaces") {
      // The gateway/proxy answers with exactly what this token may read.
      return jsonResponse({ workspaces: [{ slug: "any-obs-own-01" }, { slug: "company-kb" }] });
    }
    const slug = decodeURIComponent(parsed.pathname.split("/")[4] ?? "");
    return jsonResponse({
      results: slug === "company-kb"
        ? [{ score: 0.95, chunkSource: "work/handbook/intro.md", text: "shared best hit" }]
        : [{ score: 0.7, chunkSource: "work/notes/a.md", text: "own hit" }],
    });
  };

  const previous = captureEnv({
    VAULT_REGISTRY_PATH: registryPath,
    ANYTHINGLLM_BASE_URL: "http://anythingllm.test",
    ANYTHINGLLM_API_KEY: "user-token",
  });
  try {
    const [client, server] = await connect("local", ANONYMOUS_IDENTITY);
    const search = JSON.parse((await client.callTool({
      name: "any_obs_rag_search",
      arguments: { query: "anything", topN: 5 },
    })).content[0].text);

    // Merged by score across both workspaces, each tagged with its own.
    assert.deepEqual(search.results.map((chunk) => [chunk.workspace, chunk.text]), [
      ["company-kb", "shared best hit"],
      ["any-obs-own-01", "own hit"],
    ]);
    assert.equal(search.vaultAttribution.attributed, 2);
    assert.deepEqual(search.workspaces.searched, ["any-obs-own-01", "company-kb"]);
    assert.deepEqual(search.workspaces.failed, []);

    await client.close();
    await server.close();
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(previous);
  }
});

function jsonResponse(data) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(data),
  };
}
