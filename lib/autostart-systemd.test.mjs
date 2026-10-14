import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import {
  DASHBOARD_UNIT,
  SCHEDULER_UNIT,
  buildUnitFile,
  createServiceManager,
  createSystemdManager,
  unitPath,
} from "./autostart.mjs";

const dirs = [];
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

function freshDir() {
  const dir = path.join(tmpdir(), `anything-obsidian-systemd-${process.pid}-${Math.random().toString(36).slice(2)}`);
  rmSync(dir, { recursive: true, force: true });
  dirs.push(dir);
  return dir;
}

function fakeSystemctl(tracker, { activeUnits = [] } = {}) {
  return async (args) => {
    tracker.push(args);
    if (args[1] === "show") {
      const unit = args[2];
      if (activeUnits.includes(unit)) {
        return { stdout: "ActiveState=active\nMainPID=5678\n", stderr: "" };
      }
      return { stdout: "ActiveState=inactive\nMainPID=0\n", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
}

test("unit file carries description, exec, restart policy, logs, and environment", () => {
  const file = buildUnitFile({
    description: "Anything Obsidian dashboard",
    programArguments: ["/usr/bin/node", "/app/bin/anything-obsidian.mjs", "start", "--no-browser"],
    logPath: "/logs/dashboard.log",
    environment: { PATH: "/usr/bin:/bin", AO_SUPERVISED: "1" },
  });

  assert.match(file, /Description=Anything Obsidian dashboard/);
  assert.match(file, /ExecStart="\/usr\/bin\/node" "\/app\/bin\/anything-obsidian\.mjs" "start" "--no-browser"/);
  assert.match(file, /Restart=always/);
  assert.match(file, /RestartSec=5/);
  assert.match(file, /StandardOutput=append:\/logs\/dashboard\.log/);
  assert.match(file, /StandardError=append:\/logs\/dashboard\.log/);
  assert.match(file, /Environment="AO_SUPERVISED=1"/);
  assert.match(file, /WantedBy=default\.target/);
});

test("enable writes both units and runs enable --now plus daemon-reload", async () => {
  const home = freshDir();
  const tracker = [];
  const manager = createSystemdManager({
    homedir: home,
    env: {},
    logsRoot: path.join(home, "logs"),
    systemctl: fakeSystemctl(tracker),
  });

  await manager.enable({
    dashboardLogPath: path.join(home, "logs", "dashboard.log"),
    schedulerLogPath: path.join(home, "logs", "scheduler.log"),
  });

  const unitDir = path.join(home, ".config", "systemd", "user");
  const dashboard = readFileSync(path.join(unitDir, DASHBOARD_UNIT), "utf8");
  assert.match(dashboard, /Description=Anything Obsidian dashboard/);
  assert.match(dashboard, /"start" "--no-browser"/);
  const scheduler = readFileSync(path.join(unitDir, SCHEDULER_UNIT), "utf8");
  assert.match(scheduler, /"scheduler-fg"/);
  assert.match(scheduler, /append:.*scheduler\.log/);

  assert.deepEqual(tracker[0], ["--user", "enable", "--now", DASHBOARD_UNIT]);
  assert.deepEqual(tracker[1], ["--user", "enable", "--now", SCHEDULER_UNIT]);
  assert.deepEqual(tracker[2], ["--user", "daemon-reload"]);
});

test("enable surfaces a clear error when the systemd user bus is unavailable", async () => {
  const home = freshDir();
  const manager = createSystemdManager({
    homedir: home,
    env: {},
    logsRoot: path.join(home, "logs"),
    systemctl: async () => {
      throw new Error("Failed to connect to bus: No such file or directory");
    },
  });

  await assert.rejects(
    () => manager.enable({
      dashboardLogPath: path.join(home, "logs", "dashboard.log"),
      schedulerLogPath: path.join(home, "logs", "scheduler.log"),
    }),
    /systemd user services are unavailable.*enable-linger/s,
  );
});

test("disable runs disable --now, removes units, and reloads the daemon", async () => {
  const home = freshDir();
  const tracker = [];
  const manager = createSystemdManager({
    homedir: home,
    env: {},
    logsRoot: path.join(home, "logs"),
    systemctl: fakeSystemctl(tracker),
  });
  await manager.enable({
    dashboardLogPath: path.join(home, "logs", "dashboard.log"),
    schedulerLogPath: path.join(home, "logs", "scheduler.log"),
  });
  tracker.length = 0;

  await manager.disable();

  assert.deepEqual(tracker[0], ["--user", "disable", "--now", DASHBOARD_UNIT]);
  assert.deepEqual(tracker[1], ["--user", "disable", "--now", SCHEDULER_UNIT]);
  assert.deepEqual(tracker.at(-1), ["--user", "daemon-reload"]);
  assert.equal(existsSync(unitPath(DASHBOARD_UNIT, { homedir: home, env: {} })), false);
  assert.equal(existsSync(unitPath(SCHEDULER_UNIT, { homedir: home, env: {} })), false);
});

test("halt stops the units but keeps the unit files", async () => {
  const home = freshDir();
  const tracker = [];
  const manager = createSystemdManager({
    homedir: home,
    env: {},
    logsRoot: path.join(home, "logs"),
    systemctl: fakeSystemctl(tracker),
  });
  await manager.enable({
    dashboardLogPath: path.join(home, "logs", "dashboard.log"),
    schedulerLogPath: path.join(home, "logs", "scheduler.log"),
  });
  tracker.length = 0;

  await manager.halt();

  assert.deepEqual(tracker, [
    ["--user", "stop", DASHBOARD_UNIT],
    ["--user", "stop", SCHEDULER_UNIT],
  ]);
  assert.equal(existsSync(unitPath(DASHBOARD_UNIT, { homedir: home, env: {} })), true);
});

test("status parses ActiveState and MainPID from systemctl show", async () => {
  const home = freshDir();
  const manager = createSystemdManager({
    homedir: home,
    env: {},
    logsRoot: path.join(home, "logs"),
    systemctl: fakeSystemctl(tracker = [], { activeUnits: [DASHBOARD_UNIT] }),
  });

  const state = await manager.status();
  assert.deepEqual(state.dashboard, { loaded: true, running: true, pid: 5678 });
  assert.deepEqual(state.scheduler, { loaded: true, running: false, pid: null });
});

let tracker;
test("enabled reflects unit file existence", async () => {
  const home = freshDir();
  const manager = createSystemdManager({
    homedir: home,
    env: {},
    logsRoot: path.join(home, "logs"),
    systemctl: fakeSystemctl([]),
  });

  assert.equal(await manager.enabled(), false);
  await manager.enable({
    dashboardLogPath: path.join(home, "logs", "dashboard.log"),
    schedulerLogPath: path.join(home, "logs", "scheduler.log"),
  });
  assert.equal(await manager.enabled(), true);
});

test("createServiceManager dispatches by platform and rejects unknown ones", async () => {
  const home = freshDir();
  const linux = createServiceManager({ platform: "linux", homedir: home, env: {}, logsRoot: path.join(home, "logs"), systemctl: fakeSystemctl([]) });
  assert.equal(typeof linux.enable, "function");

  const darwin = createServiceManager({ platform: "darwin", homedir: home, logsRoot: path.join(home, "logs"), launchctl: async () => ({ stdout: "", stderr: "" }) });
  assert.equal(typeof darwin.enable, "function");

  assert.throws(() => createServiceManager({ platform: "win32", logsRoot: "/x" }), /not supported on win32/);
});
