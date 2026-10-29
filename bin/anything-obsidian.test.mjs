import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { nodeVersionProblem, runCli } from "./anything-obsidian.mjs";
import { createAppConfigStore } from "../lib/app-config.mjs";

const homes = [];
const servers = [];
after(async () => {
  await Promise.all(homes.map((dir) => rm(dir, { recursive: true, force: true })));
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
});

test("init writes the config non-interactively and validates AnythingLLM", async () => {
  const { home, output, url } = await setup({ workspaces: [] });
  const vaultsRoot = path.join(home, "ObsidianVaults");

  const exitCode = await runCli(
    ["init", "--vaults-root", vaultsRoot, "--url", url, "--api-key", "key-123"],
    { env: { ANYTHING_OBSIDIAN_HOME: configRoot(home) }, log: output.line },
  );

  assert.equal(exitCode, 0);
  const store = createAppConfigStore({ rootDir: configRoot(home) });
  const config = await store.load();
  assert.equal(config.vaultsRoot, vaultsRoot);
  assert.equal(config.anythingllmBaseUrl, url);
  assert.equal(config.apiKey, "key-123");
  assert.equal(config.dashboardPort, 21502);
  assert.equal(existsSync(vaultsRoot), true);
  assert.equal(existsSync(store.paths.secretsRoot), true);
  assert.equal(existsSync(path.dirname(store.paths.registryPath)), true);
  assert.equal((await stat(store.paths.configPath)).mode & 0o777, 0o600);
  assert.match(output.lines.join("\n"), /Setup complete/);
});

test("init fails with a clear message when AnythingLLM rejects the key", async () => {
  const { home, output, url } = await setup({ status: 401, body: { error: "bad key" } });

  const exitCode = await runCli(
    ["init", "--vaults-root", path.join(home, "Vaults"), "--url", url, "--api-key", "wrong"],
    { env: { ANYTHING_OBSIDIAN_HOME: configRoot(home) }, log: output.line },
  );

  assert.equal(exitCode, 1);
  assert.match(output.lines.join("\n"), /Could not connect/);
  const store = createAppConfigStore({ rootDir: configRoot(home) });
  assert.equal(await store.load(), null);
});

test("init prompts interactively and warns before accepting a Documents vault root", async () => {
  const { home, output, url } = await setup({ workspaces: [] });
  const confirmCalls = [];
  const promptFactory = (io) => ({
    async question(text, fallback) {
      return script.shift() ?? fallback;
    },
    async confirm(text, fallback) {
      confirmCalls.push(text);
      return script.shift() ?? fallback;
    },
    close() {},
  });
  const script = [
    path.join(home, "Documents", "Vaults"), // vault root question: TCC-protected attempt
    false, // confirm: decline
    path.join(home, "ObsidianVaults"), // vault root question: safe root
    "1", // connect mode: direct AnythingLLM
    "key-123", // api key question
  ];

  const exitCode = await runCli(["init", "--url", url], {
    env: { ANYTHING_OBSIDIAN_HOME: configRoot(home), HOME: home },
    promptFactory,
    log: output.line,
  });

  assert.equal(exitCode, 0);
  assert.equal(confirmCalls.length, 1);
  assert.match(confirmCalls[0], /permission prompts/);
  const store = createAppConfigStore({ rootDir: configRoot(home) });
  const config = await store.load();
  assert.equal(config.vaultsRoot, path.join(home, "ObsidianVaults"));
  assert.equal(config.apiKey, "key-123");
});

