// In-process feature switches of the merged single-process app. The app
// entry owns one FeatureManager; the dashboard API and the CLI (through the
// loopback dashboard) drive it. Toggling a feature never restarts the
// service: listeners are opened and closed inside the running process.
//
//  - server: the AnythingLLM front door (public plane on 21500, token
//    gated) plus its admin surface mounted on the dashboard. Default off;
//    enabling requires a verified AnythingLLM developer key in
//    gateway/gateway.json (seeded from config.json when it holds one).
//    The on-disk role token is "server"; the "gateway" spelling is a
//    legacy alias normalized away at load.
//  - scheduler: the vault sync loop, pausable without touching the rest.
import path from "node:path";

import { isContainer } from "./deployment.mjs";
import { configPaths, createAppConfigStore, defaultConfigRoot } from "./app-config.mjs";
import { createInstallationStore } from "./installation.mjs";
import { fetchWithTimeout } from "./http.mjs";
import { createGatewayConfig } from "../server/gateway-config.mjs";
import { createGatewayRequestHandler, createGatewayRuntime, DEFAULT_GATEWAY_PORT } from "../server/gateway.mjs";
import { createMcpHttpListener } from "../mcp/index.mjs";
import { runWorker } from "../scripts/worker.mjs";
import { createServer } from "node:http";

