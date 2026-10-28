import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "./index.mjs";
import { dashboardApi } from "./manage.mjs";

function fakeDashboard(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const key = `${init.method || "GET"} ${parsed.pathname}`;
    calls.push({ key, body: init.body ? JSON.parse(init.body) : null });
    const handler = Object.entries(routes).find(([pattern]) => {
      const [method, pathname] = pattern.split(" ");
      if (method !== (init.method || "GET")) return false;
      if (pathname.includes(":")) {
        const patternParts = pathname.split("/").filter(Boolean);
        const actualParts = parsed.pathname.split("/").filter(Boolean);
        if (patternParts.length !== actualParts.length) return false;
        return patternParts.every((part, index) => part.startsWith(":") || part === actualParts[index]);
      }
      return pathname === parsed.pathname;
    });
    if (!handler) return { ok: false, status: 404, text: async () => JSON.stringify({ error: "no route" }) };
    return { ok: true, status: 200, text: async () => JSON.stringify(handler[1](calls.at(-1))) };
  };
  return { calls, fetchImpl };
}

test("dashboard api surfaces a clear error when the dashboard is down", async () => {
  const api = dashboardApi({ baseUrl: "http://127.0.0.1:1", fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  await assert.rejects(() => api.status(), /dashboard is not reachable.*anything-obsidian start/s);
});

test("dashboard api maps every management call to its REST route", async () => {
  const dashboard = fakeDashboard({
    "GET /api/status": () => ({ ok: true }),
    "POST /api/vaults": (call) => ({ id: call.body.id }),
    "PATCH /api/vaults/:id": (call) => ({ id: call.body.name, patched: true }),
    "DELETE /api/vaults/:id": () => null,
    "POST /api/vaults/:id/actions/:action": (call) => ({ id: "job-1", actionId: call.body ?? "sync" }),
    "GET /api/jobs/:jobId": () => ({ id: "job-1", status: "succeeded" }),
    "GET /api/agents": () => ({ agents: [] }),
    "POST /api/agents": (call) => ({ agent: { name: call.body.name }, token: "raw-token" }),
    "DELETE /api/agents/:name": () => ({ removed: true }),
    "GET /api/autostart": () => ({ enabled: true }),
    "POST /api/autostart": (call) => ({ enabled: call.body.action === "on" }),
    "GET /api/lan": () => ({ enabled: false }),
    "POST /api/lan": (call) => ({ enabled: true, ...(call.body.action === "on" ? { token: "generated" } : {}) }),
  });
  const api = dashboardApi({ baseUrl: "http://dash", fetchImpl: dashboard.fetchImpl });

  assert.deepEqual(await api.status(), { ok: true });
  assert.deepEqual(await api.addVault({ sourceMode: "import", id: "work" }), { id: "work" });
  assert.deepEqual(await api.updateVault("work", { name: "W" }), { id: "W", patched: true });
  assert.equal(await api.removeVault("work"), null);
  assert.deepEqual(await api.job("job-1"), { id: "job-1", status: "succeeded" });
  assert.deepEqual(await api.createAgent("scout"), { agent: { name: "scout" }, token: "raw-token" });
  assert.deepEqual(await api.setAutostart("on"), { enabled: true });
  assert.deepEqual(await api.setLan("on"), { enabled: true, token: "generated" });

  assert.deepEqual(dashboard.calls.map((call) => call.key), [
    "GET /api/status",
    "POST /api/vaults",
    "PATCH /api/vaults/work",
    "DELETE /api/vaults/work",
    "GET /api/jobs/job-1",
    "POST /api/agents",
    "POST /api/autostart",
    "POST /api/lan",
  ]);
});

test("management tools round-trip through the in-memory MCP client", async () => {
  const dashboard = fakeDashboard({
    "POST /api/vaults": (call) => ({ id: call.body.id }),
    "GET /api/status": () => ({ ok: true, systemState: "on" }),
  });
  // createServer wires dashboardApi() with defaults; override via env would be
  // intrusive here, so drive the tools through a server built with the api directly.
  const { registerManagementTools } = await import("./manage.mjs");
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { z } = await import("zod");
  const server = new McpServer({ name: "test", version: "0" });
  registerManagementTools(server, dashboardApi({ baseUrl: "http://dash", fetchImpl: dashboard.fetchImpl }), { z });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(clientTransport);

  const added = await client.callTool({
    name: "any_obs_vault_add",
    arguments: { sourceMode: "import", id: "work", directory: "work", gitUserName: "A", gitUserEmail: "a@b" },
  });
  assert.deepEqual(JSON.parse(added.content[0].text), { id: "work" });

  const status = await client.callTool({ name: "any_obs_status", arguments: {} });
  assert.equal(JSON.parse(status.content[0].text).systemState, "on");
  await client.close();
  await server.close();
});

test("server error bodies surface their error message", async () => {
  const api = dashboardApi({
    baseUrl: "http://dash",
    fetchImpl: async () => ({ ok: false, status: 409, text: async () => JSON.stringify({ error: "A worker job is already running" }) }),
  });
  await assert.rejects(() => api.vaultAction("work", "sync"), /409: A worker job is already running/);
});