test("start-bg records a scheduler pid and stop clears it", async () => {
  const { home, output } = await setup({});
  await preinitializedStore(home);
  const vaultsRoot = path.join(home, "Vaults");
  const spawned = [];
  const alive = new Set([6101]);
  const killImpl = (pid, signal) => {
    if (signal !== 0) {
      alive.delete(pid);
      return;
    }
    if (!alive.has(pid)) {
      const error = new Error("ESRCH");
      error.code = "ESRCH";
      throw error;
    }
  };
  const cliDeps = () => ({
    // HOME must stay inside the fixture: otherwise the autostart manager
    // finds this machine's real LaunchAgents and the CLI takes a different path.
    env: { ANYTHING_OBSIDIAN_HOME: configRoot(home), HOME: home },
    killImpl,
    log: output.line,
  });

  const started = await runCli(["start-bg"], {
    ...cliDeps(),
    spawnImpl: (command, args, options) => {
      spawned.push({ command, args, options });
      return { pid: 6101, unref() {} };
    },
  });

  assert.equal(started, 0);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, process.execPath);
  assert.equal(spawned[0].options.detached, true);
  assert.equal(spawned[0].options.env.VAULTS_ROOT, vaultsRoot);
  const paths = createAppConfigStore({ rootDir: configRoot(home) }).paths;
  assert.equal(readFileSync(paths.schedulerPidPath, "utf8"), "6101\n");
  assert.match(output.lines.join("\n"), /Scheduler started \(pid 6101\)/);

  output.lines.length = 0;
  const again = await runCli(["start-bg"], {
    ...cliDeps(),
    spawnImpl: () => {
      throw new Error("should not spawn twice");
    },
  });
  assert.equal(again, 0);
  assert.match(output.lines.join("\n"), /already running/);

  output.lines.length = 0;
  const stopped = await runCli(["stop"], cliDeps());
  assert.equal(stopped, 0);
  assert.match(output.lines.join("\n"), /Scheduler stopped \(pid 6101\)/);
  assert.equal(existsSync(paths.schedulerPidPath), false);

  output.lines.length = 0;
  const stopAgain = await runCli(["stop"], cliDeps());
  assert.equal(stopAgain, 0);
  assert.match(output.lines.join("\n"), /Scheduler is not running/);
});

test("commands without initialization explain how to fix it", async () => {
  const { home, output } = await setup({});

  for (const command of ["start", "start-bg", "stop"]) {
    output.lines.length = 0;
    const exitCode = await runCli([command], {
      env: { ANYTHING_OBSIDIAN_HOME: configRoot(home) },
      log: output.line,
    });
    assert.equal(exitCode, 1, `${command} should fail before init`);
    assert.match(output.lines.join("\n"), /anything-obsidian init/);
  }
});

test("unknown commands print usage", async () => {
  const { home, output } = await setup({});
  assert.equal(await runCli(["bogus"], { env: { ANYTHING_OBSIDIAN_HOME: configRoot(home) }, log: output.line }), 2);
  assert.match(output.lines.join("\n"), /Usage: anything-obsidian/);
  assert.equal(await runCli(["--help"], { env: {}, log: output.line }), 0);
});

function configRoot(home) {
  return path.join(home, "app-support");
}

async function preinitializedStore(home) {
  const store = createAppConfigStore({ rootDir: configRoot(home) });
  await store.save({
    vaultsRoot: path.join(home, "Vaults"),
    anythingllmBaseUrl: "http://localhost:11301",
    apiKey: "key",
  });
  return store;
}

