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

  assert.equal((await fetchJson(`${adminUrl}/api/setup/api-key`, { method: "POST", body: JSON.stringify({ apiKey: "x" }) })).status, 403);

  // A gateway restarted on the same data volume stays configured and the
  // wizard-collected key is what reaches AnythingLLM.
  const restarted = await startGateway({ envKey: false, dataDir });
  assert.equal((await fetchJson(`${restarted.adminUrl}/health`)).body.configured, true);
  const { userToken } = await createUser(restarted.adminUrl, restarted.publicUrl, "brian");
  // The wizard-collected key is what reaches AnythingLLM: proxy through it.
  await fetchJson(`${restarted.publicUrl}/api/v1/workspace/new`, {
    method: "POST",
    headers: { Authorization: `Bearer ${userToken}` },
    body: JSON.stringify({ name: "any-obs-brians-mac-01" }),
  });
  assert.ok(restarted.upstream.calls.some((call) => call.headers === "Bearer minted-developer-key"));
});

test("nothing is pre-created: a fresh user searches an empty world until granted", async () => {
  const { adminUrl, publicUrl, upstream } = await startGateway();

  const created = await fetchJson(`${adminUrl}/api/gateway/users`, {
    method: "POST",
    body: JSON.stringify({ name: "brian" }),
  });
  assert.equal(created.status, 201);
  assert.ok(created.body.token.length > 20);

  const listed = await fetchJson(`${adminUrl}/api/gateway/users`, { method: "GET" });
  assert.deepEqual(listed.body.users.map((user) => user.name), ["brian"]);

  const search = await fetchJson(`${publicUrl}/api/gateway/search`, {
    method: "POST",
    headers: { Authorization: `Bearer ${created.body.token}` },
    body: JSON.stringify({ query: "anything", topN: 3 }),
  });
  assert.equal(search.status, 200);
  assert.deepEqual(search.body.results, []);
  assert.deepEqual(upstream.calls.filter((call) => call.path.endsWith("vector-search")), []);
});

