#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { createAnythingllmClient } from "../dashboard/anythingllm.mjs";
import { createDashboardServer } from "../dashboard/server.mjs";
import { createFileJobStore } from "../dashboard/job-store.mjs";
import { syncStatusPath } from "../lib/sync-status.mjs";
import { rotateLogs } from "../lib/log-rotate.mjs";
import { compareVersions, currentVersionValue, fetchLatestVersion } from "../lib/update-check.mjs";
import {
  createLocalJobManager,
  startDashboardProcess,
  startSchedulerProcess,
  stopSchedulerProcess,
  readSchedulerStatus,
  tailLogFile,
  waitForHttp,
  WORKER_SCRIPT_PATH,
} from "../dashboard/local-jobs.mjs";
import { createAppConfigStore, defaultConfigRoot, expandTilde, nativeEnv } from "../lib/app-config.mjs";
import { createVaultRegistry } from "../lib/vault-registry.mjs";
import { createServiceManager } from "../lib/autostart.mjs";
import { randomBytes } from "node:crypto";

const execFileAsync = promisify(execFile);
const USAGE = `Usage: anything-obsidian <command>

Commands:
  init       One-time setup: vault root, AnythingLLM URL and API key
  start      Run the dashboard in the foreground and open it in a browser
  start-bg   Start the background sync scheduler
  stop       Stop the dashboard (if backgrounded) and the sync scheduler
  status     Show install, config, and service health (--json for agents)
  autostart  Keep the dashboard and scheduler running: on | off | status
  lan        Manage the LAN MCP endpoint: token <t> | on | off | status
  update     Update the app in place (data and settings are kept)

Options:
  --vaults-root <path>       Vault root directory (init)
  --url <url>                AnythingLLM base URL (init)
  --api-key <key>            AnythingLLM API key (init)
  --port <number>            Dashboard port, default 21400 (init)
  --bg                       Start the dashboard in the background (start)
  --no-browser               Do not open the browser (start)
  --json                     Machine-readable output (status)
  --help                     Show this help

Init flags make setup non-interactive: when all of --vaults-root, --url,
and --api-key are provided, no prompts are shown.`;

export const REQUIRED_NODE_MAJOR = 22;

export function nodeVersionProblem(version = process.versions.node) {
  const major = Number.parseInt(String(version ?? "").split(".")[0], 10);
  if (Number.isInteger(major) && major >= REQUIRED_NODE_MAJOR) return null;
  return [
    `Anything Obsidian needs Node.js >= ${REQUIRED_NODE_MAJOR} (found ${version || "none"}).`,
    "install.sh installs a managed Node runtime when the system has none:",
    "  curl -fsSL https://raw.githubusercontent.com/Lettucech/anything-obsidian/main/install.sh | sh",
  ].join("\n");
}

