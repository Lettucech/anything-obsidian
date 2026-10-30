#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { createReadStream, realpathSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Writable } from "node:stream";
import { parseArgs, promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import {
  createAppConfigStore,
  defaultConfigRoot,
  expandTilde,
  nativeEnv,
} from "../lib/app-config.mjs";
import { createInstallationStore } from "../lib/installation.mjs";
import { createServiceController, installedServices, SERVICE_NAMES } from "../lib/services.mjs";
import { createGatewayConfig } from "../server/gateway-config.mjs";
import { fetchWithTimeout } from "../lib/http.mjs";
import { redactSecretsText } from "../dashboard/redact.mjs";
import { tailLogFile } from "../dashboard/local-jobs.mjs";
import { rotateLogs } from "../lib/log-rotate.mjs";
import { withFileLock } from "../lib/state.mjs";
import { updateApplication } from "../lib/updater.mjs";
import { isContainer } from "../lib/deployment.mjs";
import { adminHeaders, ensureContainerToken } from "../lib/container-admin.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const exec = promisify(execFile);
export const REQUIRED_NODE_MAJOR = 22;
export const MANAGED_VAULTS_ROOT = "~/.anything-obsidian/vaults";
const USAGE = `Usage: anything-obsidian <command>

  setup       Connect and configure this machine; start its services
  start       Start all configured services in the background (idempotent)
  stop        Stop all configured services; preserve autostart preference
  restart     Restart all configured services and verify readiness
  status      Show configuration, readiness and startup guarantee (--json)
  logs        Show logs: [dashboard|scheduler|mcp|mcp-lan|gateway] [-f|--follow]
  autostart   on | off | status (changing this does not stop running services)
  lan         on | off | token <value> | status
  update      Stage, verify and activate an update; roll back failed activation
  run         <service> in the foreground for diagnostics

Setup defaults to a client. Use setup --server for a gateway; both can coexist.
  --url <url>          Gateway URL (client) or AnythingLLM URL (server)
  --api-key <value>    User token (client) or AnythingLLM developer key (server)
  --vaults-root <path> Client vault root
  --port <number>     Client dashboard port or server public port
  --admin-port <port> Server admin port (loopback only)
LAN: lan on --allowed-hosts <comma-separated hostnames or IPs>

Setup enables autostart by default. macOS starts after login; Linux gateways
require loginctl enable-linger for operation at boot without a login.
`;

export function nodeVersionProblem(version = process.versions.node) {
  const major = Number.parseInt(String(version).split(".")[0], 10);
  return major >= REQUIRED_NODE_MAJOR
    ? null
    : `Anything Obsidian needs Node.js >= ${REQUIRED_NODE_MAJOR} (found ${version}). Re-run install.sh to install a managed runtime.`;
}

export async function runCli(argv = process.argv.slice(2), deps = {}) {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((text) => process.stdout.write(`${text}\n`));
  const [command = "help", ...args] = argv;
  if (["help", "--help", "-h"].includes(command)) {
    log(USAGE);
    return 0;
  }
  const problem = nodeVersionProblem(deps.nodeVersion);
  if (problem) {
    log(problem);
    return 1;
  }
  const root = deps.store?.paths.root ?? defaultConfigRoot({ env, platform: deps.platform });
  const store = deps.store ?? createAppConfigStore({ rootDir: root });
  const installation = deps.installation ?? createInstallationStore(root);
  const gateway = createGatewayConfig({ dataDir: path.join(root, "gateway") });
  let services;
  const controller = () =>
    (services ??=
      deps.services ??
      createServiceController({
        root,
        env,
        platform: deps.platform,
        ...(deps.launchctl ? { launchctl: deps.launchctl } : {}),
        ...(deps.systemctl ? { systemctl: deps.systemctl } : {}),
        ...(deps.loginctl ? { loginctl: deps.loginctl } : {}),
        installation,
      }));
  const fetchImpl = deps.fetchImpl ?? fetch;
  const options =
    command === "setup"
      ? {
          server: { type: "boolean" },
          url: { type: "string" },
          "api-key": { type: "string" },
          "vaults-root": { type: "string" },
          port: { type: "string" },
          "admin-port": { type: "string" },
        }
      : command === "logs"
        ? { follow: { type: "boolean", short: "f" }, lines: { type: "string" } }
        : command === "lan"
          ? { json: { type: "boolean" }, "allowed-hosts": { type: "string" } }
          : ["status", "autostart"].includes(command)
            ? { json: { type: "boolean" } }
            : {};
  let machineReadable = false;
  try {
    const { values: flags, positionals } = parseArgs({
      args,
      options: { ...options, help: { type: "boolean", short: "h" } },
      allowPositionals: true,
      strict: true,
    });
    machineReadable = flags.json === true;
    if (flags.help) {
      log(USAGE);
      return 0;
    }
    const context = { root, env, store, installation, gateway, controller, fetchImpl, log, deps };
    if (
      isContainer(env) &&
      ["start", "stop", "restart", "autostart", "lan", "update"].includes(command)
    )
      throw new Error(
        "Docker manages lifecycle and startup. Use docker compose up -d, stop, restart, or logs; rebuild the image to update.",
      );
    if (!["run", "logs", "autostart", "lan"].includes(command) && positionals.length)
      throw new Error(`Unexpected argument: ${positionals[0]}`);
    switch (command) {
      case "setup": {
        if (isContainer(env)) {
          const running = await controller()
            .status()
            .catch(() => null);
          if (running)
            throw new Error(
              "Stop this service with docker compose stop before changing its configuration.",
            );
        }
        const configured = await setup(context, flags);
        if (isContainer(env)) {
          await ensureContainerToken(root);
          log("Docker configuration saved. Start with docker compose up -d client (or gateway).");
          return 0;
        }
        if (configured.reconfigure) await controller().restartRole(configured.role);
        return await start(context, false);
      }
      case "start":
        return await start(context, false);
      case "restart":
        return await start(context, true);
      case "stop":
        await controller().stop();
        log("Services stopped. Autostart preference is unchanged.");
        return 0;
      case "status":
        return await emitStatus(context, flags.json);
      case "autostart": {
        if (positionals.length > 1 || !["on", "off", "status"].includes(positionals[0] ?? "status"))
          throw new Error("Usage: anything-obsidian autostart on|off|status");
        if (positionals[0] !== "status" && positionals.length)
          await controller().setAutostart(positionals[0] === "on");
        const state = (await controller().status()).autostart;
        log(
          flags.json
            ? JSON.stringify(state)
            : `Autostart: ${state.enabled ? "on" : "off"} (${state.guarantee}). Running services are unchanged.`,
        );
        return 0;
      }
      case "lan": {
        const [action = "status", token] = positionals;
        if (
          !["on", "off", "token", "status"].includes(action) ||
          positionals.length > (action === "token" ? 2 : 1)
        )
          throw new Error("Usage: anything-obsidian lan on|off|token <value>|status");
        let config = await requireClient(store);
        if (flags["allowed-hosts"] !== undefined) {
          if (action !== "on") throw new Error("--allowed-hosts is only valid with lan on");
          const hosts = flags["allowed-hosts"].split(",").map((host) => host.trim());
          if (hosts.some((host) => !/^[a-z0-9.:[\]-]+$/i.test(host)))
            throw new Error("Allowed hosts must be hostnames or IP addresses");
          config = await store.save({ ...config, mcpAllowedHosts: hosts.join(",") });
        }
        if (action === "token" || (action === "on" && !config.lanToken)) {
          const value = token || (await import("node:crypto")).randomBytes(32).toString("hex");
          if (action === "token" && !token) throw new Error("A token value is required");
          await store.save({ ...config, lanToken: value });
          if (action === "on") {
            if (!flags.json) log(`Save this LAN token now: ${value}`);
            context.lanToken = value;
          }
        }
        if (action === "on" || action === "off") await controller().setLan(action === "on");
        if (action === "token" && (await installation.load()).lan) {
          await controller().stopService("mcp-lan");
          await controller().startService("mcp-lan");
        }
        const profile = await installation.load();
        log(
          flags.json
            ? JSON.stringify({
                enabled: profile.lan,
                ...(context.lanToken ? { token: context.lanToken } : {}),
              })
            : `LAN MCP: ${profile.lan ? "on" : "off"}`,
        );
        return 0;
      }
      case "logs":
        if (positionals.length > 1)
          throw new Error("Usage: anything-obsidian logs [service] [--follow]");
        return await logs(context, positionals[0], flags);
      case "run":
        if (positionals.length !== 1) throw new Error("Usage: anything-obsidian run <service>");
        return await runForeground(context, positionals[0]);
      case "update":
        await (deps.updateApplication ?? updateApplication)({
          appRoot:
            env.ANYTHING_OBSIDIAN_APP_HOME ||
            path.join(env.HOME || os.homedir(), ".anything-obsidian"),
          root,
          controller: controller(),
          verify: async () => {
            const report = await waitReady(context);
            return { ...report, ok: report.ready };
          },
          log,
          env,
        });
        return 0;
      default:
        log(USAGE);
        return 2;
    }
  } catch (error) {
    const secrets = [
      (await store.load().catch(() => null))?.apiKey,
      (await gateway.load().catch(() => null))?.apiKey,
    ].filter(Boolean);
    let message = redactSecretsText(error.message);
    for (const secret of secrets) message = message.split(secret).join("[redacted]");
    log(
      machineReadable
        ? JSON.stringify({ ok: false, error: message, configRoot: root })
        : `Error: ${message}`,
    );
    return error.code?.startsWith("ERR_PARSE_ARGS") ? 2 : 1;
  }
}

async function setup(ctx, flags) {
  const { store, gateway, installation, env, fetchImpl, log, deps } = ctx;
  const server = flags.server === true;
  if (isContainer(env)) {
    if ((env.AO_CONTAINER_ROLE === "gateway") !== server)
      throw new Error("Setup role must match this Docker service");
    if (flags.port || flags["admin-port"])
      throw new Error(
        "Docker uses fixed internal ports. Change host port mappings in Compose instead.",
      );
    if (flags["vaults-root"] && flags["vaults-root"] !== path.join(ctx.root, "vaults"))
      throw new Error("Docker vaults live in the data volume; custom vault roots are unavailable.");
    if (!server) flags["vaults-root"] = path.join(ctx.root, "vaults");
  }
  if (server && flags["vaults-root"]) throw new Error("--vaults-root is only valid for a client");
  const previous = server ? await gateway.load() : await store.load();
  const prompt =
    flags.url && flags["api-key"] && (server || flags["vaults-root"] || previous?.vaultsRoot)
      ? null
      : (deps.promptFactory ?? createPrompt)(
          deps.io ?? { input: process.stdin, output: process.stdout },
        );
  try {
    await (deps.execFileImpl ?? exec)("git", ["--version"]);
    if (
      prompt &&
      previous?.apiKey &&
      !(await prompt.confirm(
        `Replace this ${server ? "gateway" : "client"} configuration? [y/N] `,
        false,
      ))
    )
      throw new Error("Setup cancelled; existing configuration was kept");
    const defaultUrl =
      previous?.anythingllmBaseUrl ||
      (server ? "http://localhost:21501" : "http://localhost:21500");
    const anythingllmBaseUrl =
      flags.url ||
      (await prompt.question(
        `${server ? "AnythingLLM" : "Gateway"} URL [${defaultUrl}] `,
        defaultUrl,
      ));
    const parsed = new URL(anythingllmBaseUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("URL must use HTTP(S)");
    const apiKey =
      flags["api-key"] ||
      (await (prompt.secret ?? prompt.question)(
        server ? "AnythingLLM developer API key: " : "User token from your administrator: ",
        previous?.apiKey || "",
      ));
    if (!apiKey) throw new Error("An API key or user token is required");
    const probe = await fetchWithTimeout(
      fetchImpl,
      `${anythingllmBaseUrl.replace(/\/+$/, "")}/api/v1/workspaces`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
      5000,
    );
    if (!probe.ok || !Array.isArray((await probe.json()).workspaces))
      throw new Error(
        `Could not connect: upstream rejected the URL or credential (HTTP ${probe.status})`,
      );
    if (server) {
      await gateway.save({
        anythingllmBaseUrl: anythingllmBaseUrl.replace(/\/+$/, ""),
        apiKey,
        port: Number(flags.port ?? previous?.port ?? 21500),
        adminPort: Number(flags["admin-port"] ?? previous?.adminPort ?? 21505),
      });
    } else {
      if (flags["admin-port"]) throw new Error("--admin-port is only valid for setup --server");
      let vaultsRoot;
      for (;;) {
        vaultsRoot = expandTilde(
          flags["vaults-root"] ||
            (prompt
              ? await prompt.question(
                  `Vault root [${previous?.vaultsRoot || MANAGED_VAULTS_ROOT}] `,
                  previous?.vaultsRoot || MANAGED_VAULTS_ROOT,
                )
              : previous.vaultsRoot),
          env.HOME || os.homedir(),
        );
        if (!path.isAbsolute(vaultsRoot)) throw new Error("Vault root must be absolute");
        const protectedPath = ["Documents", "Desktop"].some(
          (name) =>
            vaultsRoot === path.join(env.HOME || os.homedir(), name) ||
            vaultsRoot.startsWith(path.join(env.HOME || os.homedir(), name) + path.sep),
        );
        if (
          prompt &&
          !flags["vaults-root"] &&
          protectedPath &&
          !(await prompt.confirm(
            `This location causes macOS permission prompts. Use ${vaultsRoot}? [y/N] `,
            false,
          ))
        )
          continue;
        break;
      }
      const config = await store.save({
        vaultsRoot,
        anythingllmBaseUrl,
        apiKey,
        dashboardPort: Number(flags.port ?? previous?.dashboardPort ?? 21502),
        ...(previous
          ? { mcpAllowedHosts: previous.mcpAllowedHosts, notifications: previous.notifications }
          : {}),
        ...(previous?.lanToken
          ? { lanToken: previous.lanToken }
          : isContainer(env)
            ? { lanToken: (await import("node:crypto")).randomBytes(32).toString("base64url") }
            : {}),
      });
      await mkdir(config.vaultsRoot, { recursive: true });
    }
    await store.ensureLayout();
    await installation.addRole(server ? "gateway" : "client");
    log(
      `Configuration saved: ${server ? path.join(ctx.root, "gateway", "gateway.json") : store.paths.configPath}`,
    );
    return { role: server ? "gateway" : "client", reconfigure: Boolean(previous?.apiKey) };
  } finally {
    prompt?.close();
  }
}

async function start(ctx, restart) {
  await ctx.controller()[restart ? "restart" : "start"]();
  const report = await waitReady(ctx);
  printStatus(ctx.log, report);
  if (!report.ok)
    throw new Error(
      report.detail ||
        "Services did not become ready. Run: anything-obsidian logs; anything-obsidian status",
    );
  ctx.log("Services are ready.");
  return 0;
}

async function waitReady(ctx) {
  const timeout = ctx.deps.readinessTimeoutMs ?? 15_000;
  const started = Date.now();
  let report;
  do {
    report = await status(ctx);
    if (report.ok || report.startupBlocked || report.indexingDegraded) return report;
    if (Date.now() - started >= timeout) break;
    await (ctx.deps.sleep ?? delay)(200);
  } while (true);
  return report;
}

async function status(ctx) {
  const runtime = await ctx.controller().status();
  const profile = await ctx.installation.load();
  const required = installedServices(profile);
  const report = {
    ok: false,
    configRoot: ctx.root,
    ...runtime,
    services: { ...runtime.services },
    startupBlocked: false,
  };
  if (!required.length) {
    report.detail = "Not configured. Run: anything-obsidian setup";
    return report;
  }
  try {
    await (ctx.deps.execFileImpl ?? exec)("git", ["--version"]);
    report.git = true;
  } catch {
    report.git = false;
    report.detail = "Git is unavailable. Install Git and run start again.";
  }
  const endpoints = [];
  if (profile.roles.includes("client")) {
    const config = await requireClient(ctx.store);
    endpoints.push([
      "dashboard",
      `http://127.0.0.1:${config.dashboardPort}/ready`,
      "any-obs-dashboard",
    ]);
    endpoints.push(["mcp", "http://127.0.0.1:21503/health", "anything-obsidian-mcp"]);
    if (profile.lan)
      endpoints.push(["mcp-lan", "http://127.0.0.1:21504/health", "anything-obsidian-mcp"]);
    report.dashboardUrl = `http://localhost:${config.dashboardPort}`;
  }
  if (profile.roles.includes("gateway")) {
    const config = await ctx.gateway.load();
    endpoints.push([
      "gateway",
      `http://127.0.0.1:${config.port ?? 21500}/ready`,
      "any-obs-gateway",
    ]);
    endpoints.push([
      "gateway-admin",
      `http://127.0.0.1:${config.adminPort ?? 21505}/ready`,
      "any-obs-gateway",
    ]);
    report.gatewayUrl = `http://localhost:${config.adminPort ?? 21505}`;
    if (runtime.autostart.enabled && runtime.autostart.linger === false) {
      report.startupBlocked = true;
      report.detail = `Gateway startup at boot is not configured. Run once: loginctl enable-linger ${ctx.env.USER || os.userInfo().username}`;
    }
  }
  await Promise.all(
    endpoints.map(async ([name, url, expectedName]) => {
      let healthy = false,
        detail;
      try {
        const response = await fetchWithTimeout(
          ctx.fetchImpl,
          url,
          { headers: await adminHeaders(ctx.env) },
          3000,
        );
        const body = await response.json();
        healthy =
          response.ok &&
          body.ok === true &&
          (!expectedName || body.name === expectedName) &&
          body.configRoot === ctx.root;
        if (!healthy) detail = `Readiness failed (HTTP ${response.status})`;
      } catch (error) {
        detail = error.message;
      }
      report.services[name] = {
        ...report.services[name],
        healthy,
        url,
        ...(detail ? { detail } : {}),
      };
    }),
  );
  if (runtime.autostart.enabled && runtime.autostart.registered === false) {
    report.startupBlocked = true;
    report.detail = "Autostart registration is incomplete. Run: anything-obsidian start";
  }
  report.ready =
    report.git &&
    !report.startupBlocked &&
    required.every((name) => report.services[name]?.running) &&
    endpoints.every(([name]) => report.services[name]?.healthy);
  report.indexing = {};
  const read = async (url) => {
    const response = await fetchWithTimeout(
      ctx.fetchImpl,
      url,
      { headers: await adminHeaders(ctx.env) },
      3000,
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };
  try {
    if (report.services["gateway-admin"]?.healthy) {
      const admin = report.gatewayUrl.replace("localhost", "127.0.0.1");
      const [{ jobs = [] }, { sources = [] }] = await Promise.all([
        read(`${admin}/api/gateway/jobs`),
        read(`${admin}/api/gateway/sources`),
      ]);
      report.indexing.gateway = sources.map((source) => {
        const job = jobs.find((job) => job.sourceId === source.id);
        return {
          source: source.id,
          state: source.cleanupPending
            ? "cleanup-pending"
            : job && ["queued", "running"].includes(job.status)
              ? job.status
              : source.lastError || ["failed", "cancelled"].includes(job?.status)
                ? "failed"
                : source.lastRefresh
                  ? "verified"
                  : "pending",
          lastVerified: source.lastRefresh,
          error: source.lastError || job?.error || null,
        };
      });
    }
    if (report.services.dashboard?.healthy) {
      const [{ jobs = [] }, { vaults = [] }] = await Promise.all([
        read(`${report.dashboardUrl}/api/status`),
        read(`${report.dashboardUrl}/api/vaults`),
      ]);
      report.indexing.client = vaults.map((vault) => {
        const job = [...jobs].reverse().find((job) => job.vaultId === vault.id);
        return {
          source: vault.id,
          state:
            job && ["queued", "running"].includes(job.status)
              ? job.status
              : vault.lastSync?.status === "failed" || job?.status === "failed"
                ? "failed"
                : "idle",
          error: vault.lastSync?.error || job?.error || null,
        };
      });
    }
  } catch (error) {
    report.indexing.error = `Cannot read indexing status: ${error.message}`;
  }
  report.indexingDegraded =
    Boolean(report.indexing.error) ||
    [...(report.indexing.gateway || []), ...(report.indexing.client || [])].some((item) =>
      ["failed", "cleanup-pending"].includes(item.state),
    );
  report.ok = report.ready && !report.indexingDegraded;
  if (report.indexingDegraded)
    report.detail =
      "Indexing needs attention. Open the dashboard to inspect and retry failed jobs or pending cleanup.";
  return report;
}

async function emitStatus(ctx, json) {
  const report = await status(ctx);
  if (json) ctx.log(JSON.stringify(report, null, 2));
  else printStatus(ctx.log, report);
  return report.ok ? 0 : 1;
}
function printStatus(log, report) {
  log(`Config: ${report.configRoot}`);
  log(`Roles: ${report.roles.join(", ") || "none"}`);
  if (report.git === false) log("  ✗ Git: unavailable");
  for (const [name, state] of Object.entries(report.services))
    log(
      `  ${state.running && state.healthy !== false ? "✓" : "✗"} ${name}: ${state.running ? (state.healthy === false ? "unhealthy" : "running") : "stopped"}${state.pid ? ` (pid ${state.pid})` : ""}`,
    );
  log(
    report.autostart.manager === "docker"
      ? "Startup: managed by Docker; inspect the container restart policy and host Docker startup."
      : `Autostart: ${report.autostart.enabled ? "on" : "off"} (${report.autostart.guarantee})`,
  );
  if (report.dashboardUrl) log(`Dashboard: ${report.dashboardUrl}`);
  if (report.gatewayUrl) log(`Gateway dashboard: ${report.gatewayUrl}`);
  for (const items of [report.indexing?.client || [], report.indexing?.gateway || []])
    for (const item of items)
      log(
        `Index ${item.source}: ${item.state}${item.error ? ` — ${redactSecretsText(item.error)}` : ""}`,
      );
  if (report.detail) log(report.detail);
}

async function requireClient(store) {
  const config = await store.load();
  if (!config) throw new Error("Client is not configured. Run: anything-obsidian setup");
  return config;
}

export function gatewayEnvironment(root, env = process.env) {
  // Credentials, bind addresses and ports come exclusively from gateway.json.
  return {
    HOME: env.HOME,
    PATH: env.PATH,
    ANYTHING_OBSIDIAN_HOME: root,
    AO_SUPERVISED: "1",
    ...(isContainer(env) ? { AO_CONTAINER: "1", AO_CONTAINER_ROLE: "gateway" } : {}),
  };
}
async function runForeground(ctx, role) {
  if (!SERVICE_NAMES.includes(role)) throw new Error(`Unknown service: ${role}`);
  return withFileLock(
    path.join(ctx.root, "run", `${role}.lock`),
    () => spawnForeground(ctx, role),
    { timeoutMs: 0 },
  );
}

async function spawnForeground(ctx, role) {
  if (!SERVICE_NAMES.includes(role)) throw new Error(`Unknown service: ${role}`);
  const profile = await ctx.installation.load();
  if (!installedServices(profile).includes(role))
    throw new Error(`Service is not configured: ${role}`);
  let script,
    args = [],
    childEnv;
  if (role === "gateway") {
    script = path.join(repoRoot, "server", "gateway.mjs");
    childEnv = gatewayEnvironment(ctx.root, ctx.env);
  } else {
    const config = await requireClient(ctx.store);
    childEnv = nativeEnv(config, ctx.store.paths, { env: ctx.env });
    if (role === "dashboard") script = path.join(repoRoot, "dashboard", "server.mjs");
    else if (role === "scheduler") {
      script = path.join(repoRoot, "scripts", "worker.mjs");
      args = ["scheduler"];
    } else {
      script = path.join(repoRoot, "mcp", "index.mjs");
      args = ["--http", ...(role === "mcp-lan" ? ["--lan"] : [])];
      if (role === "mcp-lan" && !config.lanToken)
        throw new Error("LAN token is missing. Run: anything-obsidian lan on");
      Object.assign(childEnv, {
        MCP_TRANSPORT: "http",
        MCP_PROFILE: role === "mcp-lan" ? "lan" : "local",
        ...(role === "mcp-lan" || isContainer(ctx.env) ? { MCP_AUTH_TOKEN: config.lanToken } : {}),
      });
    }
  }
  await rotateLogs({ logsRoot: ctx.store.paths.logsRoot });
  process.title = `anything-obsidian-${role}`;
  const child = (ctx.deps.spawnImpl ?? spawn)(process.execPath, [script, ...args], {
    env: childEnv,
    stdio: "inherit",
  });
  const terminate = () => child.kill("SIGTERM");
  const interrupt = () => child.kill("SIGINT");
  process.on("SIGTERM", terminate);
  process.on("SIGINT", interrupt);
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });
  } finally {
    process.off("SIGTERM", terminate);
    process.off("SIGINT", interrupt);
  }
}

