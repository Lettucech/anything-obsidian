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

const SHARED = "shared";

test("public plane: health is public, everything else wants a user token", async () => {
  const { publicUrl } = await startGateway();

  const health = await fetchJson(`${publicUrl}/health`, { method: "GET" });
  assert.equal(health.status, 200);
  assert.equal(health.body.plane, "public");

  const anonymous = await fetchJson(`${publicUrl}/api/gateway/search`, {
    method: "POST",
    body: JSON.stringify({ query: "anything" }),
  });
  assert.equal(anonymous.status, 401);
  assert.equal((await fetchJson(`${publicUrl}/api/v1/workspaces`, { method: "GET" })).status, 401);

  // No admin surface, no setup, no dashboard on the public plane.
  assert.equal((await fetchJson(`${publicUrl}/api/gateway/users`, { method: "GET" })).status, 404);
  assert.equal((await fetchJson(`${publicUrl}/api/setup/api-key`, { method: "POST", body: JSON.stringify({ apiKey: "x" }) })).status, 404);
  assert.equal((await fetch(`${publicUrl}/`)).status, 404);
});

test("admin plane: dashboard serves, management is loopback-trusted, public-only routes absent", async () => {
  const { adminUrl } = await startGateway();

  const page = await fetch(`${adminUrl}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /any-obs gateway/);

  const users = await fetchJson(`${adminUrl}/api/gateway/users`, { method: "GET" });
  assert.equal(users.status, 200);
  assert.deepEqual(users.body.users, []);

  // The admin plane also carries the recovery passthrough…
  const passthrough = await fetchJson(`${adminUrl}/api/v1/admin/anything`, { method: "POST" });
  assert.equal(passthrough.status, 200);
  // …but not the MCP endpoint.
  assert.equal((await fetchJson(`${adminUrl}/mcp`, { method: "POST", body: JSON.stringify({}) })).status, 404);
});

test("setup wizard on the admin plane: verify, store, close; restart persists", async () => {
  const { adminUrl, upstream, dataDir } = await startGateway({ envKey: false });

  assert.equal((await fetchJson(`${adminUrl}/health`)).body.configured, false);

  const bad = await fetchJson(`${adminUrl}/api/setup/api-key`, {
    method: "POST",
    body: JSON.stringify({ apiKey: "wrong" }),
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /rejected this API key/);

  const done = await fetchJson(`${adminUrl}/api/setup/api-key`, {
    method: "POST",
    body: JSON.stringify({ apiKey: "minted-developer-key" }),
  });
  assert.equal(done.status, 200);
  assert.equal(done.body.configured, true);
  assert.equal(done.body.sharedWorkspace.slug, SHARED);

  assert.equal((await fetchJson(`${adminUrl}/api/setup/api-key`, { method: "POST", body: JSON.stringify({ apiKey: "x" }) })).status, 403);

  // A gateway restarted on the same data volume stays configured and the
  // wizard-collected key is what reaches AnythingLLM.
  const restarted = await startGateway({ envKey: false, dataDir });
  assert.equal((await fetchJson(`${restarted.adminUrl}/health`)).body.configured, true);
  const { userToken } = await createUser(restarted.adminUrl, restarted.publicUrl, "brian");
  const search = await fetchJson(`${restarted.publicUrl}/api/gateway/search`, {
    method: "POST",
    headers: { Authorization: `Bearer ${userToken}` },
    body: JSON.stringify({ query: "anything" }),
  });
  assert.equal(search.status, 200);
  assert.ok(restarted.upstream.calls.some((call) => call.headers === "Bearer minted-developer-key"));
});

test("admin creates users; a user token fans out across entitled workspaces", async () => {
  const { adminUrl, publicUrl, upstream } = await startGateway();

  const created = await fetchJson(`${adminUrl}/api/gateway/users`, {
    method: "POST",
    body: JSON.stringify({ name: "brian" }),
  });
  assert.equal(created.status, 201);
  assert.ok(created.body.token.length > 20);
  assert.equal(created.body.user.tokenHash, undefined);

  const listed = await fetchJson(`${adminUrl}/api/gateway/users`, { method: "GET" });
  assert.deepEqual(listed.body.users.map((user) => user.name), ["brian"]);

  const search = await fetchJson(`${publicUrl}/api/gateway/search`, {
    method: "POST",
    headers: { Authorization: `Bearer ${created.body.token}` },
    body: JSON.stringify({ query: "anything", topN: 3 }),
  });
  assert.equal(search.status, 200);
  assert.deepEqual(upstream.calls.filter((call) => call.path.endsWith("vector-search")).map((call) => call.slug), [SHARED]);
  assert.deepEqual(search.body.results.map((chunk) => [chunk.workspace, chunk.text]), [["shared", "shared hit"]]);
});

test("public proxy: workspace listing is filtered and workspace creation mints ownership", async () => {
  const { adminUrl, publicUrl } = await startGateway();
  const { userToken } = await createUser(adminUrl, publicUrl, "brian");
  const auth = { Authorization: `Bearer ${userToken}` };

  const visible = await fetchJson(`${publicUrl}/api/v1/workspaces`, { headers: auth });
  assert.equal(visible.status, 200);
  assert.deepEqual(visible.body.workspaces.map((workspace) => workspace.slug), [SHARED]);

  const created = await fetchJson(`${publicUrl}/api/v1/workspace/new`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: "any-obs-brians-mac-01" }),
  });
  assert.equal(created.status, 200);

  const after = await fetchJson(`${publicUrl}/api/v1/workspaces`, { headers: auth });
  assert.deepEqual(after.body.workspaces.map((workspace) => workspace.slug), [SHARED, "any-obs-brians-mac-01"]);

  assert.equal((await fetchJson(`${publicUrl}/api/v1/workspace/any-obs-brians-mac-01/vector-search`, {
    method: "POST", headers: auth, body: JSON.stringify({ query: "x", topN: 1 }),
  })).status, 200);
  assert.equal((await fetchJson(`${publicUrl}/api/v1/workspace/other-secret/vector-search`, {
    method: "POST", headers: auth, body: JSON.stringify({ query: "x" }),
  })).status, 403);
  assert.equal((await fetchJson(`${publicUrl}/api/v1/admin/anything`, { method: "POST", headers: auth })).status, 403);
});

test("sources CRUD on the admin plane; refresh and jobs over the public plane", async () => {
  const { adminUrl, publicUrl } = await startGateway();
  const { userToken } = await createUser(adminUrl, publicUrl, "brian");
  const auth = { Authorization: `Bearer ${userToken}` };

  const source = await fetchJson(`${adminUrl}/api/gateway/sources`, {
    method: "POST",
    body: JSON.stringify({ id: "team-kb", kind: "dir", ref: "/srv/kb" }),
  });
  assert.equal(source.status, 201);

  const listed = await fetchJson(`${publicUrl}/api/gateway/sources`, { headers: auth });
  assert.equal(listed.body.sources.length, 1);

  const refresh = await fetchJson(`${publicUrl}/api/gateway/sources/team-kb/refresh`, {
    method: "POST", headers: auth,
  });
  assert.equal(refresh.status, 202);

  const job = await fetchJson(`${publicUrl}/api/gateway/jobs/${refresh.body.id}`, { headers: auth });
  assert.equal(job.status, 200);
  assert.equal(job.body.sourceId, "team-kb");
});

test("MCP on the public plane is token-gated with the four RAG/pipeline tools", async () => {
  const { adminUrl, publicUrl } = await startGateway();
  const { userToken } = await createUser(adminUrl, publicUrl, "brian");

  const unauthenticated = new Client({ name: "t", version: "0" });
  await assert.rejects(
    () => unauthenticated.connect(mcpTransport(publicUrl, "nope")),
    /Bearer token required/,
  );

  const client = new Client({ name: "t", version: "0" });
  await client.connect(mcpTransport(publicUrl, userToken));
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

test("roles: set at create, change later, delegate admin over the public plane", async () => {
  const { adminUrl, publicUrl } = await startGateway();
  const { userToken: memberToken } = await createUser(adminUrl, publicUrl, "member-1", "member");
  const { userToken: adminToken } = await createUser(adminUrl, publicUrl, "ops", "admin");

  // A member token sees nothing administrative on the public plane.
  assert.equal((await fetchJson(`${publicUrl}/api/gateway/users`, { headers: { Authorization: `Bearer ${memberToken}` } })).status, 404);

  // An admin-role token manages users over the public plane: create with a
  // role, change it, and pass through the proxy without SSH.
  const delegated = await fetchJson(`${publicUrl}/api/gateway/users`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ name: "bot", role: "reader" }),
  });
  assert.equal(delegated.status, 201);
  assert.equal(delegated.body.user.role, "reader");

  const patched = await fetchJson(`${publicUrl}/api/gateway/users/bot`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ role: "member" }),
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.role, "member");
  assert.equal((await fetchJson(`${publicUrl}/api/v1/admin/anything`, {
    method: "POST", headers: { Authorization: `Bearer ${adminToken}` },
  })).status, 200);
  const badRole = await fetchJson(`${publicUrl}/api/gateway/users/bot`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ role: "wizard" }),
  });
  assert.equal(badRole.status, 500);
  assert.match(badRole.body.error, /Role must be one of/);
});

test("readers get search but not workspace creation through the proxy", async () => {
  const { adminUrl, publicUrl } = await startGateway();
  const { userToken } = await createUser(adminUrl, publicUrl, "bot", "reader");
  const auth = { Authorization: `Bearer ${userToken}` };

  const search = await fetchJson(`${publicUrl}/api/gateway/search`, {
    method: "POST", headers: auth, body: JSON.stringify({ query: "anything" }),
  });
  assert.equal(search.status, 200);

  const create = await fetchJson(`${publicUrl}/api/v1/workspace/new`, {
    method: "POST", headers: auth, body: JSON.stringify({ name: "any-obs-bot-01" }),
  });
  assert.equal(create.status, 403);
  assert.match(create.body.error, /Reader tokens cannot create workspaces/);
});

test("resetting a token kills the old one on the spot", async () => {
  const { adminUrl, publicUrl } = await startGateway();
  const { userToken } = await createUser(adminUrl, publicUrl, "brian", "member");

  const reset = await fetchJson(`${adminUrl}/api/gateway/users/brian/reset-token`, { method: "POST" });
  assert.equal(reset.status, 200);
  assert.ok(reset.body.token.length > 20);

  const stale = await fetchJson(`${publicUrl}/api/gateway/search`, {
    method: "POST", headers: { Authorization: `Bearer ${userToken}` }, body: JSON.stringify({ query: "x" }),
  });
  assert.equal(stale.status, 401);

  const fresh = await fetchJson(`${publicUrl}/api/gateway/search`, {
    method: "POST", headers: { Authorization: `Bearer ${reset.body.token}` }, body: JSON.stringify({ query: "x" }),
  });
  assert.equal(fresh.status, 200);
  assert.equal((await fetchJson(`${adminUrl}/api/gateway/users/ghost/reset-token`, { method: "POST" })).status, 404);
});

test("admins delete a user's workspace: upstream goes first, then the ownership record", async () => {
  const { adminUrl, publicUrl, upstream } = await startGateway();
  const { userToken } = await createUser(adminUrl, publicUrl, "brian");
  const auth = { Authorization: `Bearer ${userToken}` };

  // The user's client mints its personal workspace through the proxy.
  await fetchJson(`${publicUrl}/api/v1/workspace/new`, {
    method: "POST", headers: auth, body: JSON.stringify({ name: "any-obs-brians-mac-01" }),
  });
  assert.deepEqual((await fetchJson(`${adminUrl}/api/gateway/users`)).body.users
    .find((user) => user.name === "brian").workspaces, ["any-obs-brians-mac-01"]);

  // A member token cannot delete workspaces.
  assert.equal((await fetchJson(`${publicUrl}/api/gateway/workspaces/any-obs-brians-mac-01`, {
    method: "DELETE", headers: auth,
  })).status, 404);

  // The admin (loopback plane here) can; upstream is called with the admin
  // key and the entitlement disappears entirely.
  const removed = await fetchJson(`${adminUrl}/api/gateway/workspaces/any-obs-brians-mac-01`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  assert.equal(upstream.calls.some((call) => call.method === "DELETE" && call.path.endsWith("/workspace/any-obs-brians-mac-01")), true);
  assert.deepEqual((await fetchJson(`${adminUrl}/api/gateway/users`)).body.users
    .find((user) => user.name === "brian").workspaces, []);
  assert.deepEqual(await fetchJson(`${publicUrl}/api/v1/workspaces`, { headers: auth }).then((r) => r.body.workspaces.map((w) => w.slug)), [SHARED]);

  // Deleting an upstream-already-gone workspace still clears the record.
  await fetchJson(`${adminUrl}/api/gateway/users`, {
    method: "POST", body: JSON.stringify({ name: "ghost" }),
  });
  assert.equal((await fetchJson(`${adminUrl}/api/gateway/workspaces/any-obs-ghost-404`, { method: "DELETE" })).status, 200);
});

function mcpTransport(baseUrl, token) {
  return new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
}

async function createUser(adminUrl, publicUrl, name, role = "member") {
  const created = await fetchJson(`${adminUrl}/api/gateway/users`, {
    method: "POST",
    body: JSON.stringify({ name, role }),
  });
  assert.equal(created.status, 201);
  return { userToken: created.body.token };
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, init);
  const body = await response.json();
  return { status: response.status, body };
}

async function startGateway({ envKey = true, dataDir: dataDirOverride } = {}) {
  const dataDir = dataDirOverride ?? await mkdtemp(path.join(tmpdir(), "any-obs-gateway-test-"));
  const upstream = fakeAnythingllm();
  const shared = {
    userStore: createUserStore({ dataDir, sharedWorkspaceSlug: SHARED }),
    gatewayConfig: (await import("./gateway-config.mjs")).createGatewayConfig({ dataDir }),
    sourceManager: createSourceManager({
      dataDir,
      baseUrl: "http://anythingllm.test",
      apiKey: "admin-key",
      sharedWorkspaceSlug: SHARED,
      embedVault: async ({ config }) => ({ scanned: 0, uploaded: 0, removed: 0, workspaceSlug: config.workspaceSlug }),
      runGit: async () => "",
    }),
    anythingllmBaseUrl: "http://anythingllm.test",
    anythingllmApiKey: envKey ? "admin-key" : "",
    sharedWorkspaceSlug: SHARED,
    fetchImpl: upstream.fetchImpl,
  };
  const servers = [];
  for (const plane of ["public", "admin"]) {
    const server = createGatewayServer({ ...shared, plane });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
  }
  test.after(() => servers.forEach((server) => server.close()));
  return {
    publicUrl: `http://127.0.0.1:${servers[0].address().port}`,
    adminUrl: `http://127.0.0.1:${servers[1].address().port}`,
    upstream,
    dataDir,
  };
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
    const call = { path: parsed.pathname, method: init.method ?? "GET", body: init.body, headers: init.headers?.Authorization };
    const slugMatch = parsed.pathname.match(/^\/api\/v1\/workspace\/([^/]+)\//);
    if (slugMatch) call.slug = decodeURIComponent(slugMatch[1]);
    calls.push(call);

    // AnythingLLM itself rejects calls without a valid developer key.
    const bearer = String(init.headers?.Authorization ?? "");
    if (parsed.pathname.startsWith("/api/v1/") && bearer !== "Bearer admin-key" && bearer !== "Bearer minted-developer-key") {
      return jsonResponse(401, { error: "invalid api key" });
    }
    if (parsed.pathname === "/api/v1/workspaces") return jsonResponse(200, { workspaces: state.workspaces });
    if (parsed.pathname === "/api/v1/workspace/new") {
      const name = safeJson(init.body)?.name ?? "unnamed";
      const workspace = { id: state.workspaces.length + 1, name, slug: name };
      state.workspaces.push(workspace);
      return jsonResponse(200, { workspace });
    }
    if (parsed.pathname.endsWith("/vector-search") && init.method === "POST") {
      return jsonResponse(200, { results: state.chunks[call.slug] ?? [] });
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
