import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DASHBOARD_LABEL,
  MCP_LABEL,
  MCP_LAN_LABEL,
  SCHEDULER_LABEL,
  buildPlistXml,
  createAutostartManager,
  dashboardProgramArguments,
  plistPath,
  schedulerProgramArguments,
} from "./autostart.mjs";

test("plist xml carries label, arguments, keep-alive, logs, and environment", () => {
  const xml = buildPlistXml({
    label: DASHBOARD_LABEL,
    programArguments: ["/usr/bin/node", "/app/bin/anything-obsidian.mjs", "start", "--no-browser"],
    logPath: "/logs/dashboard.log",
    environment: { PATH: "/usr/bin:/bin", ANYTHING_OBSIDIAN_HOME: "/data with space" },
  });

  assert.match(xml, new RegExp(`<string>${DASHBOARD_LABEL}</string>`));
  assert.match(xml, /<string>\/usr\/bin\/node<\/string>/);
  assert.match(xml, /<string>--no-browser<\/string>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<key>StandardOutPath<\/key>\s*<string>\/logs\/dashboard\.log<\/string>/);
  assert.match(xml, /<key>StandardErrorPath<\/key>\s*<string>\/logs\/dashboard\.log<\/string>/);
  assert.match(xml, /<string>\/data with space<\/string>/);
  assert.doesNotMatch(xml, /& (?!amp;|lt;|gt;)/);
});

test("program arguments target the CLI entry with foreground commands", () => {
  assert.deepEqual(
    dashboardProgramArguments({ nodePath: "/node", cliPath: "/cli.mjs" }),
    ["/node", "/cli.mjs", "start", "--no-browser"],
  );
  assert.deepEqual(
    schedulerProgramArguments({ nodePath: "/node", cliPath: "/cli.mjs" }),
    ["/node", "/cli.mjs", "scheduler-fg"],
  );
});

test("enable writes both plists and bootstraps with kickstart", async () => {
  const homedir = freshDir();
  const calls = [];
  const manager = createAutostartManager({
    homedir,
    uid: 501,
    logsRoot: path.join(homedir, "logs"),
    environment: { PATH: "/usr/bin:/bin" },
    launchctl: async (args) => {
      calls.push(args);
      if (args[0] === "print") throw new Error("not loaded");
      return { stdout: "", stderr: "" };
    },
  });

  await manager.enable({
    dashboardLogPath: path.join(homedir, "logs", "dashboard.log"),
    schedulerLogPath: path.join(homedir, "logs", "scheduler.log"),
  });

  const dashboardPlist = readFileSync(plistPath(DASHBOARD_LABEL, { homedir }), "utf8");
  assert.match(dashboardPlist, new RegExp(DASHBOARD_LABEL));
  assert.match(dashboardPlist, /start --no-browser|<string>--no-browser<\/string>/);
  assert.match(dashboardPlist, /<key>AO_SUPERVISED<\/key>\s*<string>1<\/string>/);
  const schedulerPlist = readFileSync(plistPath(SCHEDULER_LABEL, { homedir }), "utf8");
  assert.match(schedulerPlist, new RegExp(SCHEDULER_LABEL));
  assert.match(schedulerPlist, /<string>scheduler-fg<\/string>/);

  const bootstraps = calls.filter((args) => args[0] === "bootstrap");
  assert.equal(bootstraps.length, 3);
  assert.deepEqual(bootstraps[0], ["bootstrap", "gui/501", plistPath(DASHBOARD_LABEL, { homedir })]);
  const kickstarts = calls.filter((args) => args[0] === "kickstart");
  assert.equal(kickstarts.length, 3);
  assert.deepEqual(kickstarts[0], ["kickstart", "-k", `gui/501/${DASHBOARD_LABEL}`]);
});

