#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { createAnythingllmClient } from "../dashboard/anythingllm.mjs";
import { createDashboardServer } from "../dashboard/server.mjs";
import {
  createLocalJobManager,
  startDashboardProcess,
  startSchedulerProcess,
  stopSchedulerProcess,
  readSchedulerStatus,
  tailLogFile,
  waitForHttp,
} from "../dashboard/local-jobs.mjs";
import { createAppConfigStore, defaultConfigRoot, expandTilde, nativeEnv } from "../lib/app-config.mjs";
import { createVaultRegistry } from "../lib/vault-registry.mjs";

const execFileAsync = promisify(execFile);
const USAGE = `Usage: anything-obsidian <command>

Commands:
  init       One-time setup: vault root, AnythingLLM URL and API key
  start      Run the dashboard in the foreground and open it in a browser
  start-bg   Start the background sync scheduler
  stop       Stop the dashboard (if backgrounded) and the sync scheduler
  status     Show install, config, and service health (--json for agents)

Options:
  --vaults-root <path>       Vault root directory (init)
  --url <url>                AnythingLLM base URL (init)
  --api-key <key>            AnythingLLM API key (init)
  --port <number>            Dashboard port, default 11400 (init)
  --bg                       Start the dashboard in the background (start)
  --no-browser               Do not open the browser (start)
  --json                     Machine-readable output (status)
  --help                     Show this help

Init flags make setup non-interactive: when all of --vaults-root, --url,
and --api-key are provided, no prompts are shown.`;

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

  switch (command) {
    case "init":
      return runInit({ flags, store, env, io, fetchImpl, log, promptFactory: deps.promptFactory });
    case "start":
      return runStart({ store, env, spawnImpl, fetchImpl, log, background: "bg" in flags, noBrowser: "no-browser" in flags });
    case "start-bg":
      return runStartBg({ store, env, spawnImpl, killImpl, log });
    case "stop":
      return runStop({ store, killImpl, log });
    case "status":
      return runStatus({ store, env, fetchImpl, execFileImpl, log, json: "json" in flags });
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
    const anythingllmBaseUrl = flags.url || await prompt.question(`AnythingLLM base URL [http://localhost:11301] `, "http://localhost:11301");
    const apiKey = flags["api-key"] || await prompt.question("AnythingLLM API key: ", "");
    const dashboardPort = Number(flags.port || 11400);

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
      dashboardPort: Number.isInteger(dashboardPort) ? dashboardPort : 11400,
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

async function runStart({ store, env, spawnImpl, fetchImpl, log, background, noBrowser }) {
  const config = await loadConfigOrWarn(store, log);
  if (!config) return 1;
  await store.ensureLayout();

  const childEnv = { ...nativeEnv(config, store.paths, { env }), AO_MODE: "native" };
  const url = `http://localhost:${config.dashboardPort}`;

  if (background) {
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
    if (!noBrowser) openBrowser(url, { spawnImpl });
    return 0;
  }

  const server = createDashboardServer({
    mode: "native",
    env: childEnv,
    jobs: createLocalJobManager({ env: childEnv }),
    native: {
      schedulerPidPath: store.paths.schedulerPidPath,
      schedulerLogPath: store.paths.schedulerLogPath,
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

async function runStop({ store, killImpl, log }) {
  const config = await loadConfigOrWarn(store, log);
  if (!config) return 1;

  let exitCode = 0;
  const dashboard = await stopSchedulerProcess({ pidPath: store.paths.dashboardPidPath, killImpl });
  log(dashboard.stopped ? `Dashboard stopped (pid ${dashboard.pid}).` : "Dashboard is not running.");
  const scheduler = await stopSchedulerProcess({ pidPath: store.paths.schedulerPidPath, killImpl });
  log(scheduler.stopped ? `Scheduler stopped (pid ${scheduler.pid}).` : "Scheduler is not running.");
  return exitCode;
}

async function runStatus({ store, env, fetchImpl, execFileImpl, log, json }) {
  const config = await store.load();
  const report = {
    ok: false,
    platform: process.platform,
    node: process.version.replace(/^v/, ""),
    git: null,
    config: null,
    anythingllm: { ok: false, detail: "not configured" },
    dashboard: { running: false, pid: null, healthy: false, url: null },
    scheduler: { running: false, pid: null },
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

  const dashboard = readSchedulerStatus({ pidPath: store.paths.dashboardPidPath, killImpl: processKill });
  let dashboardHealthy = false;
  if (dashboard.running) {
    try {
      const response = await fetchImpl(`http://127.0.0.1:${config.dashboardPort}/api/status`);
      dashboardHealthy = response.ok;
    } catch {
      dashboardHealthy = false;
    }
  }
  report.dashboard = { running: dashboard.running, pid: dashboard.pid, healthy: dashboardHealthy, url: dashboardUrl };

  const scheduler = readSchedulerStatus({ pidPath: store.paths.schedulerPidPath, killImpl: processKill });
  report.scheduler = { running: scheduler.running, pid: scheduler.pid };

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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runCli();
}
