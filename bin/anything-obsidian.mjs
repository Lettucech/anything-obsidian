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
import {
  createServiceController,
  installedServices,
  LEGACY_SERVICE_NAMES,
  SERVICE_NAMES,
} from "../lib/services.mjs";
import { createFeatureManager } from "../lib/features.mjs";
import { createGatewayConfig } from "../server/gateway-config.mjs";
import { fetchWithTimeout } from "../lib/http.mjs";
import { redactSecretsText } from "../dashboard/redact.mjs";
import { tailLogFile } from "../dashboard/local-jobs.mjs";
import { rotateLogs } from "../lib/log-rotate.mjs";
import { withFileLock } from "../lib/state.mjs";
import { updateApplication } from "../lib/updater.mjs";
import { isContainer } from "../lib/deployment.mjs";
import { adminHeaders, ensureContainerToken } from "../lib/container-admin.mjs";
import {
  AGENT_TARGETS,
  DEFAULT_MCP_URL,
  applyConnection,
  detectAgents,
  findAgentTarget,
} from "../lib/agent-connect.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const exec = promisify(execFile);
export const REQUIRED_NODE_MAJOR = 22;
export const MANAGED_VAULTS_ROOT = "~/.anything-obsidian/vaults";
const USAGE = `Usage: anything-obsidian <command>

  setup       Connect and configure this machine; start its services.
              Asks the mode with an arrow-key choice: local AnythingLLM
              (URL + developer key) or join a server (URL + user token).
  start       Start the app service in the background (idempotent)
  stop        Stop the app service; preserve autostart preference
  restart     Restart the app service and verify readiness
  status      Show configuration, readiness and startup guarantee (--json)
  logs        Show logs: [app|dashboard|scheduler|mcp|mcp-lan|gateway] [-f|--follow]
  autostart   on | off | status (changing this does not stop running services)
  server      on | off | status — serve other users through this machine (default off)
  gateway     Deprecated alias for "server"
  connect     Register the local MCP server with coding agents
              (claude-code, cursor, windsurf, codex, gemini, vscode, zcode):
              connect [agent...] | --list | --remove | --url <url>
  update      Stage, verify and activate an update; roll back failed activation
  run         <service> in the foreground for diagnostics ("app" is the merged service)

One install, one process, one dashboard. The server is an opt-in feature:
enable it with "server on" or in the dashboard, then manage users and shared
workspaces at /gateway/.
  --url <url>          AnythingLLM URL (local mode) or server URL (join mode)
  --api-key <value>    AnythingLLM developer key (local) or server user token (join)
  --vaults-root <path> Vault root
  --port <number>      Dashboard port (setup) or server public port (setup --server)
  --admin-port <port>  Legacy server admin port, recorded for compatibility
  --server             Local setup, then enable the server feature

Setup enables autostart by default. macOS starts after login; Linux needs
loginctl enable-linger for operation at boot without a login.
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
        : command === "connect"
          ? {
              json: { type: "boolean" },
              remove: { type: "boolean" },
              list: { type: "boolean" },
              url: { type: "string" },
            }
          : ["status", "autostart", "server", "gateway", "lan"].includes(command)
          ? { json: { type: "boolean" }, "allowed-hosts": { type: "string" } }
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
      ["start", "stop", "restart", "autostart", "update"].includes(command)
    )
      throw new Error(
        "Docker manages lifecycle and startup. Use docker compose up -d, stop, restart, or logs; rebuild the image to update.",
      );
    if (
      !["run", "logs", "autostart", "lan", "server", "gateway", "connect"].includes(command) &&
      positionals.length
    )
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
        if (configured.reconfigure) await controller().restart();
        return await start(context, false);
      }
      case "server":
      case "gateway": {
        const [action = "status", ...rest] = positionals;
        if (!["on", "off", "status"].includes(action) || rest.length)
          throw new Error(`Usage: anything-obsidian ${command} on|off|status`);
        if (command === "gateway" && !flags.json)
          log('Deprecation: "gateway" is now "server"; the alias keeps working.');
        return await serverCommand(context, action, flags.json);
      }
      case "connect":
        if (isContainer(env))
          throw new Error(
            "Agent connect writes host-side agent configs; run it on the host, not inside the container.",
          );
        return await connectCommand(context, positionals, flags);
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
        // The LAN MCP listener (21504) was retired; remote access is the
        // server feature. Existing agent tokens migrate automatically at the
        // next app start.
        log(
          flags.json
            ? JSON.stringify({ deprecated: true, message: "LAN MCP was removed; use 'anything-obsidian server on' and user tokens" })
            : "LAN MCP was removed. For remote access run: anything-obsidian server on — then issue user tokens in the dashboard. Existing LAN agent tokens migrate automatically at the next app start.",
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
    // Containers keep the one-role-per-volume model: a gateway container has
    // no client config, a client container has no gateway config.
    if ((env.AO_CONTAINER_ROLE === "gateway") !== server)
      throw new Error("Setup role must match this Docker service");
    if (flags.port || flags["admin-port"])
      throw new Error(
        "Docker uses fixed internal ports. Change host port mappings in Compose instead.",
      );
    if (flags["vaults-root"] && flags["vaults-root"] !== path.join(ctx.root, "vaults"))
      throw new Error("Docker vaults live in the data volume; custom vault roots are unavailable.");
    if (!server) flags["vaults-root"] = path.join(ctx.root, "vaults");
  } else if (flags["admin-port"] && !server) {
    throw new Error("--admin-port is only valid with setup --server");
  }
  const previousClient = await store.load();
  const previousGateway = server ? await gateway.load() : null;
  const previous = server ? previousGateway : previousClient;
  const prompt =
    flags.url && flags["api-key"] && (server || flags["vaults-root"] || previousClient?.vaultsRoot)
      ? null
      : (deps.promptFactory ?? createPrompt)(
          deps.io ?? { input: process.stdin, output: process.stdout },
        );
  try {
    await (deps.execFileImpl ?? exec)("git", ["--version"]);
    if (
      prompt &&
      (previousClient?.apiKey || previousGateway?.apiKey) &&
      !(await prompt.confirm("Replace this configuration? [y/N] ", false))
    )
      throw new Error("Setup cancelled; existing configuration was kept");
    // Two different credential kinds deserve two different questions. The
    // mode is asked explicitly (arrow-key choice on a terminal); --server
    // always means local AnythingLLM (it enables this machine's own server
    // feature afterwards).
    let mode = server ? "local" : null;
    if (prompt && !mode) {
      const index = prompt.choose
        ? await prompt.choose(
            "Is this machine joining a server, or talking to AnythingLLM directly?",
            ["Local — direct AnythingLLM", "Join a server as a client"],
            { defaultIndex: 0 },
          )
        : Number(
            (await prompt.question(
              "Local (default) or join a server? [1=local, 2=server] ",
              "1",
            )) || "1",
          ) - 1;
      mode = index === 1 ? "gateway" : "local";
    }
    if (!mode) mode = "local"; // flag-driven setup: prompts are skipped anyway
    const defaultUrl =
      previousClient?.anythingllmBaseUrl ||
      previousGateway?.anythingllmBaseUrl ||
      (mode === "gateway" ? "http://localhost:21500" : "http://localhost:21501");
    const anythingllmBaseUrl =
      flags.url ||
      (await prompt.question(
        `${mode === "gateway" ? "Server" : "AnythingLLM"} URL [${defaultUrl}] `,
        defaultUrl,
      ));
    const parsed = new URL(anythingllmBaseUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("URL must use HTTP(S)");
    const apiKey =
      flags["api-key"] ||
      (await (prompt.secret ?? prompt.question)(
        mode === "gateway"
          ? "User token from your administrator: "
          : "AnythingLLM developer API key: ",
        previousClient?.apiKey || "",
      ));
    // (mode "gateway" is the join-a-server flow; the name predates the
    // gateway→server rename and stays internal.)
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
    // Natively every install is a client first; a gateway container is the
    // one shape with no client config.
    if (!isContainer(env) || !server) {
      let vaultsRoot;
      for (;;) {
        vaultsRoot = expandTilde(
          flags["vaults-root"] ||
            (prompt
              ? await prompt.question(
                  `Vault root [${previousClient?.vaultsRoot || MANAGED_VAULTS_ROOT}] `,
                  previousClient?.vaultsRoot || MANAGED_VAULTS_ROOT,
                )
              : previousClient?.vaultsRoot || MANAGED_VAULTS_ROOT),
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
        dashboardPort: Number(flags.port ?? previousClient?.dashboardPort ?? 21502),
        ...(previousClient
          ? {
              mcpAllowedHosts: previousClient.mcpAllowedHosts,
              notifications: previousClient.notifications,
            }
          : {}),
        ...(previousClient?.lanToken
          ? { lanToken: previousClient.lanToken }
          : isContainer(env)
            ? { lanToken: (await import("node:crypto")).randomBytes(32).toString("base64url") }
            : {}),
      });
      await mkdir(config.vaultsRoot, { recursive: true });
    }
    if (server)
      await gateway.save({
        anythingllmBaseUrl: anythingllmBaseUrl.replace(/\/+$/, ""),
        apiKey,
        port: Number(flags.port ?? previousGateway?.port ?? 21500),
        adminPort: Number(flags["admin-port"] ?? previousGateway?.adminPort ?? 21505),
      });
    await store.ensureLayout();
    if (!isContainer(env) || !server) await installation.addRole("client");
    if (server) await installation.addRole("server");
    log(
      server && isContainer(env)
        ? `Configuration saved: ${path.join(ctx.root, "gateway", "gateway.json")}`
        : `Configuration saved: ${store.paths.configPath}${
            server
              ? " (server feature enabled)"
              : mode === "gateway"
                ? " (joined a server)"
                : ""
          }`,
    );
    return { role: server ? "server" : "client", reconfigure: Boolean(previous) };
  } finally {
    prompt?.close();
  }
}

async function start(ctx, restart) {
  const migration = await ctx.controller()[restart ? "restart" : "start"]();
  if (migration?.removedServices?.length)
    ctx.log(
      `Migrated to the single app service; removed legacy definitions: ${migration.removedServices.join(", ")}`,
    );
  if (migration?.convertedGatewayOnly)
    ctx.log(
      "Server-only install converted: client configured from gateway.json; the server feature stays enabled.",
    );
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

// The server toggle prefers the running app's own feature API so listeners
// open and close in-process; with nothing running it edits state directly and
// the change applies at the next start. The dashboard endpoints keep their
// /api/features/gateway paths for compatibility.
async function serverCommand(ctx, action, json) {
  const { log } = ctx;
  const localState = async () => {
    const profile = await ctx.installation.load();
    const state = await ctx.gateway.load();
    return {
      available: !isContainer(ctx.env),
      enabled: profile.roles.includes("server"),
      running: false,
      configured: Boolean(state.apiKey && state.anythingllmBaseUrl),
      port: state.port ?? 21500,
    };
  };
  if (action === "status") {
    const remote = await dashboardRequest(ctx, "GET", "/api/features/gateway").catch(() => null);
    const state = remote ?? (await localState());
    log(
      json
        ? JSON.stringify(state)
        : `Server: ${state.enabled ? "on" : "off"}${state.running ? " (running)" : ""} — console ${dashboardUrl(ctx)}/gateway/`,
    );
    return 0;
  }
  const remote = await dashboardRequest(ctx, "POST", "/api/features/gateway", { action }).catch(
    (error) => (unreachable(error) ? null : Promise.reject(error)),
  );
  if (remote) {
    if (remote.status === 400 || remote.status === 503) {
      // A running app answered: needsDevKey (400) or server listener trouble.
      log(
        json
          ? JSON.stringify(remote.data)
          : `Error: ${remote.data.error ?? remote.data.reason ?? "could not toggle the server"}`,
      );
      return 1;
    }
    log(
      json
        ? JSON.stringify(remote.data)
        : `Server ${action}: ${remote.data.enabled ? "on" : "off"}`,
    );
    return 0;
  }
  // App not running: record the preference for the next start.
  const features = await createFeatureManager({
    env: ctx.env,
    root: ctx.root,
    installation: ctx.installation,
  });
  if (action === "off") {
    const state = await features.disableGateway();
    log(json ? JSON.stringify(state) : "Server off (it was not running).");
    return 0;
  }
  const result = await features.enableGateway();
  if (!result.ok) {
    log(
      json
        ? JSON.stringify(result)
        : `Error: ${result.reason ?? "the server needs an AnythingLLM developer key"}. Start the app and use the dashboard, or re-run setup --server.`,
    );
    return 1;
  }
  log(
    json
      ? JSON.stringify(result)
      : `Server on (not running yet); it will listen on port ${result.port} at the next start. Manage it at ${dashboardUrl(ctx)}/gateway/`,
  );
  return 0;
}

// Registers the local MCP endpoint (loopback, owner-trusted) with coding
// agents' own config files. Each writer is idempotent and touches exactly one
// key; skills stay with `npx skills add`, which this command only advertises.
async function connectCommand(ctx, targets, flags) {
  const { log, env, fetchImpl } = ctx;
  const homeDir = env.HOME || os.homedir();
  if (flags.list) {
    const rows = await detectAgents({ homeDir });
    log(
      flags.json
        ? JSON.stringify(rows)
        : rows
            .map((row) => `${row.detected ? "✔" : "·"} ${row.id.padEnd(12)} ${row.label}`)
            .join("\n"),
    );
    return 0;
  }
  const ids = targets.map(String);
  for (const id of ids) findAgentTarget(id);
  let selected = ids;
  if (!ids.length) {
    const rows = await detectAgents({ homeDir });
    selected = rows.filter((row) => row.detected).map((row) => row.id);
    if (!selected.length) {
      log(
        flags.json
          ? JSON.stringify({ results: [] })
          : `No supported coding agents detected. Known agents: ${AGENT_TARGETS.map((t) => t.id).join(", ")}.`,
      );
      return 0;
    }
  }
  const url = flags.url || DEFAULT_MCP_URL;
  const results = [];
  for (const id of selected)
    results.push(await applyConnection({ id, homeDir, url, remove: flags.remove === true }));
  let appReachable = null;
  let healthUrl = null;
  if (!flags.remove) {
    healthUrl = `${url.replace(/\/mcp\/?$/, "")}/health`;
    const response = await fetchWithTimeout(fetchImpl, healthUrl, {}, 1500).catch(() => null);
    appReachable = Boolean(response && response.ok);
  }
  const describe = (result) => {
    if (result.status === "connected") return `connected → ${result.configPath}`;
    if (result.status === "removed") return `removed from ${result.configPath}`;
    if (result.status === "unchanged")
      return `already ${flags.remove ? "absent" : "connected"} (${result.configPath})`;
    return `${result.status} — ${result.note}`;
  };
  if (flags.json) {
    log(
      JSON.stringify({
        results,
        ...(appReachable === null ? {} : { appReachable }),
      }),
    );
  } else {
    for (const result of results) log(`${result.id}: ${describe(result)}`);
    if (!flags.remove) {
      if (appReachable === false)
        log(`Note: no answer from ${healthUrl} — run 'anything-obsidian start' before using the tools.`);
      log(
        "Skills (optional): npx skills add Lettucech/anything-obsidian --skill anything-obsidian-vault-workflow --agent <agent>",
      );
    }
  }
  return results.some((result) => result.status === "not-installed") ? 1 : 0;
}

function unreachable(error) {
  return (
    error?.code === "ECONNREFUSED" ||
    error?.cause?.code === "ECONNREFUSED" ||
    error?.statusCode === 404 ||
    error?.statusCode === 501
  );
}

function dashboardUrl(ctx) {
  return `http://127.0.0.1:${ctx.env.DASHBOARD_PORT || 21502}`;
}

