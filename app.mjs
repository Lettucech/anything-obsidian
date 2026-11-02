#!/usr/bin/env node
// The whole installation in one process: dashboard (21502), local MCP
// (21503), the vault-sync scheduler loop, plus the opt-in LAN MCP (21504)
// and gateway (21500) listeners. `anything-obsidian run app` is the only
// supervised service; feature toggles open and close listeners inside this
// process without restarting it.
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

import { createDashboardServer } from "./dashboard/server.mjs";
import { createMcpHttpListener } from "./mcp/index.mjs";
import { createFeatureManager } from "./lib/features.mjs";
import { createInstallationStore } from "./lib/installation.mjs";
import {
  createAppConfigStore,
  defaultConfigRoot,
  nativeEnv,
} from "./lib/app-config.mjs";
import { isContainer } from "./lib/deployment.mjs";
import { rotateLogs } from "./lib/log-rotate.mjs";

export async function startApp({ env = process.env, root = defaultConfigRoot({ env }) } = {}) {
  const store = createAppConfigStore({ rootDir: root });
  const config = await store.load();
  if (!config) throw new Error("This installation is not configured. Run: anything-obsidian setup");
  const paths = store.paths;
  const installation = createInstallationStore(root);
  const profile = await installation.load();

  // One service env, exactly what the per-role child processes used to
  // receive. MCP request handling and the scheduler read it at call time, so
  // production must pass process.env.
  Object.assign(env, {
    ...nativeEnv(config, paths, { env }),
    MCP_TRANSPORT: "http",
    MCP_PROFILE: "local",
    ...(config.lanToken ? { MCP_AUTH_TOKEN: config.lanToken } : {}),
  });

  const features = createFeatureManager({ env, root, installation });
  const appLogPath = `${paths.logsRoot}/app.log`;
  await rotateLogs({ logsRoot: paths.logsRoot }).catch(() => {});

  const mcpServer = await createMcpHttpListener({ profile: "local", env });

  const dashboard = createDashboardServer({
    env,
    features,
    native: {
      schedulerPidPath: paths.schedulerPidPath,
      // One process, one log: the dashboard's log view tails the app log.
      schedulerLogPath: appLogPath,
      jobStorePath: paths.jobStorePath,
      lastSyncPath: env.AO_LAST_SYNC_PATH,
    },
  });
  const dashboardPort = Number(env.DASHBOARD_PORT || 21502);
  await new Promise((resolve, reject) =>
    dashboard.listen(
      dashboardPort,
      isContainer(env) ? "0.0.0.0" : "127.0.0.1",
      (error) => (error ? reject(error) : resolve()),
    ),
  );

  // Saved preferences become live listeners; a failure to start an optional
  // one must not take the app down.
  if (profile.lan && config.lanToken)
    await features.startLan(config.lanToken).catch((error) =>
      console.error(`[any-obs-lan] could not start: ${error?.message ?? error}`),
    );
  if (profile.roles.includes("gateway"))
    await features.startGateway().catch((error) =>
      console.error(`[any-obs-gateway] could not start: ${error?.message ?? error}`),
    );
  features.startScheduler();

  const close = async () => {
    await features.close();
    await new Promise((resolve) => {
      mcpServer.closeAllConnections();
      mcpServer.close(resolve);
    });
    await dashboard.shutdown();
  };
  return { dashboard, mcpServer, features, close };
}

if (process.argv[1] && import.meta.url === entryUrl()) {
  process.title = "anything-obsidian-app";
  let stopping = false;
  const app = await startApp({ env: process.env });
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  console.error(
    `[anything-obsidian-app] dashboard on 127.0.0.1:${process.env.DASHBOARD_PORT || 21502}, local MCP on 127.0.0.1:${process.env.MCP_PORT || 21503}`,
  );
}

function entryUrl() {
  if (!process.argv[1]) return "";
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return pathToFileURL(path.resolve(process.argv[1])).href;
  }
}