async function logs(ctx, role, flags) {
  const profile = await ctx.installation.load();
  role ??= profile.roles.includes("gateway") ? "gateway" : "scheduler";
  if (!SERVICE_NAMES.includes(role)) throw new Error(`Unknown service: ${role}`);
  const lines = Number(flags.lines ?? 100);
  if (!Number.isInteger(lines) || lines < 1 || lines > 1000)
    throw new Error("--lines must be between 1 and 1000");
  const file = path.join(ctx.root, "logs", `${role}.log`);
  const keys = [(await ctx.store.load())?.apiKey, (await ctx.gateway.load()).apiKey].filter(
    Boolean,
  );
  const redact = (text) =>
    keys.reduce((result, key) => result.split(key).join("[redacted]"), redactSecretsText(text));
  ctx.log(redact(tailLogFile(file, lines)));
  if (!flags.follow) return 0;
  let offset = (await stat(file).catch(() => ({ size: 0 }))).size;
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    while (!controller.signal.aborted) {
      await delay(500, undefined, { signal: controller.signal });
      const size = (await stat(file).catch(() => ({ size: 0 }))).size;
      if (size < offset) offset = 0;
      if (size > offset) {
        let text = "";
        for await (const chunk of createReadStream(file, { start: offset, end: size - 1 }))
          text += chunk;
        ctx.log(redact(text));
        offset = size;
      }
    }
  } catch (error) {
    if (error.name !== "AbortError") throw error;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  return 0;
}
function createPrompt(io) {
  let hidden = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (hidden) callback();
      else io.output.write(chunk, encoding, callback);
    },
  });
  output.isTTY = io.output.isTTY;
  output.columns = io.output.columns;
  const input = createInterface({
    input: io.input,
    output,
    terminal: Boolean(io.input.isTTY && io.output.isTTY),
  });
  return {
    question: async (text, fallback) => (await input.question(text)).trim() || fallback,
    secret: async (text, fallback) => {
      io.output.write(text);
      hidden = true;
      try {
        return (await input.question("")).trim() || fallback;
      } finally {
        hidden = false;
        io.output.write("\n");
      }
    },
    confirm: async (text, fallback) => {
      const answer = (await input.question(text)).trim().toLowerCase();
      return answer ? ["y", "yes"].includes(answer) : fallback;
    },
    close: () => input.close(),
  };
}

function entryUrl() {
  if (!process.argv[1]) return "";
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return pathToFileURL(path.resolve(process.argv[1])).href;
  }
}
if (import.meta.url === entryUrl()) process.exitCode = await runCli();
