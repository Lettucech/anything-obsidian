import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CLI_ENTRY_PATH = path.join(repoRoot, "bin", "anything-obsidian.mjs");

export const DASHBOARD_LABEL = "app.anything-obsidian.dashboard";
export const SCHEDULER_LABEL = "app.anything-obsidian.scheduler";

const LAUNCHD_PATH = "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin";

export function launchAgentsDir({ homedir = os.homedir() } = {}) {
  return path.join(homedir, "Library", "LaunchAgents");
}

export function plistPath(label, { homedir = os.homedir() } = {}) {
  return path.join(launchAgentsDir({ homedir }), `${label}.plist`);
}

export function buildPlistXml({ label, programArguments, logPath, environment = {} }) {
  const escape = (value) => String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  const args = programArguments.map((arg) => `    <string>${escape(arg)}</string>`).join("\n");
  const envEntries = Object.entries(environment)
    .map(([key, value]) => `      <key>${escape(key)}</key>\n      <string>${escape(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escape(logPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
</dict>
</plist>
`;
}

export function dashboardProgramArguments({ nodePath = process.execPath, cliPath = CLI_ENTRY_PATH } = {}) {
  return [nodePath, cliPath, "start", "--no-browser"];
}

export function schedulerProgramArguments({ nodePath = process.execPath, cliPath = CLI_ENTRY_PATH } = {}) {
  return [nodePath, cliPath, "scheduler-fg"];
}

function serviceDomain(uid, label) {
  return `gui/${uid}/${label}`;
}

export function createAutostartManager({
  homedir = os.homedir(),
  uid = os.userInfo().uid,
  launchctl = (args) => execFileAsync("launchctl", args),
  environment = defaultEnvironment(),
  logsRoot,
} = {}) {
  if (!logsRoot) throw new Error("logsRoot is required");

  async function bootstrap(label, programArguments, logPath) {
    const plist = plistPath(label, { homedir });
    mkdirSync(path.dirname(plist), { recursive: true });
    writeFileSync(plist, buildPlistXml({
      label,
      programArguments,
      logPath,
      environment: { ...environment, AO_LAUNCHD: "1" },
    }));
    try {
      await launchctl(["bootstrap", `gui/${uid}`, plist]);
    } catch {
      // most commonly "already bootstrapped"; genuine breakage surfaces in kickstart below
    }
    await launchctl(["kickstart", "-k", serviceDomain(uid, label)]);
    return plist;
  }

  async function bootout(label) {
    try {
      await launchctl(["bootout", serviceDomain(uid, label)]);
    } catch {
      // not loaded — nothing to stop
    }
  }

  async function serviceState(label) {
    try {
      const { stdout } = await launchctl(["print", serviceDomain(uid, label)]);
      const pidMatch = stdout.match(/"pid"\s*=\s*(\d+)/) || stdout.match(/\bpid\s*=\s*(\d+)/);
      const stateMatch = stdout.match(/"state"\s*=\s*([a-z, ]+)/i) || stdout.match(/\bstate\s*=\s*([a-z, ]+)/i);
      return {
        loaded: true,
        running: Boolean(pidMatch) || /running/i.test(stateMatch?.[1] ?? ""),
        pid: pidMatch ? Number.parseInt(pidMatch[1], 10) : null,
      };
    } catch {
      return { loaded: false, running: false, pid: null };
    }
  }

  return {
    uid,
    dashboardPlistPath: plistPath(DASHBOARD_LABEL, { homedir }),
    schedulerPlistPath: plistPath(SCHEDULER_LABEL, { homedir }),
    async enable({ dashboardLogPath, schedulerLogPath, nodePath, cliPath } = {}) {
      await bootstrap(DASHBOARD_LABEL, dashboardProgramArguments({ nodePath, cliPath }), dashboardLogPath);
      await bootstrap(SCHEDULER_LABEL, schedulerProgramArguments({ nodePath, cliPath }), schedulerLogPath);
    },
    async halt() {
      await bootout(DASHBOARD_LABEL);
      await bootout(SCHEDULER_LABEL);
    },
    async disable() {
      await bootout(DASHBOARD_LABEL);
      await bootout(SCHEDULER_LABEL);
      rmSync(plistPath(DASHBOARD_LABEL, { homedir }), { force: true });
      rmSync(plistPath(SCHEDULER_LABEL, { homedir }), { force: true });
    },
    async enabled() {
      return existsSync(this.dashboardPlistPath) || existsSync(this.schedulerPlistPath);
    },
    async status() {
      return {
        dashboard: await serviceState(DASHBOARD_LABEL),
        scheduler: await serviceState(SCHEDULER_LABEL),
      };
    },
  };
}

function defaultEnvironment() {
  const environment = { PATH: LAUNCHD_PATH };
  if (process.env.ANYTHING_OBSIDIAN_HOME) {
    environment.ANYTHING_OBSIDIAN_HOME = process.env.ANYTHING_OBSIDIAN_HOME;
  }
  return environment;
}