export function createFeatureManager({
  env = process.env,
  fetchImpl = fetch,
  root = defaultConfigRoot({ env }),
  installation = createInstallationStore(root),
  log = console.error,
} = {}) {
  const paths = configPaths(root);
  const appLogPath = path.join(paths.logsRoot, "app.log");
  const configStore = createAppConfigStore({ rootDir: root });
  const gatewayConfig = createGatewayConfig({ dataDir: path.join(root, "gateway") });
  let gateway = { runtime: null, server: null, adminHandler: null };
  let scheduler = { abort: null, done: null };

  return {
    gatewayAdminHandler: () => gateway.adminHandler,
    gatewayRunning: () => Boolean(gateway.server),
    schedulerRunning: () => Boolean(scheduler.abort),

    async gatewayState() {
      const [profile, state] = await Promise.all([installation.load(), gatewayConfig.load()]);
      const port = Number(state.port ?? DEFAULT_GATEWAY_PORT);
      return {
        available: !isContainer(env),
        enabled: profile.roles.includes("server"),
        running: Boolean(gateway.server),
        configured: Boolean(state.apiKey && state.anythingllmBaseUrl),
        port,
        anythingllmBaseUrl: state.anythingllmBaseUrl,
      };
    },

    async enableGateway(input = {}) {
      const state = await gatewayConfig.load();
      if (!state.anythingllmBaseUrl || !state.apiKey || input.apiKey) {
        const seeded = await seedGatewayConfig(input);
        if (!seeded.ok) return { ok: false, needsDevKey: true, reason: seeded.reason };
      }
      await this.startGateway();
      await installation.addRole("server");
      return { ok: true, ...(await this.gatewayState()) };
    },

    async disableGateway() {
      await installation.removeRole("server");
      const current = gateway;
      gateway = { runtime: null, server: null, adminHandler: null };
      if (!current.server) return { ok: true, ...(await this.gatewayState()) };
      await new Promise((resolve) => {
        current.server.closeAllConnections();
        current.server.close(resolve);
      });
      await current.runtime.close();
      log("[any-obs-server] public plane stopped");
      return { ok: true, ...(await this.gatewayState()) };
    },

    async startGateway() {
      if (gateway.server) return;
      const state = await gatewayConfig.load();
      if (!state.anythingllmBaseUrl)
        throw new Error("Gateway is not configured; an AnythingLLM URL and developer key are required");
      assertNoPortCollisions(env, state);
      const runtime = await createGatewayRuntime({
        env,
        dataDir: path.join(root, "gateway"),
        logPath: appLogPath,
      });
      const shared = { ...runtime.shared, env, fetchImpl };
      const server = createServer(createGatewayRequestHandler({ plane: "public", ...shared }));
      const adminHandler = createGatewayRequestHandler({ plane: "admin", ...shared });
      await runtime.ready();
      const port = Number(state.port ?? DEFAULT_GATEWAY_PORT);
      const bind = state.bind ?? "0.0.0.0";
      await new Promise((resolve, reject) =>
        server.listen(port, bind, (error) => (error ? reject(error) : resolve())),
      );
      gateway = { runtime, server, adminHandler };
      runtime.startTimer();
      log(`[any-obs-server] public plane on ${bind}:${port} (user token required)`);
    },

    startScheduler() {
      if (scheduler.abort) return;
      const abort = new AbortController();
      const done = runWorker(["scheduler"], env, { signal: abort.signal })
        .catch((error) => log(`[any-obs-scheduler] stopped: ${error?.message ?? error}`))
        .finally(() => {
          if (scheduler.abort === abort) scheduler = { abort: null, done: null };
        });
      scheduler = { abort, done };
    },

    async stopScheduler() {
      scheduler.abort?.abort(new Error("Service stopped"));
      await scheduler.done?.catch(() => {});
    },

    async close() {
      await this.stopScheduler();
      const current = gateway;
      gateway = { runtime: null, server: null, adminHandler: null };
      if (current.server) {
        await new Promise((resolve) => {
          current.server.closeAllConnections();
          current.server.close(resolve);
        });
        await current.runtime.close();
      }
    },
  };

  // Fill gateway.json for a first enable. Priority: an explicit key from the
  // dashboard dialog, else the client config's own credentials — but only if
  // they point at real AnythingLLM (a client set up through a remote gateway
  // holds a user token, never a developer key).
  async function seedGatewayConfig(input) {
    const candidateKey = String(input.apiKey ?? "").trim();
    if (candidateKey) {
      const state = await gatewayConfig.load();
      const baseUrl = String(input.baseUrl ?? "").trim() || state.anythingllmBaseUrl;
      if (!baseUrl) return { ok: false, reason: "An AnythingLLM URL is required" };
      const verdict = await probeWorkspaces(baseUrl, candidateKey);
      if (!verdict.ok) return { ok: false, reason: verdict.reason };
      await gatewayConfig.save({ anythingllmBaseUrl: baseUrl, apiKey: candidateKey });
      return { ok: true };
    }
    const config = await configStore.load();
    if (!config) return { ok: false, reason: "Run anything-obsidian setup first" };
    if (await pointsAtGateway(config.anythingllmBaseUrl))
      return {
        ok: false,
        reason:
          "This install connects through a gateway; enter the AnythingLLM URL and its developer API key",
      };
    const verdict = await probeWorkspaces(config.anythingllmBaseUrl, config.apiKey);
    if (!verdict.ok) return { ok: false, reason: verdict.reason };
    await gatewayConfig.save({
      anythingllmBaseUrl: config.anythingllmBaseUrl,
      apiKey: config.apiKey,
    });
    return { ok: true };
  }

  // The gateway answers /api/gateway/health with its own name — the
  // discriminator between "credentials are a real developer key" and "this
  // client talks to a gateway with a user token".
  async function pointsAtGateway(baseUrl) {
    try {
      const probe = await fetchWithTimeout(fetchImpl, `${baseUrl}/api/gateway/health`, {}, 3000);
      return probe.ok && (await probe.json())?.name === "any-obs-gateway";
    } catch {
      return false;
    }
  }

  async function probeWorkspaces(baseUrl, apiKey) {
    try {
      const probe = await fetchWithTimeout(
        fetchImpl,
        `${baseUrl}/api/v1/workspaces`,
        { headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` } },
        5000,
      );
      if (probe.ok && Array.isArray((await probe.json()).workspaces)) return { ok: true };
      return { ok: false, reason: `AnythingLLM rejected this API key (HTTP ${probe.status})` };
    } catch (error) {
      return {
        ok: false,
        reason: `Could not reach ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

function assertNoPortCollisions(env, gatewayState) {
  const gatewayPort = Number(gatewayState.port ?? DEFAULT_GATEWAY_PORT);
  const taken = {
    dashboard: Number(env.DASHBOARD_PORT || 21502),
    mcp: Number(env.MCP_PORT || 21503),
  };
  for (const [name, port] of Object.entries(taken))
    if (port === gatewayPort)
      throw new Error(`Gateway port ${gatewayPort} collides with the ${name} port`);
}