async function setup({ status = 200, body = { workspaces: [] } } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "anything-obsidian-cli-"));
  homes.push(home);
  const server = createServer((req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const url = `http://127.0.0.1:${server.address().port}`;
  const output = { lines: [], line: (text) => output.lines.push(text) };
  return { home, output, url, server };
}

test("status --json reports an unconfigured install and exits 1", async () => {
  const { home, output } = await setup({});
  const log = (line) => output.lines.push(line);

  const exitCode = await runCli(["status", "--json"], {
    env: { ANYTHING_OBSIDIAN_HOME: configRoot(home), PATH: process.env.PATH, HOME: home },
    log,
  });

  assert.equal(exitCode, 1);
  const report = JSON.parse(output.lines.join("\n"));
  assert.equal(report.ok, false);
  assert.equal(report.config, null);
  assert.match(report.anythingllm.detail, /not configured/);
});

test("status --json reports a configured install with service health", async () => {
  const { home, output, url } = await setup({ body: { workspaces: [{ id: 1, name: "W", slug: "w" }] } });
  const vaultsRoot = path.join(home, "Vaults");
  await runCli(
    ["init", "--vaults-root", vaultsRoot, "--url", url, "--api-key", "key-123"],
    { env: { ANYTHING_OBSIDIAN_HOME: configRoot(home), PATH: process.env.PATH, HOME: home }, log: output.line },
  );

  const exitCode = await runCli(["status", "--json"], {
    env: { ANYTHING_OBSIDIAN_HOME: configRoot(home), PATH: process.env.PATH, HOME: home },
    log: output.line,
  });

  assert.equal(exitCode, 0);
  const report = JSON.parse(output.lines.at(-1));
  assert.equal(report.ok, true);
  assert.equal(report.config.vaultsRoot, vaultsRoot);
  assert.equal(report.anythingllm.ok, true);
  assert.equal(report.anythingllm.workspaces, 1);
  assert.equal(report.dashboard.running, false);
  assert.equal(report.scheduler.running, false);
  assert.equal(report.vaults, 0);
  assert.equal(report.workspace, null);
  assert.match(report.git, /^git /);
});

test("human status is not machine JSON and still exits 0 when healthy", async () => {
  const { home, output, url } = await setup({ workspaces: [] });
  await runCli(
    ["init", "--vaults-root", path.join(home, "Vaults"), "--url", url, "--api-key", "k"],
    { env: { ANYTHING_OBSIDIAN_HOME: configRoot(home), PATH: process.env.PATH, HOME: home }, log: output.line },
  );
  output.lines.length = 0;

  const exitCode = await runCli(["status"], {
    env: { ANYTHING_OBSIDIAN_HOME: configRoot(home), PATH: process.env.PATH, HOME: home },
    log: output.line,
  });

  assert.equal(exitCode, 0);
  const text = output.lines.join("\n");
  assert.match(text, /Anything Obsidian status/);
  assert.match(text, /AnythingLLM: http/);
  assert.doesNotMatch(text, /^\s*\{/m);
});

test("start --bg serves the dashboard, records a pid, and stop tears it down", async () => {
  const { home, output, url } = await setup({ workspaces: [] });
  const dashboardPort = 20000 + Math.floor(Math.random() * 20000);
  const env = { ANYTHING_OBSIDIAN_HOME: configRoot(home), PATH: process.env.PATH, HOME: home };
  await runCli(
    ["init", "--vaults-root", path.join(home, "Vaults"), "--url", url, "--api-key", "k", "--port", String(dashboardPort)],
    { env, log: output.line },
  );

  const started = await runCli(["start", "--bg", "--no-browser"], {
    env,
    spawnImpl: (command, args, options) => spawn(command, args, options),
    log: output.line,
  });
  assert.equal(started, 0);
  assert.match(output.lines.join("\n"), /Dashboard running at/);

  const store = createAppConfigStore({ rootDir: configRoot(home) });
  const pid = Number.parseInt(readFileSync(store.paths.dashboardPidPath, "utf8"), 10);
  const status = await runCli(["status", "--json"], { env, log: output.line });
  assert.equal(status, 0);
  const report = JSON.parse(output.lines.at(-1));
  assert.equal(report.dashboard.running, true);
  assert.equal(report.dashboard.pid, pid);
  assert.equal(report.dashboard.healthy, true);

  const stopped = await runCli(["stop"], { env, log: output.line });
  assert.equal(stopped, 0);
  assert.match(output.lines.join("\n"), /Dashboard stopped/);
  await waitForPidExit(pid);
  assert.equal(existsSync(store.paths.dashboardPidPath), false);
});

async function waitForPidExit(pid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`pid ${pid} did not exit`);
}

function fakeLaunchctl(tracker, { runningLabels = [] } = {}) {
  return async (args) => {
    tracker.push(args);
    if (args[0] === "bootstrap") return { stdout: "", stderr: "" };
    if (args[0] === "kickstart") return { stdout: "", stderr: "" };
    if (args[0] === "bootout") return { stdout: "", stderr: "" };
    if (args[0] === "print") {
      const label = args[1].split("/").at(-1);
      if (runningLabels.includes(label)) {
        return { stdout: `\t"state" = "running"\n\t"pid" = 4321\n`, stderr: "" };
      }
      throw new Error("Could not find service");
    }
    return { stdout: "", stderr: "" };
  };
}

async function initializedEnv(home, url) {
  const env = { ANYTHING_OBSIDIAN_HOME: configRoot(home), PATH: process.env.PATH, HOME: home };
  await runCli(
    ["init", "--vaults-root", path.join(home, "Vaults"), "--url", url, "--api-key", "k"],
    { env, log: () => {} },
  );
  return env;
}

test("autostart on writes plists, kickstarts launchd, and off tears it down", async () => {
  const { home, url } = await setup({});
  const env = await initializedEnv(home, url);
  const tracker = [];
  const output = { lines: [], line: (l) => output.lines.push(l) };
  const deps = { env, log: output.line, launchctl: fakeLaunchctl(tracker) };

  assert.equal(await runCli(["autostart", "on"], deps), 0);
  const paths = createAppConfigStore({ rootDir: configRoot(home) }).paths;
  const launchAgents = path.join(home, "Library", "LaunchAgents");
  assert.equal(existsSync(path.join(launchAgents, "app.anything-obsidian.dashboard.plist")), true);
  assert.equal(existsSync(path.join(launchAgents, "app.anything-obsidian.scheduler.plist")), true);
  const dashboardPlist = readFileSync(path.join(launchAgents, "app.anything-obsidian.dashboard.plist"), "utf8");
  assert.match(dashboardPlist, /<string>--no-browser<\/string>/);
  assert.match(dashboardPlist, new RegExp(paths.logsRoot.replaceAll("/", "\\/")));
  assert.equal(tracker.filter((args) => args[0] === "kickstart").length, 3);
  assert.match(output.lines.join("\n"), /Autostart is on/);

  tracker.length = 0;
  assert.equal(await runCli(["autostart", "off"], deps), 0);
  assert.equal(tracker.filter((args) => args[0] === "bootout").length, 4);
  assert.equal(existsSync(path.join(launchAgents, "app.anything-obsidian.dashboard.plist")), false);
  assert.match(output.lines.join("\n"), /Autostart is off/);
});

test("autostart status reports plist state without launchd calls when off", async () => {
  const { home, url } = await setup({});
  const env = await initializedEnv(home, url);
  const tracker = [];
  const output = { lines: [], line: (l) => output.lines.push(l) };

  assert.equal(await runCli(["autostart", "status"], {
    env, log: output.line, launchctl: fakeLaunchctl(tracker),
  }), 0);
  assert.deepEqual(tracker, []);
  assert.match(output.lines.join("\n"), /Autostart: off/);

  output.lines.length = 0;
  assert.equal(await runCli(["autostart", "status", "--json"], {
    env, log: output.line, launchctl: fakeLaunchctl(tracker, { runningLabels: [] }),
  }), 0);
  const report = JSON.parse(output.lines.at(-1));
  assert.equal(report.autostart.enabled, false);
});

test("autostart status reads launchd state when enabled", async () => {
  const { home, url } = await setup({});
  const env = await initializedEnv(home, url);
  const tracker = [];
  const output = { lines: [], line: (l) => output.lines.push(l) };
  const deps = { env, log: output.line, launchctl: fakeLaunchctl(tracker, { runningLabels: ["app.anything-obsidian.dashboard"] }) };

  await runCli(["autostart", "on"], deps);
  output.lines.length = 0;
  assert.equal(await runCli(["autostart", "status", "--json"], deps), 0);
  const report = JSON.parse(output.lines.at(-1));
  assert.equal(report.autostart.enabled, true);
  assert.equal(report.autostart.dashboard.running, true);
  assert.equal(report.autostart.dashboard.pid, 4321);
  assert.equal(report.autostart.scheduler.running, false);
});

test("stop with autostart on unloads launchd services instead of pid files", async () => {
  const { home, url } = await setup({});
  const env = await initializedEnv(home, url);
  const tracker = [];
  const output = { lines: [], line: (l) => output.lines.push(l) };
  const deps = { env, log: output.line, launchctl: fakeLaunchctl(tracker) };

  await runCli(["autostart", "on"], deps);
  tracker.length = 0;
  output.lines.length = 0;

  assert.equal(await runCli(["stop"], deps), 0);
  assert.equal(tracker.filter((args) => args[0] === "bootout").length, 4);
  const text = output.lines.join("\n");
  assert.match(text, /stopped \(autostart services unloaded\)/);
  assert.match(text, /autostart off/);
  assert.equal(existsSync(path.join(home, "Library", "LaunchAgents", "app.anything-obsidian.dashboard.plist")), true);
});

test("start --bg with autostart on goes through launchd instead of a pid file", async () => {
  const { home, url } = await setup({});
  const env = await initializedEnv(home, url);
  const tracker = [];
  const output = { lines: [], line: (l) => output.lines.push(l) };
  const deps = { env, log: output.line, launchctl: fakeLaunchctl(tracker) };

  await runCli(["autostart", "on"], deps);
  tracker.length = 0;
  output.lines.length = 0;

  assert.equal(await runCli(["start", "--bg", "--no-browser"], deps), 0);
  assert.equal(tracker.filter((args) => args[0] === "kickstart").length, 3);
  assert.match(output.lines.join("\n"), /managed by launchd/);
  const paths = createAppConfigStore({ rootDir: configRoot(home) }).paths;
  assert.equal(existsSync(paths.dashboardPidPath), false);
});

test("status --json includes autostart and uses launchd state when enabled", async () => {
  const { home, url } = await setup({ body: { workspaces: [] } });
  const env = await initializedEnv(home, url);
  const tracker = [];
  const output = { lines: [], line: (l) => output.lines.push(l) };
  const deps = { env, log: output.line, launchctl: fakeLaunchctl(tracker, { runningLabels: ["app.anything-obsidian.dashboard"] }) };

  await runCli(["autostart", "on"], deps);
  output.lines.length = 0;
  assert.equal(await runCli(["status", "--json"], deps), 0);
  const report = JSON.parse(output.lines.at(-1));
  assert.equal(report.autostart.enabled, true);
  assert.equal(report.autostart.dashboard.running, true);
  assert.equal(report.dashboard.running, true);
  assert.equal(report.scheduler.running, false);
});

function fakeSystemctl(tracker, { activeStates = {} } = {}) {
  return async (args) => {
    tracker.push(args);
    if (args[1] === "show") {
      const unit = args[2];
      const state = activeStates[unit] ?? "inactive";
      return { stdout: `ActiveState=${state}\nMainPID=${state === "active" ? 2468 : 0}\n`, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
}

test("autostart on linux uses systemd units instead of launchd plists", async () => {
  const { home, url } = await setup({});
  const env = await initializedEnv(home, url);
  const tracker = [];
  const output = { lines: [], line: (l) => output.lines.push(l) };
  const deps = { env, log: output.line, platform: "linux", systemctl: fakeSystemctl(tracker) };

  assert.equal(await runCli(["autostart", "on"], deps), 0);
  const unitDir = path.join(home, ".config", "systemd", "user");
  assert.equal(existsSync(path.join(unitDir, "anything-obsidian-dashboard.service")), true);
  assert.equal(existsSync(path.join(unitDir, "anything-obsidian-scheduler.service")), true);
  const dashboard = readFileSync(path.join(unitDir, "anything-obsidian-dashboard.service"), "utf8");
  assert.match(dashboard, /ExecStart=/);
  assert.match(dashboard, /Restart=always/);
  assert.equal(tracker.filter((args) => args[1] === "enable").length, 3);

  output.lines.length = 0;
  assert.equal(await runCli(["autostart", "status", "--json"], deps), 0);
  const report = JSON.parse(output.lines.at(-1));
  assert.equal(report.autostart.enabled, true);

  output.lines.length = 0;
  assert.equal(await runCli(["stop"], deps), 0);
  assert.equal(tracker.filter((args) => args[1] === "stop").length, 4);
  assert.match(output.lines.join("\n"), /autostart services unloaded/);
});

test("autostart is unavailable on unsupported platforms", async () => {
  const { home, url } = await setup({});
  const env = await initializedEnv(home, url);
  const output = { lines: [], line: (l) => output.lines.push(l) };

  assert.equal(await runCli(["autostart", "on"], {
    env, log: output.line, platform: "win32",
  }), 1);
  assert.match(output.lines.join("\n"), /not supported on win32/);
});

test("nodeVersionProblem accepts supported runtimes and rejects older ones", () => {
  assert.equal(nodeVersionProblem("22.14.0"), null);
  assert.equal(nodeVersionProblem("24.1.0"), null);
  assert.match(nodeVersionProblem("20.11.1"), /needs Node\.js >= 22 \(found 20\.11\.1\)/);
  assert.match(nodeVersionProblem("18.20.0"), /install\.sh installs a managed Node runtime/);
  assert.match(nodeVersionProblem(""), /needs Node\.js >= 22/);
  assert.match(nodeVersionProblem("nonsense"), /needs Node\.js >= 22 \(found nonsense\)/);
});

test("the CLI refuses real commands on an unsupported runtime", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "ao-cli-"));
  homes.push(home);
  const output = { lines: [], line: (l) => output.lines.push(l) };

  const code = await runCli(["status"], {
    env: { ANYTHING_OBSIDIAN_HOME: home, PATH: process.env.PATH, HOME: home },
    log: output.line,
    nodeVersion: "18.20.0",
  });

  assert.equal(code, 1);
  assert.match(output.lines.join("\n"), /needs Node\.js >= 22 \(found 18\.20\.0\)/);
  assert.match(output.lines.join("\n"), /install\.sh installs a managed Node runtime/);
});

test("--help still works on an unsupported runtime", async () => {
  const output = { lines: [], line: (l) => output.lines.push(l) };

  assert.equal(await runCli(["--help"], { log: output.line, nodeVersion: "18.20.0" }), 0);
  assert.match(output.lines.join("\n"), /Usage: anything-obsidian/);
});

test("gateway --bg serves both planes on ephemeral ports and stop tears it down", async () => {
  const { home, output, url } = await setup({ workspaces: [] });
  const publicPort = 23000 + Math.floor(Math.random() * 5000);
  const adminPort = publicPort + 1;
  const env = {
    ANYTHING_OBSIDIAN_HOME: configRoot(home),
    PATH: process.env.PATH,
    HOME: home,
    GATEWAY_PORT: String(publicPort),
    GATEWAY_ADMIN_PORT: String(adminPort),
  };
  await runCli(
    ["init", "--vaults-root", path.join(home, "Vaults"), "--url", url, "--api-key", "k"],
    { env, log: output.line },
  );

  const started = await runCli(["gateway", "--bg"], {
    env,
    spawnImpl: (command, args, options) => spawn(command, args, options),
    log: output.line,
  });
  assert.equal(started, 0);
  assert.match(output.lines.join("\n"), /Gateway is running/);

  const health = await fetch(`${adminPort === 0 ? "" : `http://127.0.0.1:${adminPort}`}/health`);
  const report = await health.json();
  assert.equal(report.name, "any-obs-gateway");
  assert.equal(report.plane, "admin");

  const store = createAppConfigStore({ rootDir: configRoot(home) });
  const pid = Number.parseInt(readFileSync(path.join(store.paths.runRoot, "gateway.pid"), "utf8"), 10);
  assert.ok(pid > 0);

  const stopped = await runCli(["gateway", "stop"], { env, log: output.line });
  assert.equal(stopped, 0);
  assert.match(output.lines.join("\n"), /Stopped gateway/);
  await waitForPidExit(pid);
  assert.equal(existsSync(path.join(store.paths.runRoot, "gateway.pid")), false);
});

test("init --server skips the role question, defaults the vault root, and records the mode", async () => {
  const { home, output, url } = await setup({ workspaces: [] });
  const env = { ANYTHING_OBSIDIAN_HOME: configRoot(home), PATH: process.env.PATH, HOME: home };

  const exitCode = await runCli(
    ["init", "--server", "--url", url, "--api-key", "developer-key"],
    { env, log: output.line },
  );

  assert.equal(exitCode, 0);
  const text = output.lines.join("\n");
  assert.match(text, /Server install/);
  assert.doesNotMatch(text, /Connect this any-obs to/);

  const config = await createAppConfigStore({ rootDir: configRoot(home) }).load();
  assert.equal(config.mode, "server");
  // The vault root is defaulted, not prompted.
  assert.ok(config.vaultsRoot.endsWith("vaults"));
});

test("client installs still default to client mode", async () => {
  const { home, output, url } = await setup({ workspaces: [] });
  await runCli(
    ["init", "--vaults-root", path.join(home, "Vaults"), "--url", url, "--api-key", "k"],
    { env: { ANYTHING_OBSIDIAN_HOME: configRoot(home), PATH: process.env.PATH, HOME: home }, log: output.line },
  );
  const config = await createAppConfigStore({ rootDir: configRoot(home) }).load();
  assert.equal(config.mode, "client");
});

test("a client init on a gateway machine keeps mode=server and rewrites only the client config", async () => {
  const { home, output, url } = await setup({ workspaces: [] });
  const env = { ANYTHING_OBSIDIAN_HOME: configRoot(home), PATH: process.env.PATH, HOME: home };

  // The admin installed the server first.
  await runCli(["init", "--server", "--url", url, "--api-key", "developer-key"], { env, log: output.line });

  // Later, a client install overwrites the client config (answered yes).
  const confirmCalls = [];
  const promptFactory = () => ({
    async question(text, fallback) { return script.shift() ?? fallback; },
    async confirm(text, fallback) {
      confirmCalls.push({ text, answer: script.shift() ?? fallback });
      return confirmCalls.at(-1).answer;
    },
    close() {},
  });
  const script = [
    "1", // connect mode: direct
    "client-token", // api key
  ];
  const exitCode = await runCli(
    ["init", "--vaults-root", path.join(home, "Vaults"), "--url", url, "--api-key", "client-token"],
    { env, promptFactory, log: output.line },
  );

  assert.equal(exitCode, 0);
  const config = await createAppConfigStore({ rootDir: configRoot(home) }).load();
  // Client values win…
  assert.equal(config.anythingllmBaseUrl, url);
  assert.equal(config.apiKey, "client-token");
  // …but the server mode marker survives: `stop` must still tear the gateway down.
  assert.equal(config.mode, "server");
});
