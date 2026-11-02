import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fetchWithTimeout } from "./http.mjs";
import { createAppConfigStore } from "./app-config.mjs";
import { createFeatureManager } from "./features.mjs";
import { createGatewayConfig } from "../server/gateway-config.mjs";
import { createInstallationStore } from "./installation.mjs";

// Ports high above the real service range so tests never collide with a
// running installation; each test takes its own to stay parallel-safe.
let portCursor = 24310;
const nextPort = () => ++portCursor;
const testVaultsRoot = path.join(tmpdir(), "any-obs-features-vaults");
const testConfig = () => ({
  vaultsRoot: testVaultsRoot,
  anythingllmBaseUrl: "http://anythingllm.test",
  apiKey: "dev-key",
});

const workspacesOk = async (url, init) => {
  if (String(url).endsWith("/api/v1/workspaces"))
    return new Response(JSON.stringify({ workspaces: [] }), {
      status: init?.headers?.Authorization ? 200 : 401,
      headers: { "content-type": "application/json" },
    });
  return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
};

async function fixture(t, { config = testConfig(), env = {}, fetchImpl } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "any-obs-features-"));
  let features;
  t.after(async () => {
    await features?.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const store = createAppConfigStore({ rootDir: root });
  await store.save(config);
  const mergedEnv = {
    HOME: root,
    PATH: process.env.PATH,
    ANYTHING_OBSIDIAN_HOME: root,
    // Hard-isolate the scheduler loop: an unset registry path would fall
    // back to the real installation's registry and sync real vaults.
    VAULTS_ROOT: path.join(root, "vaults"),
    VAULT_REGISTRY_PATH: path.join(root, "registry", "vaults.json"),
    VAULT_STATE_ROOT: path.join(root, "state"),
    DASHBOARD_PORT: String(nextPort()),
    MCP_PORT: String(nextPort()),
    MCP_LAN_PORT: String(nextPort()),
    ...env,
  };
  features = createFeatureManager({ env: mergedEnv, root, ...(fetchImpl ? { fetchImpl } : {}) });
  return {
    root,
    store,
    features,
    env: mergedEnv,
    installation: createInstallationStore(root),
    gatewayConfig: createGatewayConfig({ dataDir: path.join(root, "gateway") }),
  };
}

test("enableGateway seeds gateway.json from a solo client config and starts the public plane", async (t) => {
  const port = nextPort();
  const f = await fixture(t);
  await f.gatewayConfig.save({ port });
  let credential = null;
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith("/api/v1/workspaces")) credential = init?.headers?.Authorization;
    return workspacesOk(url, init);
  };
  const seeded = createFeatureManager({ env: f.env, root: f.root, fetchImpl });

  const result = await seeded.enableGateway();
  assert.equal(result.ok, true);
  assert.equal(result.enabled, true);
  assert.equal(result.running, true);
  assert.equal(credential, "Bearer dev-key");
  const stored = await f.gatewayConfig.load();
  assert.equal(stored.apiKey, "dev-key");
  assert.equal(stored.anythingllmBaseUrl, "http://anythingllm.test");

  const probe = await fetchWithTimeout(fetch, `http://127.0.0.1:${port}/health`, {}, 3000);
  assert.equal(probe.status, 200);
  assert.equal((await probe.json()).name, "any-obs-gateway");

  const state = await seeded.gatewayState();
  assert.equal(state.configured, true);
  assert.equal(state.port, port);

  await seeded.disableGateway();
  assert.equal((await seeded.gatewayState()).running, false);
  await assert.rejects(fetchWithTimeout(fetch, `http://127.0.0.1:${port}/health`, {}, 1500));
  assert.deepEqual((await f.installation.load()).roles, []);
});

test("a client pointing at a gateway is asked for the real developer key", async (t) => {
  const f = await fixture(t, {
    config: { ...testConfig(), anythingllmBaseUrl: "http://remote-gateway.test", apiKey: "user-token" },
  });
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/api/gateway/health"))
      return new Response(JSON.stringify({ name: "any-obs-gateway" }), { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  };
  const seeded = createFeatureManager({ env: f.env, root: f.root, fetchImpl });
  const result = await seeded.enableGateway();
  assert.equal(result.ok, false);
  assert.equal(result.needsDevKey, true);
  assert.match(result.reason, /connects through a gateway/);
  assert.equal((await f.gatewayConfig.load()).apiKey, "");
});

test("an explicit key from the dialog is verified before it is stored", async (t) => {
  const f = await fixture(t);
  await f.gatewayConfig.save({ port: nextPort() });
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith("/api/v1/workspaces")) {
      if (init?.headers?.Authorization === "Bearer good-key")
        return new Response(JSON.stringify({ workspaces: [] }), { status: 200 });
      return new Response("{}", { status: 401 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const seeded = createFeatureManager({ env: f.env, root: f.root, fetchImpl });

  const rejected = await seeded.enableGateway({
    baseUrl: "http://anythingllm.test",
    apiKey: "bad-key",
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /rejected this API key/);
  assert.equal((await f.gatewayConfig.load()).apiKey, "");

  const accepted = await seeded.enableGateway({
    baseUrl: "http://anythingllm.test",
    apiKey: "good-key",
  });
  assert.equal(accepted.ok, true);
  assert.equal((await f.gatewayConfig.load()).apiKey, "good-key");
  await seeded.disableGateway();
});

test("startGateway refuses ports that collide with the app's own listeners", async (t) => {
  const f = await fixture(t, { env: { DASHBOARD_PORT: "21500" }, fetchImpl: workspacesOk });
  await assert.rejects(f.features.enableGateway(), /collides with the dashboard port/);
  assert.deepEqual((await f.installation.load()).roles, []);
});

test("the scheduler loop starts and stops without touching the service supervisor", async (t) => {
  const f = await fixture(t);
  f.features.startScheduler();
  assert.equal(f.features.schedulerRunning(), true);
  await f.features.stopScheduler();
  assert.equal(f.features.schedulerRunning(), false);
});
