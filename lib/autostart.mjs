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
export const MCP_LABEL = "app.anything-obsidian.mcp";
export const MCP_LAN_LABEL = "app.anything-obsidian.mcp-lan";
export const GATEWAY_LABEL = "app.anything-obsidian.gateway";

const LAUNCHD_PATH = "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin";

export async function ensureDisplayBinary(role, { displayRoot, sourceBinary = process.execPath, copyFile = defaultCopy, listRpathLibs = defaultListRpathLibs, canRun = defaultCanRun } = {}) {
  if (!displayRoot) return null;
  const target = path.join(displayRoot, `anything-obsidian-${role}`);
  try {
    rmSync(target, { force: true });
    mkdirSync(displayRoot, { recursive: true });
    await copyFile(sourceBinary, target);
    // Homebrew-style node binaries link libnode.dylib from their install
    // prefix and stop working when moved. Symlink those libraries next to the
    // copy; if it still will not run, fall back to the plain node binary.
    if (!(await canRun(target))) {
      for (const lib of await listRpathLibs(sourceBinary)) {
        try {
          await execFileAsync("ln", ["-sf", lib, path.join(displayRoot, path.basename(lib))]);
        } catch {
          // best effort — the fallback below covers failures
        }
      }
      if (!(await canRun(target))) {
        rmSync(target, { force: true });
        return null;
      }
    }
    return target;
  } catch {
    return null;
  }
}
async function defaultCopy(source, target) {
  // APFS clone or reflink: instant, no extra disk space. Falls back to a
  // plain copy on filesystems that support neither.
  try {
    await execFileAsync("cp", ["-c", source, target]);
  } catch {
    try {
      await execFileAsync("cp", ["--reflink=auto", source, target]);
    } catch {
      await execFileAsync("cp", [source, target]);
    }
  }
}