test("shared workspaces: admin creates, grants users, search and answer respect grants", async () => {
  const { adminUrl, publicUrl } = await startGateway();

  await createUser(adminUrl, publicUrl, "brian");
  await createUser(adminUrl, publicUrl, "scout");

  const created = await fetchJson(`${adminUrl}/api/gateway/workspaces`, {
    method: "POST",
    body: JSON.stringify({ name: "company-kb", kind: "shared" }),
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.workspace, { slug: "company-kb", kind: "shared", grants: [] });

  const invalidKind = await fetchJson(`${adminUrl}/api/gateway/workspaces`, {
    method: "POST", body: JSON.stringify({ name: "x", kind: "wizard" }),
  });
  assert.equal(invalidKind.status, 400);

  const granted = await fetchJson(`${adminUrl}/api/gateway/workspaces/company-kb/grants`, {
    method: "POST", body: JSON.stringify({ user: "brian" }),
  });
  assert.deepEqual(granted.body, { slug: "company-kb", grants: ["brian"] });
  const ghostGrant = await fetchJson(`${adminUrl}/api/gateway/workspaces/company-kb/grants`, {
    method: "POST", body: JSON.stringify({ user: "ghost" }),
  });
  assert.equal(ghostGrant.status, 500);
  assert.match(ghostGrant.body.error, /Unknown user/);

  const listed = await fetchJson(`${adminUrl}/api/gateway/workspaces`);
  assert.deepEqual(listed.body.workspaces, [{ slug: "company-kb", kind: "shared", grants: ["brian"] }]);

  const brianToken = await getToken(publicUrl, adminUrl, "brian");
  const brianSearch = await fetchJson(`${publicUrl}/api/gateway/search`, {
    method: "POST", headers: { Authorization: `Bearer ${brianToken}` }, body: JSON.stringify({ query: "anything" }),
  });
  assert.deepEqual(brianSearch.body.results.map((chunk) => chunk.workspace), ["company-kb"]);

  const answer = await fetchJson(`${publicUrl}/api/v1/workspace/company-kb/chat`, {
    method: "POST", headers: { Authorization: `Bearer ${brianToken}` }, body: JSON.stringify({ message: "hi" }),
  });
  assert.equal(answer.status, 200);

  // scout has no grant: nothing to search, no chat, and grants are managed
  // by admins only.
  const scoutToken = await getToken(publicUrl, adminUrl, "scout");
  const scoutSearch = await fetchJson(`${publicUrl}/api/gateway/search`, {
    method: "POST", headers: { Authorization: `Bearer ${scoutToken}` }, body: JSON.stringify({ query: "anything" }),
  });
  assert.deepEqual(scoutSearch.body.results, []);
  assert.equal((await fetchJson(`${publicUrl}/api/v1/workspace/company-kb/chat`, {
    method: "POST", headers: { Authorization: `Bearer ${scoutToken}` }, body: JSON.stringify({ message: "hi" }),
  })).status, 403);

  const revoked = await fetchJson(`${adminUrl}/api/gateway/workspaces/company-kb/grants/brian`, { method: "DELETE" });
  assert.deepEqual(revoked.body, { slug: "company-kb", grants: [] });
  const afterRevoke = await fetchJson(`${publicUrl}/api/gateway/search`, {
    method: "POST", headers: { Authorization: `Bearer ${brianToken}` }, body: JSON.stringify({ query: "anything" }),
  });
  assert.deepEqual(afterRevoke.body.results, []);
});

test("public proxy: workspace listing is filtered and workspace creation mints ownership", async () => {
  const { adminUrl, publicUrl } = await startGateway();
  const adminAuthed = await createUser(adminUrl, publicUrl, "brian");
  const auth = { Authorization: `Bearer ${adminAuthed.userToken}` };

  // Mint the personal workspace through the proxy, as the client does.
  const created = await fetchJson(`${publicUrl}/api/v1/workspace/new`, {
    method: "POST", headers: auth, body: JSON.stringify({ name: "any-obs-brians-mac-01" }),
  });
  assert.equal(created.status, 200);

  const visible = await fetchJson(`${publicUrl}/api/v1/workspaces`, { headers: auth });
  assert.deepEqual(visible.body.workspaces.map((workspace) => workspace.slug), ["any-obs-brians-mac-01"]);

  assert.equal((await fetchJson(`${publicUrl}/api/v1/workspace/any-obs-brians-mac-01/vector-search`, {
    method: "POST", headers: auth, body: JSON.stringify({ query: "x", topN: 1 }),
  })).status, 200);
  assert.equal((await fetchJson(`${publicUrl}/api/v1/workspace/other-secret/vector-search`, {
    method: "POST", headers: auth, body: JSON.stringify({ query: "x" }),
  })).status, 403);
  assert.equal((await fetchJson(`${publicUrl}/api/v1/admin/anything`, { method: "POST", headers: auth })).status, 403);
});

test("workspaces tab data: list, pre-provision with an owner, all admin-only", async () => {
  const { adminUrl, publicUrl } = await startGateway();
  const { userToken } = await createUser(adminUrl, publicUrl, "brian");

  // The client mints its personal workspace through the proxy.
  await fetchJson(`${publicUrl}/api/v1/workspace/new`, {
    method: "POST", headers: { Authorization: `Bearer ${userToken}` }, body: JSON.stringify({ name: "any-obs-brians-mac-01" }),
  });

  const listed = await fetchJson(`${adminUrl}/api/gateway/workspaces`);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.workspaces, [
    { slug: "any-obs-brians-mac-01", kind: "personal", owner: "brian" },
  ]);

  const provisioned = await fetchJson(`${adminUrl}/api/gateway/workspaces`, {
    method: "POST",
    body: JSON.stringify({ name: "team-kb", kind: "personal", owner: "brian" }),
  });
  assert.equal(provisioned.status, 201);
  assert.deepEqual(provisioned.body.workspace, { slug: "team-kb", kind: "personal", owner: "brian" });
  const missingOwner = await fetchJson(`${adminUrl}/api/gateway/workspaces`, {
    method: "POST", body: JSON.stringify({ name: "x", kind: "personal" }),
  });
  assert.equal(missingOwner.status, 400);

  const searchable = await fetchJson(`${publicUrl}/api/v1/workspace/team-kb/vector-search`, {
    method: "POST", headers: { Authorization: `Bearer ${userToken}` }, body: JSON.stringify({ query: "x", topN: 2 }),
  });
  assert.equal(searchable.status, 200);

  // The member token gets 404 on the whole admin surface, listing included.
  assert.equal((await fetchJson(`${publicUrl}/api/gateway/workspaces`, { headers: { Authorization: `Bearer ${userToken}` } })).status, 404);
});

