import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createGatewayServer } from "./gateway.mjs";
import { createUserStore } from "./iam.mjs";
import { createSourceManager } from "./sources.mjs";

const ADMIN_TOKEN = "admin-token-1";
const SHARED = "shared";

test("gateway: health is public, everything else wants a token", async () => {
  const { baseUrl } = await startGateway();

  const health = await fetchJson(`${baseUrl}/health`, { method: "GET" });
  assert.equal(health.status, 200);
  assert.equal(health.body.name, "any-obs-gateway");

  const anonymous = await fetchJson(`${baseUrl}/api/gateway/search`, {
    method: "POST",
    body: JSON.stringify({ query: "anything" }),
  });
  assert.equal(anonymous.status, 401);

  const unproxied = await fetchJson(`${baseUrl}/api/v1/workspaces`, { method: "GET" });
  assert.equal(unproxied.status, 401);
});

test("gateway: admin manages users; a user token fans out across entitled workspaces", async () => {
  const { baseUrl, upstream } = await startGateway();

  const created = await fetchJson(`${baseUrl}/api/gateway/users`, {
    method: "POST",
    headers: auth(ADMIN_TOKEN),
    body: JSON.stringify({ name: "brian" }),
  });
  assert.equal(created.status, 201);
  assert.ok(created.body.token.length > 20);
  assert.equal(created.body.user.tokenHash, undefined);

  const listed = await fetchJson(`${baseUrl}/api/gateway/users`, { headers: auth(ADMIN_TOKEN) });
  assert.deepEqual(listed.body.users.map((user) => user.name), ["brian"]);
  assert.equal(
    (await fetchJson(`${baseUrl}/api/gateway/users`, { method: "POST", body: JSON.stringify({ name: "x" }) })).status,
    401,
  );

  const search = await fetchJson(`${baseUrl}/api/gateway/search`, {
    method: "POST",
    headers: auth(created.body.token),
    body: JSON.stringify({ query: "anything", topN: 3 }),
  });
  assert.equal(search.status, 200);
  // Only the shared workspace is entitled so far — the fan-out hit exactly it.
  assert.deepEqual(upstream.calls.filter((call) => call.path.endsWith("vector-search")).map((call) => call.slug), [SHARED]);
  assert.deepEqual(search.body.results.map((chunk) => [chunk.workspace, chunk.text]), [
    ["shared", "shared hit"],
  ]);
});

test("gateway: proxied workspace listing is filtered and workspace creation mints ownership", async () => {
  const { baseUrl } = await startGateway();
  const token = await createUser(baseUrl, "brian");

  const visible = await fetchJson(`${baseUrl}/api/v1/workspaces`, { headers: auth(token) });
  assert.equal(visible.status, 200);
  assert.deepEqual(visible.body.workspaces.map((workspace) => workspace.slug), [SHARED]);

  const created = await fetchJson(`${baseUrl}/api/v1/workspace/new`, {
    method: "POST",
    headers: auth(token),
    body: JSON.stringify({ name: "any-obs-brians-mac-01" }),
  });
  assert.equal(created.status, 200);

  // The unified workspace this user's client just created is now theirs:
  // listed, readable, and writable.
  const after = await fetchJson(`${baseUrl}/api/v1/workspaces`, { headers: auth(token) });
  assert.deepEqual(after.body.workspaces.map((workspace) => workspace.slug), [SHARED, "any-obs-brians-mac-01"]);

  const searchable = await fetchJson(`${baseUrl}/api/v1/workspace/any-obs-brians-mac-01/vector-search`, {
    method: "POST",
    headers: auth(token),
    body: JSON.stringify({ query: "anything", topN: 2 }),
  });
  assert.equal(searchable.status, 200);

  const denied = await fetchJson(`${baseUrl}/api/v1/workspace/other-secret/vector-search`, {
    method: "POST",
    headers: auth(token),
    body: JSON.stringify({ query: "anything" }),
  });
  assert.equal(denied.status, 403);
});

test("gateway: user tokens cannot reach unlisted endpoints; admin passes through", async () => {
  const { baseUrl, upstream } = await startGateway();
  const token = await createUser(baseUrl, "brian");

  const denied = await fetchJson(`${baseUrl}/api/v1/admin/anything`, { method: "POST", headers: auth(token) });
  assert.equal(denied.status, 403);
  assert.match(denied.body.error, /User tokens cannot call this endpoint/);

  const admin = await fetchJson(`${baseUrl}/api/v1/admin/anything`, { method: "POST", headers: auth(ADMIN_TOKEN) });
  assert.equal(admin.status, 200);
  assert.equal(upstream.calls.at(-1).path, "/api/v1/admin/anything");
});