// Never throws on HTTP status; returns {status, data}. Network errors throw.
async function dashboardRequest(ctx, method, pathname, body) {
  const response = await fetchWithTimeout(
    ctx.fetchImpl,
    `${dashboardUrl(ctx)}${pathname}`,
    {
      method,
      ...(body !== undefined
        ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } }
        : {}),
      headers: await adminHeaders(ctx.env),
    },
    5000,
  );
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
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
  const clientConfig = await ctx.store.load();
  const dashboardPort = clientConfig?.dashboardPort ?? 21502;
  const dashboardBase = `http://127.0.0.1:${dashboardPort}`;
  endpoints.push(["dashboard", `${dashboardBase}/ready`, "any-obs-dashboard"]);
  endpoints.push(["mcp", "http://127.0.0.1:21503/health", "anything-obsidian-mcp"]);
  report.dashboardUrl = `http://localhost:${dashboardPort}`;
  if (profile.roles.includes("server")) {
    const gatewayConfig = await ctx.gateway.load();
    endpoints.push([
      "gateway",
      `http://127.0.0.1:${gatewayConfig.port ?? 21500}/ready`,
      "any-obs-gateway",
    ]);
    report.gatewayUrl = `http://localhost:${dashboardPort}/gateway/`;
    if (runtime.autostart.enabled && runtime.autostart.linger === false) {
      report.startupBlocked = true;
      report.detail = `Server startup at boot is not configured. Run once: loginctl enable-linger ${ctx.env.USER || os.userInfo().username}`;
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
    if (report.services.gateway?.healthy) {
      // The gateway admin surface is mounted on the dashboard in the merged
      // app, so indexing state reads from the dashboard origin.
      const [{ jobs = [] }, { sources = [] }] = await Promise.all([
        read(`${dashboardBase}/api/gateway/jobs`),
        read(`${dashboardBase}/api/gateway/sources`),
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
  if (report.gatewayUrl) log(`Server console: ${report.gatewayUrl}`);
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
  // Minimal service env: the gateway reads gateway.json, and the merged app
  // entry reads config.json itself — credentials never ride the spawn env.
  return {
    HOME: env.HOME,
    PATH: env.PATH,
    ANYTHING_OBSIDIAN_HOME: root,
    AO_SUPERVISED: "1",
    ...(isContainer(env) ? { AO_CONTAINER: "1", AO_CONTAINER_ROLE: env.AO_CONTAINER_ROLE } : {}),
  };
}
// Legacy names stay runnable: the container runtime still spawns per-role
// services by name, and they are handy for diagnostics. mcp-lan is gone
// with the LAN listener, but its old logs stay readable.
const RUNNABLE_SERVICES = [...SERVICE_NAMES, ...LEGACY_SERVICE_NAMES.filter((name) => name !== "mcp-lan")];
const LOG_SERVICE_NAMES = [...RUNNABLE_SERVICES, "mcp-lan"];

async function runForeground(ctx, role) {
  if (!RUNNABLE_SERVICES.includes(role)) throw new Error(`Unknown service: ${role}`);
  return withFileLock(
    path.join(ctx.root, "run", `${role}.lock`),
    () => spawnForeground(ctx, role),
    { timeoutMs: 0 },
  );
}

async function spawnForeground(ctx, role) {
  if (!RUNNABLE_SERVICES.includes(role)) throw new Error(`Unknown service: ${role}`);
  const profile = await ctx.installation.load();
  // The merged app service needs the merged role set; legacy names map to
  // the role that used to own them (and always run inside containers).
  // profile.roles is normalized, so a legacy "gateway" role token on disk
  // satisfies the "server" check.
  const legacyRoleAllowed =
    LEGACY_SERVICE_NAMES.includes(role) &&
    (role === "gateway"
      ? profile.roles.includes("server")
      : profile.roles.includes("client"));
  if (!installedServices(profile).includes(role) && !legacyRoleAllowed)
    throw new Error(`Service is not configured: ${role}`);
  let script,
    args = [],
    childEnv;
  if (role === "app") {
    // The merged entry loads config.json itself; credentials stay out of the
    // spawn env.
    script = path.join(repoRoot, "app.mjs");
    childEnv = gatewayEnvironment(ctx.root, ctx.env);
  } else if (role === "gateway") {
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
      args = ["--http"];
      Object.assign(childEnv, {
        MCP_TRANSPORT: "http",
        MCP_PROFILE: "local",
        ...(isContainer(ctx.env) && config.lanToken
          ? { MCP_AUTH_TOKEN: config.lanToken }
          : {}),
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
  role ??= "app";
  if (!LOG_SERVICE_NAMES.includes(role)) throw new Error(`Unknown service: ${role}`);
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
// One-shot readline question. Each prompt opens its own interface so the
// arrow-key chooser below can own raw stdin without clashing with readline.
async function askLine(io, text) {
  const rl = createInterface({
    input: io.input,
    output: io.output,
    terminal: Boolean(io.input.isTTY && io.output.isTTY),
  });
  try {
    return await rl.question(text);
  } finally {
    rl.close();
  }
}

// Single choice, arrow-key UI on a real terminal (↑/↓ move, Enter picks,
// number keys are shortcuts, Ctrl+C cancels). Pipes, agents and tests fall
// back to a plain numbered question.
export function chooseOption(io, question, options, { defaultIndex = 0 } = {}) {
  if (typeof io.input?.setRawMode !== "function" || !io.input.isTTY) {
    const numbered =
      [question, ...options.map((option, i) => `  ${i + 1}) ${option}`), "Choose [1]: "].join("\n");
    return (async () => {
      const answer = (await askLine(io, numbered)).trim().toLowerCase();
      const digit = Number(answer);
      if (Number.isInteger(digit) && digit >= 1 && digit <= options.length) return digit - 1;
      if (answer && !Number.isNaN(digit)) {
        const byName = options.findIndex((option) => option.toLowerCase().startsWith(answer));
        if (byName >= 0) return byName;
      }
      return defaultIndex;
    })();
  }
  return new Promise((resolve, reject) => {
    const input = io.input;
    const output = io.output;
    let selected = Math.min(Math.max(defaultIndex, 0), options.length - 1);
    const wasRaw = input.isRaw === true;
    input.setRawMode(true);
    input.resume();
    const height = 1 + options.length;
    const render = (first) => {
      if (!first) output.write(`\x1b[${height}A`);
      const lines = [question];
      options.forEach((option, i) => {
        lines.push(i === selected ? `\x1b[36m❯\x1b[0m ${option}` : `  ${option}`);
      });
      output.write(lines.map((line) => `\x1b[2K${line}`).join("\n") + "\n");
    };
    const cleanup = () => {
      input.removeListener("data", onKey);
      input.setRawMode(wasRaw);
    };
    const finish = (index) => {
      cleanup();
      resolve(index);
    };
    const cancel = () => {
      cleanup();
      output.write("\n");
      reject(new Error("Setup cancelled"));
    };
    const onKey = (chunk) => {
      const text = String(chunk);
      if (text.includes("\x1b[A")) {
        selected = (selected - 1 + options.length) % options.length;
        return render(false);
      }
      if (text.includes("\x1b[B")) {
        selected = (selected + 1) % options.length;
        return render(false);
      }
      if (text === "\x03") return cancel();
      if (/[\r\n]/.test(text)) return finish(selected);
      const digit = Number(text.trim());
      if (Number.isInteger(digit) && digit >= 1 && digit <= options.length) {
        return finish(digit - 1);
      }
    };
    input.on("data", onKey);
    render(true);
  });
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
  return {
    question: async (text, fallback) => (await askLine({ input: io.input, output }, text)).trim() || fallback,
    secret: async (text, fallback) => {
      io.output.write(text);
      hidden = true;
      try {
        return (await askLine({ input: io.input, output }, "")).trim() || fallback;
      } finally {
        hidden = false;
        io.output.write("\n");
      }
    },
    confirm: async (text, fallback) => {
      const answer = (await askLine({ input: io.input, output }, text)).trim().toLowerCase();
      return answer ? ["y", "yes"].includes(answer) : fallback;
    },
    choose: (text, options, opts) =>
      chooseOption({ input: io.input, output }, text, options, opts),
    close() {},
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