export async function runCli(argv = process.argv.slice(2), deps = {}) {
  const io = deps.io || { input: process.stdin, output: process.stdout };
  const env = deps.env || process.env;
  const store = deps.store || createAppConfigStore({ rootDir: defaultConfigRoot({ env }) });
  const fetchImpl = deps.fetchImpl || fetch;
  const spawnImpl = deps.spawnImpl || spawn;
  const killImpl = deps.killImpl;
  const execFileImpl = deps.execFileImpl || execFileAsync;
  const log = deps.log || ((message) => io.output.write(`${message}\n`));

  const [command, ...rest] = argv;
  const flags = parseFlags(rest);

  const wantsHelp = command === undefined || ["-h", "--help", "help"].includes(command);
  if (!wantsHelp) {
    const problem = nodeVersionProblem(deps.nodeVersion);
    if (problem) {
      log(problem);
      return 1;
    }
  }

  switch (command) {
    case "init":
      return runInit({ flags, store, env, io, fetchImpl, log, promptFactory: deps.promptFactory });
    case "start":
      return runStart({ store, env, spawnImpl, fetchImpl, log, launchctl: deps.launchctl, systemctl: deps.systemctl, platform: deps.platform, background: "bg" in flags, noBrowser: "no-browser" in flags });
    case "start-bg":
      return runStartBg({ store, env, spawnImpl, killImpl, log });
    case "scheduler-fg":
      return runSchedulerFg({ store, env, spawnImpl, log });
    case "stop":
      return runStop({ store, killImpl, log, launchctl: deps.launchctl, systemctl: deps.systemctl, platform: deps.platform, env });
    case "status":
      return runStatus({ store, env, fetchImpl, execFileImpl, log, json: "json" in flags, launchctl: deps.launchctl, systemctl: deps.systemctl, platform: deps.platform });
    case "autostart":
      return runAutostart({ subcommand: rest[0], store, env, log, json: "json" in flags, launchctl: deps.launchctl, systemctl: deps.systemctl, platform: deps.platform });
    case "mcp-fg":
      return runMcpFg({ store, env, spawnImpl, log, lan: rest.includes("--lan") || flags.lan === "" || flags.lan === "1" });
    case "lan":
      return runLan({ subcommand: rest[0], argument: rest[1], store, env, log, json: "json" in flags, launchctl: deps.launchctl, systemctl: deps.systemctl, platform: deps.platform });
    case "update":
      return runUpdate({ log, spawnImpl });
    case "-h":
    case "--help":
    case "help":
      log(USAGE);
      return 0;
    default:
      log(USAGE);
      return command === undefined ? 0 : 2;
  }
}

