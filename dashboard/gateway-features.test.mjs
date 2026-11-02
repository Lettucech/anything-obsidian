import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";

import { createDashboardServer } from "./server.mjs";
import { fakeServices } from "./test-services.mjs";

// Isolated data root so /api/lan and friends never touch a real install.
async function isolatedRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), "any-obs-gw-dash-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "registry"), { recursive: true });
  await writeFile(
    path.join(root, "config.json"),
    JSON.stringify({
      vaultsRoot: path.join(root, "vaults"),
      anythingllmBaseUrl: "http://localhost:11301",
      apiKey: "key",
      lanToken: "lan-secret",
    }),
  );
  return root;
}

function fakeFeatures(overrides = {}) {
  const calls = [];
  return {
    calls,
    gatewayAdminHandler: overrides.gatewayAdminHandler ?? (() => null),
    gatewayState:
      overrides.gatewayState ??
      (async () => ({ available: true, enabled: false, running: false, configured: false, port: 21500 })),
    enableGateway:
      overrides.enableGateway ??
      (async (input) => {
        calls.push(["enable", input]);
        return { ok: true, enabled: true, running: true, port: 21500 };
      }),
    disableGateway: async () => {
      calls.push(["disable"]);
      return { ok: true, enabled: false, running: false };
    },
    startScheduler: () => calls.push(["scheduler-on"]),
    stopScheduler: async () => calls.push(["scheduler-off"]),
    startLan: async () => calls.push(["lan-on"]),
    stopLan: async () => calls.push(["lan-off"]),
  };
}

function nativeApp(features, root) {
  return createDashboardServer({
    env: {
      ANYTHING_OBSIDIAN_HOME: root,
      ANYTHINGLLM_BASE_URL: "http://localhost:11301",
      ANYTHINGLLM_API_KEY: "key",
      DASHBOARD_PORT: "21502",
      VAULTS_ROOT: path.join(root, "vaults"),
      VAULT_REGISTRY_PATH: path.join(root, "registry", "vaults.json"),
      VAULT_SECRETS_PATH: path.join(root, "secrets"),
      AGENT_TOKENS_PATH: path.join(root, "agent-tokens"),
    },
    native: {
      schedulerPidPath: "/nonexistent.pid",
      schedulerLogPath: "/nonexistent.log",
    },
    features,
    services: fakeServices(),
    anythingllm: {
      async listWorkspaces() {
        return [];
      },
    },
  });
}

async function request(server, method, path, body) {
  return await new Promise((resolve) => {
    const chunks = [];
    const req = new Readable({
      read() {
        if (body !== undefined) this.push(JSON.stringify(body));
        this.push(null);
      },
    });
    req.headers = { "content-type": "application/json", host: "localhost" };
    req.method = method;
    req.url = path;

    const res = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    res.writeHead = (status, headers) => {
      res.statusCode = status;
      res.headers = headers;
      return res;
    };
    res.end = (chunk) => {
      if (chunk) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString("utf8");
      let body;
      try {
        body = JSON.parse(text || "{}");
      } catch {
        body = undefined; // HTML/JS responses stay in `text`
      }
      resolve({ status: res.statusCode, headers: res.headers, text, body });
      return res;
    };

    server.emit("request", req, res);
  });
}

test("feature endpoints toggle the gateway through the injected manager", async (t) => {
  const features = fakeFeatures();
  const app = nativeApp(features, await isolatedRoot(t));

  const state = await request(app, "GET", "/api/features/gateway");
  assert.equal(state.status, 200);
  assert.equal(state.body.available, true);

  const on = await request(app, "POST", "/api/features/gateway", { action: "on" });
  assert.equal(on.status, 200);
  assert.equal(on.body.enabled, true);
  assert.deepEqual(features.calls.at(-1), ["enable", {}]);

  const seeded = await request(app, "POST", "/api/features/gateway", {
    action: "on",
    apiKey: "dev-key",
    baseUrl: "http://anythingllm.test",
  });
  assert.equal(seeded.status, 200);
  assert.deepEqual(features.calls.at(-1), ["enable", { apiKey: "dev-key", baseUrl: "http://anythingllm.test" }]);

  const off = await request(app, "POST", "/api/features/gateway", { action: "off" });
  assert.equal(off.status, 200);
  assert.equal(off.body.enabled, false);
  app.shutdown();
});

test("a needsDevKey answer surfaces as 400 with the reason", async (t) => {
  const features = fakeFeatures({
    enableGateway: async () => ({ ok: false, needsDevKey: true, reason: "Enter the developer key" }),
  });
  const app = nativeApp(features, await isolatedRoot(t));
  const response = await request(app, "POST", "/api/features/gateway", { action: "on" });
  assert.equal(response.status, 400);
  assert.equal(response.body.needsDevKey, true);
  assert.equal(response.body.error, "Enter the developer key");
  app.shutdown();
});

test("mounted gateway API delegates to the running gateway and 503s when it is off", async (t) => {
  let seen = null;
  const features = fakeFeatures({
    gatewayAdminHandler: () => async (req, res) => {
      seen = { url: req.url };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ users: [] }));
    },
  });
  const app = nativeApp(features, await isolatedRoot(t));
  const forwarded = await request(app, "GET", "/api/gateway/users");
  assert.equal(forwarded.status, 200);
  assert.deepEqual(forwarded.body, { users: [] });
  assert.equal(seen.url, "/api/gateway/users");

  const stopped = nativeApp(fakeFeatures({ gatewayAdminHandler: () => null }), await isolatedRoot(t));
  const unavailable = await request(stopped, "GET", "/api/gateway/users");
  assert.equal(unavailable.status, 503);
  app.shutdown();
  stopped.shutdown();
});

test("the gateway console is served at /gateway/ with redirect and traversal guards", async (t) => {
  const app = nativeApp(fakeFeatures(), await isolatedRoot(t));

  const redirect = await request(app, "GET", "/gateway");
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.location, "/gateway/");

  const shell = await request(app, "GET", "/gateway/");
  assert.equal(shell.status, 200);
  assert.match(shell.text, /any-obs gateway/);

  const asset = await request(app, "GET", "/gateway/app.js");
  assert.equal(asset.status, 200);

  const missing = await request(app, "GET", "/gateway/nope.js");
  assert.equal(missing.status, 404);

  // Dot segments are normalized away by the URL parser (plain traversal
  // never reaches the console root); encoded ones hit the path guard.
  const normalized = await request(app, "GET", "/gateway/../server.mjs");
  assert.equal(normalized.status, 404);
  const encoded = await request(app, "GET", "/gateway/%2e%2e/server.mjs");
  assert.ok([403, 404].includes(encoded.status));

  const post = await request(app, "POST", "/gateway/", {});
  assert.equal(post.status, 404);
  app.shutdown();
});

test("lan toggles drive the in-process listener instead of a supervisor service", async (t) => {
  const features = fakeFeatures();
  const app = nativeApp(features, await isolatedRoot(t));
  const response = await request(app, "POST", "/api/lan", { action: "on" });
  assert.equal(response.status, 200);
  assert.deepEqual(features.calls.at(-1), ["lan-on"]);
  const off = await request(app, "POST", "/api/lan", { action: "off" });
  assert.equal(off.status, 200);
  assert.deepEqual(features.calls.at(-1), ["lan-off"]);
  app.shutdown();
});