test("sources CRUD on the admin plane; refresh and jobs over the public plane", async () => {
  const { adminUrl, publicUrl } = await startGateway();
  const { userToken } = await createUser(adminUrl, publicUrl, "brian");
  const auth = { Authorization: `Bearer ${userToken}` };

  // Sources need a shared workspace to target.
  await fetchJson(`${adminUrl}/api/gateway/workspaces`, {
    method: "POST", body: JSON.stringify({ name: "company-kb", kind: "shared" }),
  });
  const missingTarget = await fetchJson(`${adminUrl}/api/gateway/sources`, {
    method: "POST", body: JSON.stringify({ id: "no-target", kind: "dir", ref: "/srv/kb" }),
  });
  assert.equal(missingTarget.status, 500);
  assert.match(missingTarget.body.error, /target a workspace/);

  const source = await fetchJson(`${adminUrl}/api/gateway/sources`, {
    method: "POST",
    body: JSON.stringify({ id: "team-kb", kind: "dir", ref: "/srv/kb", workspace: "company-kb" }),
  });
  assert.equal(source.status, 201);

  const listed = await fetchJson(`${publicUrl}/api/gateway/sources`, { headers: auth });
  assert.equal(listed.body.sources.length, 1);
  assert.equal(listed.body.sources[0].workspace, "company-kb");

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

  // answer demands an explicit workspace the caller may read
  const noWorkspace = await client.callTool({
    name: "any_obs_rag_answer",
    arguments: { question: "hi" },
  });
  assert.equal(noWorkspace.isError, true);

  await fetchJson(`${adminUrl}/api/gateway/workspaces`, {
    method: "POST", body: JSON.stringify({ name: "company-kb", kind: "shared" }),
  });
  await fetchJson(`${adminUrl}/api/gateway/workspaces/company-kb/grants`, {
    method: "POST", body: JSON.stringify({ user: "brian" }),
  });

  const search = JSON.parse((await client.callTool({
    name: "any_obs_rag_search",
    arguments: { query: "anything" },
  })).content[0].text);
  assert.deepEqual(search.results.map((chunk) => chunk.workspace), ["company-kb"]);

  const answer = JSON.parse((await client.callTool({
    name: "any_obs_rag_answer",
    arguments: { question: "hi", workspace: "company-kb" },
  })).content[0].text);
  assert.equal(answer.textResponse, "answer");

  const denied = await client.callTool({
    name: "any_obs_rag_answer",
    arguments: { question: "hi", workspace: "other-secret" },
  });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /not readable/);

  await client.close();
});