function autostartManager({ store, env, log, launchctl, systemctl, platform = process.platform }) {
  try {
    return createServiceManager({
      platform,
      homedir: env.HOME || undefined,
      logsRoot: store.paths.logsRoot,
      ...(launchctl ? { launchctl } : {}),
      ...(systemctl ? { systemctl } : {}),
    });
  } catch (error) {
    log(`Autostart is unavailable here: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function runAutostart({ subcommand, store, env, log, json, launchctl, systemctl, platform }) {
  const config = await loadConfigOrWarn(store, log);
  if (!config) return 1;
  await store.ensureLayout();
  const manager = autostartManager({ store, env, log, launchctl, systemctl, platform });
  if (!manager) return 1;

  switch (subcommand) {
    case "on": {
      await manager.enable({
        dashboardLogPath: store.paths.dashboardLogPath,
        schedulerLogPath: store.paths.schedulerLogPath,
        displayRoot: store.paths.displayRoot,
      });
      const state = await manager.status();
      if (json) {
        log(JSON.stringify({ ok: true, autostart: "on", services: state }, null, 2));
      } else {
        log("Autostart is on. The dashboard and sync scheduler are running and will");
        log("start again at every login and restart automatically if they crash.");
      }
      return 0;
    }
    case "off": {
      await manager.disable();
      if (json) {
        log(JSON.stringify({ ok: true, autostart: "off" }, null, 2));
      } else {
        log("Autostart is off. The dashboard and scheduler are stopped and will not");
        log("start at login. Start them any time with: anything-obsidian start");
      }
      return 0;
    }
    case "status":
    default: {
      const enabled = await manager.enabled();
      const services = enabled ? await manager.status() : { dashboard: { loaded: false, running: false, pid: null }, scheduler: { loaded: false, running: false, pid: null } };
      if (json) {
        log(JSON.stringify({ ok: true, autostart: { enabled, ...services } }, null, 2));
        return 0;
      }
      const describe = (name, service) =>
        `${name}: ${service.running ? `running (pid ${service.pid})` : service.loaded ? "loaded, not running" : "not loaded"}`;
      log(`Autostart: ${enabled ? "on" : "off"}`);
      log(`  ${describe("Dashboard", services.dashboard)}`);
      log(`  ${describe("Scheduler", services.scheduler)}`);
      return 0;
    }
  }
}

async function runSchedulerFg({ store, env, spawnImpl, log }) {
  const config = await loadConfigOrWarn(store, log);
  if (!config) return 1;
  await store.ensureLayout();

  if (env.AO_SUPERVISED) {
    process.title = "anything-obsidian-scheduler";
  }
  const child = spawnImpl(process.argv[0] || process.execPath, [WORKER_SCRIPT_PATH, "scheduler"], {
    env: nativeEnv(config, store.paths, { env }),
    stdio: "inherit",
  });
  const forward = (signal) => {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  };
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGINT", () => forward("SIGINT"));
  const code = await new Promise((resolve) => {
    child.on("error", () => resolve(1));
    child.on("close", resolve);
  });
  return code === 0 ? 0 : 1;
}

async function runInit({ flags, store, env, io, fetchImpl, log, promptFactory }) {
  const nonInteractive = Boolean(flags["vaults-root"] && flags.url && flags["api-key"]);
  const prompt = nonInteractive ? null : (promptFactory || createPrompt)(io);

  try {
    const existing = await store.load();
    if (existing && !nonInteractive) {
      const overwrite = await prompt.confirm(`Config already exists at ${store.paths.configPath}. Overwrite? [y/N] `, false);
      if (!overwrite) {
        log("Keeping the existing configuration.");
        return 0;
      }
    }

    log("Checking prerequisites…");
    const gitOk = await checkGit();
    log(gitOk ? "✓ git is available" : "✗ git was not found. Install git (e.g. `xcode-select --install`) and re-run init.");
    if (!gitOk) return 1;

    const vaultsRoot = await resolveVaultsRoot({ flags, prompt, env, log });
    const anythingllmBaseUrl = flags.url || await prompt.question(`AnythingLLM base URL [http://localhost:3001] `, "http://localhost:3001");
    const apiKey = flags["api-key"] || await prompt.question("AnythingLLM API key: ", "");
    const dashboardPort = Number(flags.port || 21400);

    const client = createAnythingllmClient({ baseUrl: anythingllmBaseUrl, apiKey, fetchImpl });
    log(`Testing the AnythingLLM connection at ${anythingllmBaseUrl}…`);
    try {
      const workspaces = await client.listWorkspaces();
      log(`✓ Connected. ${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"} visible.`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log(`✗ Could not talk to AnythingLLM: ${detail}`);
      log("  Check that the URL is reachable and the API key comes from Settings → Developer API.");
      return 1;
    }

    const config = await store.save({
      vaultsRoot,
      anythingllmBaseUrl,
      apiKey,
      dashboardPort: Number.isInteger(dashboardPort) ? dashboardPort : 21400,
    });
    await mkdir(config.vaultsRoot, { recursive: true });

    log("");
    log("Setup complete.");
    log(`  Vault root:       ${config.vaultsRoot}`);
    log(`  AnythingLLM:      ${config.anythingllmBaseUrl}`);
    log(`  Dashboard:        http://localhost:${config.dashboardPort}`);
    log(`  Config directory: ${store.paths.root}`);
    log("");
    log("Start the dashboard with: anything-obsidian start");
    return 0;
  } finally {
    prompt?.close();
  }
}

async function resolveVaultsRoot({ flags, prompt, env, log }) {
  if (flags["vaults-root"]) return expandTilde(flags["vaults-root"]);

  while (true) {
    const answer = await prompt.question(`Vault root directory [~/ObsidianVaults] `, "~/ObsidianVaults");
    const vaultsRoot = expandTilde(answer.trim());
    if (!path.isAbsolute(vaultsRoot)) {
      log("Please enter an absolute path.");
      continue;
    }
    if (isTccProtected(vaultsRoot, env.HOME)) {
      const proceed = await prompt.confirm(
        `Volumes inside Documents or Desktop trigger repeated macOS permission prompts. Use ${vaultsRoot} anyway? [y/N] `,
        false,
      );
      if (!proceed) continue;
    }
    return vaultsRoot;
  }
}

function isTccProtected(candidate, home) {
  if (!home) return false;
  for (const protectedDir of ["Documents", "Desktop"]) {
    const boundary = path.join(home, protectedDir);
    if (candidate === boundary || candidate.startsWith(`${boundary}${path.sep}`)) return true;
  }
  return false;
}

function createPrompt(io) {
  const readline = createInterface({ input: io.input, output: io.output });
  return {
    async question(text, fallback) {
      const answer = (await readline.question(text)).trim();
      return answer || fallback;
    },
    async confirm(text, fallback) {
      const answer = (await readline.question(text)).trim().toLowerCase();
      return answer ? ["y", "yes"].includes(answer) : fallback;
    },
    close() {
      readline.close();
    },
  };
}

async function checkGit() {
  try {
    await execFileAsync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

async function loadConfigOrWarn(store, log) {
  const config = await store.load();
  if (!config) {
    log("This app is not initialized yet. Run: anything-obsidian init");
    return null;
  }
  return config;
}

async function runStart({ store, env, spawnImpl, fetchImpl, log, launchctl, systemctl, platform, background, noBrowser }) {
  const config = await loadConfigOrWarn(store, log);
  if (!config) return 1;
  await store.ensureLayout();

  const url = `http://localhost:${config.dashboardPort}`;
  const manager = autostartManager({ store, env, log, launchctl, systemctl, platform });
  // When a service manager spawned us (AO_SUPERVISED), it is the supervisor: run the
  // server in-process and never self-detect as "already managed".
  const autostartOn = manager && !env.AO_SUPERVISED ? await manager.enabled() : false;

  if (background) {
    if (autostartOn && manager) {
      await manager.enable({
        dashboardLogPath: store.paths.dashboardLogPath,
        schedulerLogPath: store.paths.schedulerLogPath,
      });
      log(`Dashboard is managed by launchd and running at ${url}.`);
    } else {
      const childEnv = { ...nativeEnv(config, store.paths, { env }), AO_MODE: "native" };
      const result = startDashboardProcess({
        env: childEnv,
        pidPath: store.paths.dashboardPidPath,
        logPath: store.paths.dashboardLogPath,
        spawnImpl,
      });
      if (result.alreadyRunning) {
        log(`Dashboard is already running at ${url}.`);
      } else {
        log(`Starting dashboard (pid ${result.pid})…`);
        const ready = await waitForHttp(`http://127.0.0.1:${config.dashboardPort}/api/status`, { fetchImpl });
        if (!ready) {
          const logTail = tailLogFile(store.paths.dashboardLogPath, 20);
          log(`✗ Dashboard did not become ready. Last log lines:`);
          log(logTail || `(no log output)`);
          return 1;
        }
        log(`Dashboard running at ${url}.`);
      }
    }
    if (!noBrowser) openBrowser(url, { spawnImpl });
    return 0;
  }

  if (autostartOn && manager) {
    const services = await manager.status();
    if (services.dashboard.running) {
      log(`Dashboard is already managed by launchd and running at ${url}.`);
      return 0;
    }
  }

  const childEnv = { ...nativeEnv(config, store.paths, { env }), AO_MODE: "native" };
  if (env.AO_SUPERVISED) {
    // The Activity Monitor name follows the process title and the executable;
    // both carry the anything-obsidian role for launchd-spawned services.
    process.title = "anything-obsidian-dashboard";
  }
  const server = createDashboardServer({
    mode: "native",
    env: childEnv,
    jobs: createLocalJobManager({ env: childEnv, nodePath: process.argv[0] || process.execPath, jobStore: createFileJobStore({ filePath: store.paths.jobStorePath }) }),
    native: {
      schedulerPidPath: store.paths.schedulerPidPath,
      schedulerLogPath: store.paths.schedulerLogPath,
      jobStorePath: store.paths.jobStorePath,
      lastSyncPath: syncStatusPath(store.paths.stateRoot),
      spawnImpl,
    },
  });

  server.listen(config.dashboardPort, "127.0.0.1", () => {
    log(`Dashboard running at ${url} (Ctrl+C to stop)`);
    openBrowser(url, { spawnImpl });
  });
  const shutdown = () => {
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return 0;
}

async function runStartBg({ store, env, spawnImpl, killImpl, log }) {
  const config = await loadConfigOrWarn(store, log);
  if (!config) return 1;
  await store.ensureLayout();

  const result = startSchedulerProcess({
    env: nativeEnv(config, store.paths, { env }),
    pidPath: store.paths.schedulerPidPath,
    logPath: store.paths.schedulerLogPath,
    spawnImpl,
    killImpl,
  });

  if (result.alreadyRunning) {
    log(`Scheduler is already running (pid ${result.pid}).`);
    return 0;
  }
  log(`Scheduler started (pid ${result.pid}). Logs: ${store.paths.schedulerLogPath}`);
  return 0;
}

async function runStop({ store, killImpl, log, launchctl, systemctl, platform, env }) {
  const config = await loadConfigOrWarn(store, log);
  if (!config) return 1;

  const manager = autostartManager({ store, env: env || process.env, log, launchctl, systemctl, platform });
  if (manager && (await manager.enabled())) {
    await manager.halt();
    log("Dashboard and scheduler stopped (autostart services unloaded).");
    log("They will start again at next login or reboot while autostart is on.");
    log("Disable that permanently with: anything-obsidian autostart off");
    return 0;
  }

  const dashboard = await stopSchedulerProcess({ pidPath: store.paths.dashboardPidPath, killImpl });
  log(dashboard.stopped ? `Dashboard stopped (pid ${dashboard.pid}).` : "Dashboard is not running.");
  const scheduler = await stopSchedulerProcess({ pidPath: store.paths.schedulerPidPath, killImpl });
  log(scheduler.stopped ? `Scheduler stopped (pid ${scheduler.pid}).` : "Scheduler is not running.");
  return 0;
}

async function runStatus({ store, env, fetchImpl, execFileImpl, log, json, launchctl, systemctl, platform, fetchLatest = fetchLatestVersion }) {
  const config = await store.load();
  const manager = autostartManager({ store, env, log, launchctl, systemctl, platform });
  const autostartEnabled = manager ? await manager.enabled() : false;
  const launchd = autostartEnabled && manager ? await manager.status() : null;
  const report = {
    ok: false,
    platform: process.platform,
    node: process.version.replace(/^v/, ""),
    git: null,
    config: null,
    autostart: { enabled: autostartEnabled, ...(launchd ?? {}) },
    anythingllm: { ok: false, detail: "not configured" },
    dashboard: { running: false, pid: null, healthy: false, url: null },
    scheduler: { running: false, pid: null },
    mcp: { running: false, healthy: false, url: null },
    mcpLan: { running: false, healthy: false, url: null },
    vaults: null,
  };

  report.git = await gitVersion(execFileImpl);

  if (!config) {
    report.anythingllm = { ok: false, detail: "not configured (run: anything-obsidian init)" };
    emit(report);
    return 1;
  }

  const dashboardUrl = `http://localhost:${config.dashboardPort}`;
  report.config = {
    path: store.paths.configPath,
    vaultsRoot: config.vaultsRoot,
    anythingllmBaseUrl: config.anythingllmBaseUrl,
    dashboardPort: config.dashboardPort,
  };

  let dashboardPid = null;
  let dashboardRunning = false;
  let schedulerPid = null;
  let schedulerRunning = false;
  let mcpRunning = false;
  let mcpLanRunning = false;
  if (launchd) {
    dashboardPid = launchd.dashboard.pid;
    dashboardRunning = launchd.dashboard.running;
    schedulerPid = launchd.scheduler.pid;
    schedulerRunning = launchd.scheduler.running;
    mcpRunning = launchd.mcp?.running ?? false;
    mcpLanRunning = launchd.mcpLan?.running ?? false;
  } else {
    const dashboard = readSchedulerStatus({ pidPath: store.paths.dashboardPidPath, killImpl: processKill });
    dashboardPid = dashboard.pid;
    dashboardRunning = dashboard.running;
    const scheduler = readSchedulerStatus({ pidPath: store.paths.schedulerPidPath, killImpl: processKill });
    schedulerPid = scheduler.pid;
    schedulerRunning = scheduler.running;
  }

  let dashboardHealthy = false;
  if (dashboardRunning) {
    try {
      const response = await fetchImpl(`http://127.0.0.1:${config.dashboardPort}/api/status`);
      dashboardHealthy = response.ok;
    } catch {
      dashboardHealthy = false;
    }
  }
  report.dashboard = { running: dashboardRunning, pid: dashboardPid, healthy: dashboardHealthy, url: dashboardUrl };
  report.scheduler = { running: schedulerRunning, pid: schedulerPid };
  const probeMcp = async (port) => {
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/health`);
      return { running: response.ok || response.status < 500, healthy: response.ok };
    } catch {
      return { running: false, healthy: false };
    }
  };
  if (mcpRunning || !launchd) {
    const local = await probeMcp(21433);
    report.mcp = { ...local, url: "http://localhost:21433/mcp" };
  } else {
    report.mcp = { running: false, healthy: false, url: "http://localhost:21433/mcp" };
  }
  if (mcpLanRunning) {
    const lan = await probeMcp(21444);
    report.mcpLan = { ...lan, url: "http://<host>:21444/mcp" };
  }

  const client = createAnythingllmClient({
    baseUrl: config.anythingllmBaseUrl,
    apiKey: config.apiKey,
    fetchImpl,
  });
  try {
    const workspaces = await client.listWorkspaces();
    report.anythingllm = { ok: true, detail: "connected", workspaces: workspaces.length };
  } catch (error) {
    report.anythingllm = { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }

  try {
    const registry = createVaultRegistry({
      rootPath: config.vaultsRoot,
      registryPath: store.paths.registryPath,
    });
    report.vaults = (await registry.list()).length;
  } catch {
    report.vaults = null;
  }

  const current = await currentVersionValue();
  const latest = await fetchLatest({ fetchImpl });
  report.update = {
    current,
    latest,
    available: Boolean(latest) && compareVersions(current, latest) < 0,
  };
  report.ok = Boolean(report.git) && report.anythingllm.ok;
  emit(report);
  return report.ok ? 0 : 1;

  function emit(value) {
    if (json) {
      log(JSON.stringify(value, null, 2));
      return;
    }
    const mark = (ok) => (ok ? "✓" : "✗");
    log(`Anything Obsidian status`);
    log(`  ${mark(Boolean(value.git))} git: ${value.git || "not found"}`);
    log(`  ✓ node: ${value.node}`);
    if (!value.config) {
      log(`  ${mark(false)} config: not initialized (run: anything-obsidian init)`);
      return;
    }
    log(`  ✓ config: ${value.config.path}`);
    log(`      vault root: ${value.config.vaultsRoot}`);
    log(`      vaults managed: ${value.vaults ?? "unknown"}`);
    log(`  ${mark(value.anythingllm.ok)} AnythingLLM: ${value.anythingllm.ok ? `${value.config.anythingllmBaseUrl} (${value.anythingllm.workspaces ?? 0} workspaces)` : value.anythingllm.detail}`);
    const dashboard = value.dashboard;
    log(`  ${mark(dashboard.healthy)} Dashboard: ${dashboard.healthy ? `running at ${dashboard.url}` : dashboard.running ? `starting or unhealthy (pid ${dashboard.pid})` : "not running"}`);
    log(`  ${mark(value.scheduler.running)} Scheduler: ${value.scheduler.running ? `running (pid ${value.scheduler.pid})` : "not running"}`);
    log(`  ${mark(value.mcp.healthy)} Local MCP: ${value.mcp.healthy ? `running at ${value.mcp.url}` : value.mcp.running ? "starting or unhealthy" : "not running"}`);
    log(`  ${mark(value.mcpLan.healthy)} LAN MCP: ${value.mcpLan.healthy ? "running (port 21444)" : "off or not running"}`);
    log(`  ${mark(value.autostart.enabled)} Autostart: ${value.autostart.enabled ? "on (starts at login, restarts on crash)" : "off"}`);
    if (value.update?.available) {
      log(`  ↻ Update available: ${value.update.current} -> ${value.update.latest} (run: anything-obsidian update)`);
    }
  }
}

async function gitVersion(execFileImpl = execFileAsync) {
  try {
    const { stdout } = await execFileImpl("git", ["--version"]);
    return String(stdout).trim().replace(/^git version /, "git ");
  } catch {
    return null;
  }
}

function processKill(pid, signal) {
  process.kill(pid, signal);
}

async function runMcpFg({ store, env, spawnImpl, log, lan }) {
  const config = await loadConfigOrWarn(store, log);
  if (!config) return 1;
  await store.ensureLayout();

  const childEnv = {
    ...nativeEnv(config, store.paths, { env }),
    MCP_TRANSPORT: "http",
    MCP_PROFILE: lan ? "lan" : "local",
    ...(lan && config.lanToken ? { MCP_AUTH_TOKEN: config.lanToken } : {}),
  };
  if (lan && !config.lanToken) {
    log("LAN MCP requires a token. Run: anything-obsidian lan on");
    return 1;
  }
  await rotateLogs({ logsRoot: store.paths.logsRoot });
  if (env.AO_SUPERVISED) {
    process.title = lan ? "anything-obsidian-mcp-lan" : "anything-obsidian-mcp";
  }

  const mcpPath = path.join(path.dirname(path.dirname(realpathSync(process.argv[1]))), "mcp", "index.mjs");
  const child = spawnImpl(process.argv[0] || process.execPath, [mcpPath, "--http", ...(lan ? ["--lan"] : [])], {
    env: childEnv,
    stdio: "inherit",
  });
  const forward = (signal) => {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  };
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGINT", () => forward("SIGINT"));
  const code = await new Promise((resolve) => {
    child.on("error", () => resolve(1));
    child.on("close", resolve);
  });
  return code === 0 ? 0 : 1;
}

async function runLan({ subcommand, argument, store, env, log, json, launchctl, systemctl, platform }) {
  const config = await loadConfigOrWarn(store, log);
  if (!config) return 1;
  await store.ensureLayout();

  switch (subcommand) {
    case "token": {
      const token = String(argument ?? "").trim();
      if (!token) {
        log("Usage: anything-obsidian lan token <value>");
        return 2;
      }
      await store.save({ ...config, lanToken: token });
      log("LAN token saved.");
      log("Restart the LAN endpoint to apply it: anything-obsidian lan on");
      return 0;
    }
    case "on": {
      let effective = config;
      if (!config.lanToken) {
        const token = randomBytes(24).toString("base64url");
        effective = await store.save({ ...config, lanToken: token });
        log("Generated a LAN admin token (shown once, save it now):");
        log(`  ${token}`);
      }
      const manager = autostartManager({ store, env, log, launchctl, systemctl, platform });
      if (!manager) return 1;
      await manager.enableLan({
        mcpLanLogPath: store.paths.mcpLanLogPath || store.paths.schedulerLogPath,
      });
      log("LAN MCP is on at http://0.0.0.0:21444/mcp (RAG-only, Bearer token required).");
      log("Per-agent tokens from the dashboard also work; they see only allowlisted vaults.");
      return 0;
    }
    case "off": {
      const manager = autostartManager({ store, env, log, launchctl, systemctl, platform });
      if (!manager) return 1;
      await manager.disableLan();
      log("LAN MCP is off.");
      return 0;
    }
    case "status":
    default: {
      const manager = autostartManager({ store, env, log, launchctl, systemctl, platform });
      if (!manager) return 1;
      const enabled = await manager.lanEnabled();
      const state = enabled ? (await manager.status()).mcpLan : { loaded: false, running: false, pid: null };
      if (json) {
        log(JSON.stringify({ ok: true, lan: { enabled, ...state } }, null, 2));
        return 0;
      }
      log(`LAN MCP: ${enabled ? "on" : "off"}`);
      log(`  endpoint: ${state.running ? "running" : enabled ? "registered, not running" : "not registered"} (port 21444, RAG-only)`);
      log(`  token: ${config.lanToken ? "configured" : "not set (anything-obsidian lan on generates one)"}`);
      return 0;
    }
  }
}

async function runUpdate({ log, spawnImpl }) {
  const repo = process.env.ANYTHING_OBSIDIAN_REPO || "Lettucech/anything-obsidian";
  const branch = process.env.ANYTHING_OBSIDIAN_BRANCH || "main";
  const appRoot = process.env.ANYTHING_OBSIDIAN_APP_HOME || `${process.env.HOME}/.anything-obsidian`;
  const appDir = path.join(appRoot, "app");
  if (!existsSync(appDir)) {
    log("No managed install found. Run the installer instead:");
    log("  curl -fsSL https://raw.githubusercontent.com/" + repo + "/" + branch + "/install.sh | sh");
    return 1;
  }
  log(`Updating from github.com/${repo} (${branch})…`);
  const staging = path.join(appRoot, "download.update.$$");
  await mkdir(staging, { recursive: true });
  const curl = spawnImpl("curl", ["-fsSL", `https://github.com/${repo}/archive/refs/heads/${branch}.tar.gz`], { stdio: ["ignore", "pipe", "inherit"] });
  const tar = spawnImpl("tar", ["-xz", "-C", staging], { stdio: [curl.stdout, "ignore", "inherit"] });
  curl.stderr?.on("data", () => {});
  await new Promise((resolve, reject) => { curl.on("error", reject); tar.on("error", reject); tar.on("close", resolve); });
  const sourceDir = readdirSync(staging).map((entry) => path.join(staging, entry)).find((entry) => statSync(entry).isDirectory());
  if (!sourceDir) {
    log("Downloaded archive was empty.");
    return 1;
  }
  rmSync(appDir, { recursive: true, force: true });
  renameSync(sourceDir, appDir);
  rmSync(staging, { recursive: true, force: true });
  log("  ✓ app updated");
  const npmPath = path.join(path.dirname(process.argv[0] || process.execPath), "npm");
  const npm = spawnImpl(npmPath === "npm" ? process.execPath : npmPath, ["ci", "--omit=dev"], { cwd: appDir, stdio: "inherit" });
  const npmCode = await new Promise((resolve) => { npm.on("error", () => resolve(1)); npm.on("close", resolve); });
  if (npmCode !== 0) {
    log("  !! npm ci failed — MCP services may not start until you re-run the installer.");
  } else {
    log("  ✓ dependencies installed");
  }
  log("Restart services if autostart is on:");
  log("  anything-obsidian autostart off && anything-obsidian autostart on");
  return 0;
}

function openBrowser(url, { spawnImpl = spawn, platform = process.platform } = {}) {
  const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawnImpl(command, args, { detached: true, stdio: "ignore" });
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}

function parseFlags(args) {
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2);
    const value = args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : "";
    if (value) index += 1;
    flags[name] = value;
  }
  return flags;
}

function entryUrl() {
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return pathToFileURL(path.resolve(process.argv[1])).href;
  }
}

if (process.argv[1] && import.meta.url === entryUrl()) {
  process.exitCode = await runCli();
}