test("bootstrap falls back to kickstart when the service is already bootstrapped", async () => {
  const homedir = freshDir();
  const calls = [];
  const manager = createAutostartManager({
    homedir,
    uid: 501,
    logsRoot: path.join(homedir, "logs"),
    launchctl: async (args) => {
      calls.push(args);
      if (args[0] === "bootstrap") throw new Error("Bootstrap failed: 5: Input/output error");
      return { stdout: "", stderr: "" };
    },
  });

  await manager.enable({
    dashboardLogPath: path.join(homedir, "logs", "dashboard.log"),
    schedulerLogPath: path.join(homedir, "logs", "scheduler.log"),
  });

  assert.equal(calls.filter((args) => args[0] === "kickstart").length, 3);
});

test("disable bootouts both labels and removes the plists", async () => {
  const homedir = freshDir();
  const calls = [];
  const manager = createAutostartManager({
    homedir,
    uid: 501,
    logsRoot: path.join(homedir, "logs"),
    launchctl: async (args) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    },
  });
  await manager.enable({
    dashboardLogPath: path.join(homedir, "logs", "dashboard.log"),
    schedulerLogPath: path.join(homedir, "logs", "scheduler.log"),
  });
  calls.length = 0;

  await manager.disable();

  const bootouts = calls.filter((args) => args[0] === "bootout");
  assert.deepEqual(bootouts, [
    ["bootout", `gui/501/${DASHBOARD_LABEL}`],
    ["bootout", `gui/501/${SCHEDULER_LABEL}`],
    ["bootout", `gui/501/${MCP_LABEL}`],
    ["bootout", `gui/501/${MCP_LAN_LABEL}`],
  ]);
  assert.equal(existsSync(plistPath(DASHBOARD_LABEL, { homedir })), false);
  assert.equal(existsSync(plistPath(SCHEDULER_LABEL, { homedir })), false);
  assert.equal(existsSync(plistPath(MCP_LABEL, { homedir })), false);
  assert.equal(existsSync(plistPath(MCP_LAN_LABEL, { homedir })), false);
});

test("disable tolerates services that are not loaded", async () => {
  const homedir = freshDir();
  const manager = createAutostartManager({
    homedir,
    uid: 501,
    logsRoot: path.join(homedir, "logs"),
    launchctl: async (args) => {
      if (args[0] === "bootout") throw new Error("Boot-out failed: 3: No such process");
      return { stdout: "", stderr: "" };
    },
  });

  await manager.disable();
  assert.equal(existsSync(plistPath(DASHBOARD_LABEL, { homedir })), false);
});

test("status parses pid and state from launchctl print", async () => {
  const homedir = freshDir();
  const manager = createAutostartManager({
    homedir,
    uid: 501,
    logsRoot: path.join(homedir, "logs"),
    launchctl: async (args) => {
      if (args[1] === `gui/501/${DASHBOARD_LABEL}`) {
        return { stdout: '…\t"state" = "running"\n\t"pid" = 4242\n…', stderr: "" };
      }
      throw new Error("Could not find service");
    },
  });

  const state = await manager.status();
  assert.deepEqual(state.dashboard, { loaded: true, running: true, pid: 4242 });
  assert.deepEqual(state.scheduler, { loaded: false, running: false, pid: null });
});

test("enabled reflects plist existence", async () => {
  const homedir = freshDir();
  const manager = createAutostartManager({
    homedir,
    uid: 501,
    logsRoot: path.join(homedir, "logs"),
    launchctl: async () => ({ stdout: "", stderr: "" }),
  });

  assert.equal(await manager.enabled(), false);
  await manager.enable({
    dashboardLogPath: path.join(homedir, "logs", "dashboard.log"),
    schedulerLogPath: path.join(homedir, "logs", "scheduler.log"),
  });
  assert.equal(await manager.enabled(), true);
});

function freshDir() {
  const dir = path.join(tmpdir(), `anything-obsidian-autostart-${process.pid}-${Math.random().toString(36).slice(2)}`);
  rmSync(dir, { recursive: true, force: true });
  return dir;
}