test("reverse scan: upstream workspaces the gateway does not track show as untracked and can be adopted", async () => {
  const { adminUrl, publicUrl } = await startGateway();
  const { userToken } = await createUser(adminUrl, publicUrl, "brian");

  // The fake upstream pre-seeds "other-secret" (made outside the gateway)
  // and the client mints a personal one through the proxy.
  await fetchJson(`${publicUrl}/api/v1/workspace/new`, {
    method: "POST", headers: { Authorization: `Bearer ${userToken}` }, body: JSON.stringify({ name: "any-obs-brians-mac-01" }),
  });

  const listed = await fetchJson(`${adminUrl}/api/gateway/workspaces`);
  assert.deepEqual(listed.body.untracked, [{ slug: "other-secret", name: "other-secret" }]);

  // Adopt it as shared.
  const adopted = await fetchJson(`${adminUrl}/api/gateway/workspaces/adopt`, {
    method: "POST", body: JSON.stringify({ slug: "other-secret", kind: "shared" }),
  });
  assert.equal(adopted.status, 201);
  assert.deepEqual(adopted.body.workspace, { slug: "other-secret", kind: "shared", grants: [] });

  // Tracking is the only difference: nothing was created upstream.
  assert.equal((await fetchJson(`${adminUrl}/api/gateway/workspaces`)).body.untracked.length, 0);

  // Adopt guards: already-tracked, upstream-missing, bad kind.
  assert.equal((await fetchJson(`${adminUrl}/api/gateway/workspaces/adopt`, {
    method: "POST", body: JSON.stringify({ slug: "other-secret", kind: "shared" }),
  })).status, 400);
  assert.equal((await fetchJson(`${adminUrl}/api/gateway/workspaces/adopt`, {
    method: "POST", body: JSON.stringify({ slug: "ghost-space", kind: "shared" }),
  })).status, 400);
  assert.equal((await fetchJson(`${adminUrl}/api/gateway/workspaces/adopt`, {
    method: "POST", body: JSON.stringify({ slug: "company-kb", kind: "wizard" }),
  })).status, 400);

  // Adopting as personal requires a known owner.
  const personal = await fetchJson(`${adminUrl}/api/gateway/workspaces/adopt`, {
    method: "POST", body: JSON.stringify({ slug: "company-kb", kind: "personal", owner: "ghost" }),
  });
  assert.equal(personal.status, 400);

  // A member token sees 404 on the adopt surface.
  assert.equal((await fetchJson(`${publicUrl}/api/gateway/workspaces/adopt`, {
    method: "POST", headers: { Authorization: `Bearer ${userToken}` }, body: JSON.stringify({ slug: "x", kind: "shared" }),
  })).status, 404);
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

async function getToken(publicUrl, adminUrl, name) {
  // tokens are once-shown; mint a fresh one for direct lookups in tests
  const reset = await fetchJson(`${adminUrl}/api/gateway/users/${encodeURIComponent(name)}/reset-token`, { method: "POST" });
  assert.equal(reset.status, 200);
  return reset.body.token;
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
    userStore: createUserStore({ dataDir }),
    gatewayConfig: (await import("./gateway-config.mjs")).createGatewayConfig({ dataDir }),
    sourceManager: createSourceManager({
      dataDir,
      baseUrl: "http://anythingllm.test",
      apiKey: "admin-key",
      embedVault: async ({ config }) => ({ scanned: 0, uploaded: 0, removed: 0, workspaceSlug: config.workspaceSlug }),
      runGit: async () => "",
    }),
    anythingllmBaseUrl: "http://anythingllm.test",
    anythingllmApiKey: envKey ? "admin-key" : "",
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
      { id: 9, name: "other-secret", slug: "other-secret" },
    ],
    chunks: {
      "other-secret": [{ text: "secret hit", score: 0.95 }],
      "company-kb": [{ text: "kb hit", score: 0.9 }],
    },
  };
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const call = { path: parsed.pathname, method: init.method ?? "GET", body: init.body, headers: init.headers?.Authorization };
    const slugMatch = parsed.pathname.match(/^\/api\/v1\/workspace\/([^/]+)\//);
    if (slugMatch) call.slug = decodeURIComponent(slugMatch[1]);
    calls.push(call);

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