test("gateway: sources CRUD and refresh jobs over REST", async () => {
  const { baseUrl } = await startGateway();
  const token = await createUser(baseUrl, "brian");

  const source = await fetchJson(`${baseUrl}/api/gateway/sources`, {
    method: "POST",
    headers: auth(ADMIN_TOKEN),
    body: JSON.stringify({ id: "team-kb", kind: "dir", ref: "/srv/kb" }),
  });
  assert.equal(source.status, 201);

  const listed = await fetchJson(`${baseUrl}/api/gateway/sources`, { headers: auth(token) });
  assert.equal(listed.body.sources.length, 1);

  const refresh = await fetchJson(`${baseUrl}/api/gateway/sources/team-kb/refresh`, {
    method: "POST",
    headers: auth(token),
  });
  assert.equal(refresh.status, 202);

  const job = await fetchJson(`${baseUrl}/api/gateway/jobs/${refresh.body.id}`, { headers: auth(token) });
  assert.equal(job.status, 200);
  assert.equal(job.body.sourceId, "team-kb");
});

test("gateway: MCP is token-gated, RAG fan-out plus pipeline jobs only", async () => {
  const { baseUrl } = await startGateway();
  const token = await createUser(baseUrl, "brian");

  const unauthenticated = new Client({ name: "t", version: "0" });
  await assert.rejects(
    () => unauthenticated.connect(mcpTransport(baseUrl, "nope")),
    /Bearer token required/,
  );

  const client = new Client({ name: "t", version: "0" });
  await client.connect(mcpTransport(baseUrl, token));
  const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(tools, [
    "any_obs_job_get",
    "any_obs_rag_answer",
    "any_obs_rag_search",
    "any_obs_shared_refresh",
  ]);

  const search = JSON.parse((await client.callTool({
    name: "any_obs_rag_search",
    arguments: { query: "anything" },
  })).content[0].text);
  assert.deepEqual(search.results.map((chunk) => chunk.workspace), [SHARED]);

  const denied = await client.callTool({
    name: "any_obs_rag_answer",
    arguments: { question: "hi", workspace: "other-secret" },
  });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /not readable/);

  await client.close();
});

function mcpTransport(baseUrl, token) {
  return new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
}

async function createUser(baseUrl, name) {
  const created = await fetchJson(`${baseUrl}/api/gateway/users`, {
    method: "POST",
    headers: auth(ADMIN_TOKEN),
    body: JSON.stringify({ name }),
  });
  assert.equal(created.status, 201);
  return created.body.token;
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, init);
  const body = await response.json();
  return { status: response.status, body };
}

async function startGateway() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "any-obs-gateway-test-"));
  const upstream = fakeAnythingllm();
  const server = createGatewayServer({
    userStore: createUserStore({ dataDir, sharedWorkspaceSlug: SHARED }),
    sourceManager: createSourceManager({
      dataDir,
      baseUrl: "http://anythingllm.test",
      apiKey: "admin-key",
      sharedWorkspaceSlug: SHARED,
      embedVault: async ({ config }) => ({ scanned: 0, uploaded: 0, removed: 0, workspaceSlug: config.workspaceSlug }),
      runGit: async () => "",
    }),
    anythingllmBaseUrl: "http://anythingllm.test",
    anythingllmApiKey: "admin-key",
    sharedWorkspaceSlug: SHARED,
    adminToken: ADMIN_TOKEN,
    fetchImpl: upstream.fetchImpl,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  test.after(() => server.close());
  return { baseUrl: `http://127.0.0.1:${port}`, upstream };
}

function fakeAnythingllm() {
  const state = {
    workspaces: [
      { id: 1, name: "shared", slug: SHARED },
      { id: 9, name: "other-secret", slug: "other-secret" },
    ],
    chunks: {
      [SHARED]: [{ text: "shared hit", score: 0.9 }],
      "other-secret": [{ text: "secret hit", score: 0.95 }],
    },
  };
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const call = { path: parsed.pathname, method: init.method ?? "GET", body: init.body };
    const slugMatch = parsed.pathname.match(/^\/api\/v1\/workspace\/([^/]+)\//);
    if (slugMatch) call.slug = decodeURIComponent(slugMatch[1]);
    calls.push(call);

    if (parsed.pathname === "/api/v1/workspaces") return jsonResponse(200, { workspaces: state.workspaces });
    if (parsed.pathname === "/api/v1/workspace/new") {
      const name = safeJson(init.body)?.name ?? "unnamed";
      const workspace = { id: state.workspaces.length + 1, name, slug: name };
      state.workspaces.push(workspace);
      return jsonResponse(200, { workspace });
    }
    if (parsed.pathname.endsWith("/vector-search") && init.method === "POST") {
      const slug = call.slug;
      return jsonResponse(200, { results: state.chunks[slug] ?? [] });
    }
    if (parsed.pathname.endsWith("/chat") && init.method === "POST") {
      return jsonResponse(200, { textResponse: "answer" });
    }
    return jsonResponse(200, { ok: true });
  };
  return { fetchImpl, calls, state };
}

function jsonResponse(status, data) {
  const body = JSON.stringify(data);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => body,
    arrayBuffer: async () => Buffer.from(body),
  };
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