async function defaultCanRun(binary) {
  try {
    await execFileAsync(binary, ["--version"], { timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

async function defaultListRpathLibs(sourceBinary) {
  try {
    const { stdout } = await execFileAsync("otool", ["-L", sourceBinary]);
    const libs = stdout
      .split("\n")
      .map((line) => line.trim().split(" ")[0])
      .filter((name) => name.startsWith("@rpath/"))
      .map((name) => name.replace("@rpath/", ""));
    if (!libs.length) return [];

    // Resolve each @rpath entry against the binary's LC_RPATH search paths.
    const { stdout: loadCommands } = await execFileAsync("otool", ["-l", sourceBinary]);
    const sourceDir = path.dirname(await execRealpath(sourceBinary));
    const rpaths = [...loadCommands.matchAll(/LC_RPATH[\s\S]*?path (\S+)/g)]
      .map((match) => match[1].replace(/^@loader_path\//, `${sourceDir}/`));
    const candidates = [];
    for (const lib of libs) {
      for (const rpath of rpaths) {
        const absolute = path.join(rpath, lib);
        if (existsSync(absolute)) candidates.push(absolute);
      }
    }
    return candidates;
  } catch {
    return [];
  }
}

async function execRealpath(filePath) {
  const { stdout } = await execFileAsync("realpath", [filePath]);
  return stdout.trim();
}

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

export function mcpProgramArguments({ nodePath = process.execPath, cliPath = CLI_ENTRY_PATH, lan = false } = {}) {
  return [nodePath, cliPath, "mcp-fg", ...(lan ? ["--lan"] : [])];
}

export function gatewayProgramArguments({ nodePath = process.execPath, cliPath = CLI_ENTRY_PATH } = {}) {
  return [nodePath, cliPath, "gateway-fg"];
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
      environment: { ...environment, AO_SUPERVISED: "1" },
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
    mcpPlistPath: plistPath(MCP_LABEL, { homedir }),
    mcpLanPlistPath: plistPath(MCP_LAN_LABEL, { homedir }),
    gatewayPlistPath: plistPath(GATEWAY_LABEL, { homedir }),
    async enable({ dashboardLogPath, schedulerLogPath, mcpLogPath, nodePath, cliPath, displayRoot } = {}) {
      const dashboardBinary = (await ensureDisplayBinary("dashboard", { displayRoot, sourceBinary: nodePath })) || nodePath;
      const schedulerBinary = (await ensureDisplayBinary("scheduler", { displayRoot, sourceBinary: nodePath })) || nodePath;
      const mcpBinary = (await ensureDisplayBinary("mcp", { displayRoot, sourceBinary: nodePath })) || nodePath;
      await bootstrap(DASHBOARD_LABEL, dashboardProgramArguments({ nodePath: dashboardBinary, cliPath }), dashboardLogPath);
      await bootstrap(SCHEDULER_LABEL, schedulerProgramArguments({ nodePath: schedulerBinary, cliPath }), schedulerLogPath);
      await bootstrap(MCP_LABEL, mcpProgramArguments({ nodePath: mcpBinary, cliPath }), mcpLogPath || schedulerLogPath);
    },
    async enableLan({ mcpLanLogPath, nodePath, cliPath, displayRoot } = {}) {
      const mcpBinary = (await ensureDisplayBinary("mcp-lan", { displayRoot, sourceBinary: nodePath })) || nodePath;
      await bootstrap(MCP_LAN_LABEL, mcpProgramArguments({ nodePath: mcpBinary, cliPath, lan: true }), mcpLanLogPath);
    },
    async enableGateway({ gatewayLogPath, nodePath, cliPath } = {}) {
      await bootstrap(GATEWAY_LABEL, gatewayProgramArguments({ nodePath, cliPath }), gatewayLogPath);
    },
    async disableGateway() {
      await bootout(GATEWAY_LABEL);
      rmSync(plistPath(GATEWAY_LABEL, { homedir }), { force: true });
    },
    async gatewayEnabled() {
      return existsSync(this.gatewayPlistPath);
    },
    async halt() {
      await bootout(DASHBOARD_LABEL);
      await bootout(SCHEDULER_LABEL);
      await bootout(MCP_LABEL);
      await bootout(MCP_LAN_LABEL);
    },
    async disable() {
      await this.halt();
      rmSync(plistPath(DASHBOARD_LABEL, { homedir }), { force: true });
      rmSync(plistPath(SCHEDULER_LABEL, { homedir }), { force: true });
      rmSync(plistPath(MCP_LABEL, { homedir }), { force: true });
      rmSync(plistPath(MCP_LAN_LABEL, { homedir }), { force: true });
    },
    async disableLan() {
      await bootout(MCP_LAN_LABEL);
      rmSync(plistPath(MCP_LAN_LABEL, { homedir }), { force: true });
    },
    async enabled() {
      return existsSync(this.dashboardPlistPath) || existsSync(this.schedulerPlistPath) || existsSync(this.mcpPlistPath);
    },
    async lanEnabled() {
      return existsSync(this.mcpLanPlistPath);
    },
    async status() {
      return {
        dashboard: await serviceState(DASHBOARD_LABEL),
        scheduler: await serviceState(SCHEDULER_LABEL),
        mcp: await serviceState(MCP_LABEL),
        mcpLan: await serviceState(MCP_LAN_LABEL),
        gateway: await serviceState(GATEWAY_LABEL),
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

export const DASHBOARD_UNIT = "anything-obsidian-dashboard.service";
export const SCHEDULER_UNIT = "anything-obsidian-scheduler.service";
export const MCP_UNIT = "anything-obsidian-mcp.service";
export const MCP_LAN_UNIT = "anything-obsidian-mcp-lan.service";
export const GATEWAY_UNIT = "anything-obsidian-gateway.service";

export function systemdUnitDir({ homedir = os.homedir(), env = process.env } = {}) {
  return path.join(env.XDG_CONFIG_HOME || path.join(homedir, ".config"), "systemd", "user");
}

export function unitPath(unit, { homedir, env } = {}) {
  return path.join(systemdUnitDir({ homedir, env }), unit);
}

export function buildUnitFile({ description, programArguments, logPath, environment = {} }) {
  const args = programArguments.map((arg) => JSON.stringify(arg)).join(" ");
  const envLines = Object.entries(environment)
    .map(([key, value]) => `Environment="${key}=${value}"`)
    .join("\n");
  return `[Unit]
Description=${description}

[Service]
Type=simple
ExecStart=${args}
Restart=always
RestartSec=5
StandardOutput=append:${logPath}
StandardError=append:${logPath}
${envLines}

[Install]
WantedBy=default.target
`;
}

export function createSystemdManager({
  homedir = os.homedir(),
  env = process.env,
  systemctl = (args) => execFileAsync("systemctl", args),
  environment = defaultEnvironment(),
  logsRoot,
} = {}) {
  if (!logsRoot) throw new Error("logsRoot is required");

  function unitArguments(role, nodePath, cliPath) {
    if (role === "dashboard") return dashboardProgramArguments({ nodePath, cliPath });
    if (role === "mcp") return mcpProgramArguments({ nodePath, cliPath });
    if (role === "mcp-lan") return mcpProgramArguments({ nodePath, cliPath, lan: true });
    if (role === "gateway") return gatewayProgramArguments({ nodePath, cliPath });
    return schedulerProgramArguments({ nodePath, cliPath });
  }

  async function startUnit(unit, description, programArguments, logPath) {
    const file = unitPath(unit, { homedir, env });
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, buildUnitFile({ description, programArguments, logPath, environment }));
    try {
      await systemctl(["--user", "enable", "--now", unit]);
    } catch (error) {
      throw new Error(
        `systemd user services are unavailable (${error instanceof Error ? error.message : String(error)}). ` +
          "On a headless server, run your session under systemd or use `loginctl enable-linger`.",
      );
    }
    return file;
  }

  async function serviceState(unit) {
    try {
      const { stdout } = await systemctl(["--user", "show", unit, "--property=ActiveState,MainPID"]);
      const state = stdout.match(/ActiveState=(\w+)/)?.[1] ?? "unknown";
      const pidMatch = stdout.match(/MainPID=(\d+)/)?.[1];
      const pid = pidMatch ? Number.parseInt(pidMatch, 10) : 0;
      return { loaded: state !== "unknown", running: state === "active" || state === "activating", pid: pid > 0 ? pid : null };
    } catch {
      return { loaded: false, running: false, pid: null };
    }
  }

  return {
    dashboardUnitPath: unitPath(DASHBOARD_UNIT, { homedir, env }),
    schedulerUnitPath: unitPath(SCHEDULER_UNIT, { homedir, env }),
    mcpUnitPath: unitPath(MCP_UNIT, { homedir, env }),
    mcpLanUnitPath: unitPath(MCP_LAN_UNIT, { homedir, env }),
    gatewayUnitPath: unitPath(GATEWAY_UNIT, { homedir, env }),
    async enable({ dashboardLogPath, schedulerLogPath, mcpLogPath, nodePath, cliPath, displayRoot } = {}) {
      const dashboardBinary = (await ensureDisplayBinary("dashboard", { displayRoot, sourceBinary: nodePath })) || nodePath;
      const schedulerBinary = (await ensureDisplayBinary("scheduler", { displayRoot, sourceBinary: nodePath })) || nodePath;
      const mcpBinary = (await ensureDisplayBinary("mcp", { displayRoot, sourceBinary: nodePath })) || nodePath;
      await startUnit(DASHBOARD_UNIT, "Anything Obsidian dashboard", unitArguments("dashboard", dashboardBinary, cliPath), dashboardLogPath);
      await startUnit(SCHEDULER_UNIT, "Anything Obsidian sync scheduler", unitArguments("scheduler", schedulerBinary, cliPath), schedulerLogPath);
      await startUnit(MCP_UNIT, "Anything Obsidian MCP endpoint", unitArguments("mcp", mcpBinary, cliPath), mcpLogPath || schedulerLogPath);
      try {
        await systemctl(["--user", "daemon-reload"]);
      } catch {
        // best effort — enable --now already loaded the units
      }
    },
    async enableLan({ mcpLanLogPath, nodePath, cliPath, displayRoot } = {}) {
      const mcpBinary = (await ensureDisplayBinary("mcp-lan", { displayRoot, sourceBinary: nodePath })) || nodePath;
      await startUnit(MCP_LAN_UNIT, "Anything Obsidian LAN MCP endpoint", unitArguments("mcp-lan", mcpBinary, cliPath), mcpLanLogPath);
      try {
        await systemctl(["--user", "daemon-reload"]);
      } catch {
        // best effort
      }
    },
    async enableGateway({ gatewayLogPath, nodePath, cliPath } = {}) {
      await startUnit(GATEWAY_UNIT, "Anything Obsidian IAM gateway", unitArguments("gateway", nodePath, cliPath), gatewayLogPath);
      try {
        await systemctl(["--user", "daemon-reload"]);
      } catch {
        // best effort
      }
    },
    async disableGateway() {
      try {
        await systemctl(["--user", "disable", "--now", GATEWAY_UNIT]);
      } catch {
        // not enabled
      }
      rmSync(unitPath(GATEWAY_UNIT, { homedir, env }), { force: true });
      try {
        await systemctl(["--user", "daemon-reload"]);
      } catch {
        // best effort
      }
    },
    async gatewayEnabled() {
      return existsSync(this.gatewayUnitPath);
    },
    async halt() {
      for (const unit of [DASHBOARD_UNIT, SCHEDULER_UNIT, MCP_UNIT, MCP_LAN_UNIT]) {
        try {
          await systemctl(["--user", "stop", unit]);
        } catch {
          // not running
        }
      }
    },
    async disable() {
      for (const unit of [DASHBOARD_UNIT, SCHEDULER_UNIT, MCP_UNIT, MCP_LAN_UNIT]) {
        try {
          await systemctl(["--user", "disable", "--now", unit]);
        } catch {
          // not enabled
        }
        rmSync(unitPath(unit, { homedir, env }), { force: true });
      }
      try {
        await systemctl(["--user", "daemon-reload"]);
      } catch {
        // best effort
      }
    },
    async disableLan() {
      try {
        await systemctl(["--user", "disable", "--now", MCP_LAN_UNIT]);
      } catch {
        // not enabled
      }
      rmSync(unitPath(MCP_LAN_UNIT, { homedir, env }), { force: true });
      try {
        await systemctl(["--user", "daemon-reload"]);
      } catch {
        // best effort
      }
    },
    async enabled() {
      return existsSync(this.dashboardUnitPath) || existsSync(this.schedulerUnitPath) || existsSync(this.mcpUnitPath);
    },
    async lanEnabled() {
      return existsSync(this.mcpLanUnitPath);
    },
    async status() {
      return {
        dashboard: await serviceState(DASHBOARD_UNIT),
        scheduler: await serviceState(SCHEDULER_UNIT),
        mcp: await serviceState(MCP_UNIT),
        mcpLan: await serviceState(MCP_LAN_UNIT),
        gateway: await serviceState(GATEWAY_UNIT),
      };
    },
  };
}

export function createServiceManager({ platform = process.platform, homedir, env, launchctl, systemctl, logsRoot } = {}) {
  if (platform === "darwin") {
    return createAutostartManager({ homedir, launchctl, logsRoot });
  }
  if (platform === "linux") {
    return createSystemdManager({ homedir, env, systemctl, logsRoot });
  }
  throw new Error(`Autostart is not supported on ${platform}`);
}
