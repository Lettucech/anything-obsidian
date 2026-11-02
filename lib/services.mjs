import { isContainer } from "./deployment.mjs";
import { createContainerController } from "./container-services.mjs";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildPlistXml, buildUnitFile } from "./autostart.mjs";
import { createAppConfigStore } from "./app-config.mjs";
import { createInstallationStore } from "./installation.mjs";
import { createGatewayConfig } from "../server/gateway-config.mjs";
import { withFileLock } from "./state.mjs";

const cliPathDefault = fileURLToPath(new URL("../bin/anything-obsidian.mjs", import.meta.url));
const exec = promisify(execFile);
// One supervised process per installation: the merged app (dashboard, local
// MCP, scheduler, and the opt-in gateway/LAN listeners) runs as `run app`.
// The legacy per-role names are kept only to migrate old installs and for
// the uninstaller.
export const SERVICE_NAMES = ["app"];
export const LEGACY_SERVICE_NAMES = ["dashboard", "scheduler", "mcp", "mcp-lan", "gateway"];
export function installedServices(installation) {
  const roles = installation.roles ?? [];
  return roles.includes("client") || roles.includes("server") || roles.includes("gateway")
    ? ["app"]
    : [];
}

export function createServiceController({
  root,
  platform = process.platform,
  env = process.env,
  homedir = env.HOME || os.homedir(),
  uid = os.userInfo().uid,
  nodePath = process.execPath,
  cliPath = cliPathDefault,
  launchctl = (args) => exec("launchctl", args),
  systemctl = (args) => exec("systemctl", args),
  loginctl = (args) => exec("loginctl", args),
  installation = createInstallationStore(root),
} = {}) {
  if (isContainer(env)) return createContainerController({ root });
  if (!root || !path.isAbsolute(root)) throw new Error("An absolute service data root is required");
  if (!["darwin", "linux"].includes(platform))
    throw new Error(`Services are not supported on ${platform}`);
  const environment = {
    HOME: homedir,
    PATH: `${path.dirname(nodePath)}:${env.PATH || "/usr/local/bin:/usr/bin:/bin"}`,
    ANYTHING_OBSIDIAN_HOME: root,
    AO_SUPERVISED: "1",
  };
  const label = (role) => `app.anything-obsidian.${role}`;
  const unit = (role) => `anything-obsidian-${role}.service`;
  const persistentPath = (role) =>
    platform === "darwin"
      ? path.join(homedir, "Library", "LaunchAgents", `${label(role)}.plist`)
      : path.join(
          env.XDG_CONFIG_HOME || path.join(homedir, ".config"),
          "systemd",
          "user",
          unit(role),
        );
  const definitionPath = (role, auto) =>
    platform === "darwin" && !auto
      ? path.join(root, "run", "services", `${label(role)}.plist`)
      : persistentPath(role);
  const state = async (role) => {
    try {
      if (platform === "darwin") {
        const { stdout } = await launchctl(["print", `gui/${uid}/${label(role)}`]);
        const pid = Number(stdout.match(/\bpid\s*=\s*(\d+)/)?.[1] || 0);
        return { loaded: true, running: pid > 0, pid: pid || null };
      }
      const { stdout } = await systemctl([
        "--user",
        "show",
        unit(role),
        "--property=LoadState,ActiveState,MainPID",
      ]);
      const pid = Number(stdout.match(/MainPID=(\d+)/)?.[1] || 0);
      return {
        loaded: /LoadState=loaded/.test(stdout),
        running: /ActiveState=active\b/.test(stdout) && pid > 0,
        pid: pid || null,
      };
    } catch {
      return { loaded: false, running: false, pid: null };
    }
  };
  async function configure(names, auto) {
    const changed = new Set();
    await mkdir(path.join(root, "logs"), { recursive: true });
    for (const role of names) {
      const file = definitionPath(role, auto);
      const programArguments = [nodePath, cliPath, "run", role];
      const logPath = path.join(root, "logs", `${role}.log`);
      const contents =
        platform === "darwin"
          ? buildPlistXml({ label: label(role), programArguments, logPath, environment })
          : buildUnitFile({
              description: `Anything Obsidian ${role}`,
              programArguments,
              logPath,
              environment,
            });
      const previous = await readFile(file, "utf8").catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      if (previous !== contents) {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, contents, { mode: 0o600 });
        changed.add(role);
      }
      if (platform === "darwin" && !auto) await rm(persistentPath(role), { force: true });
    }
    if (platform === "linux") {
      if (changed.size) await systemctl(["--user", "daemon-reload"]);
      for (const role of names)
        await systemctl(["--user", auto ? "enable" : "disable", unit(role)]);
    }
    return changed;
  }
  async function start(names, auto, changed) {
    for (const role of names) {
      const current = await state(role);
      if (current.running && !changed.has(role)) continue;
      if (platform === "linux") {
        await systemctl([
          "--user",
          changed.has(role) && current.running ? "restart" : "start",
          unit(role),
        ]);
      } else {
        if (current.loaded && changed.has(role))
          await launchctl(["bootout", `gui/${uid}/${label(role)}`]);
        if (!current.loaded || changed.has(role))
          await launchctl(["bootstrap", `gui/${uid}`, definitionPath(role, auto)]);
        else await launchctl(["kickstart", `gui/${uid}/${label(role)}`]);
      }
    }
  }
  async function stop(names) {
    for (const role of [...names].reverse()) {
      if (platform === "linux") await systemctl(["--user", "stop", unit(role)]);
      else if ((await state(role)).loaded)
        await launchctl(["bootout", `gui/${uid}/${label(role)}`]);
    }
  }
  const locked = (action) => withFileLock(path.join(root, "run", "services.lock"), action);
  // One-time (idempotent) upgrade from the per-role service model: convert a
  // gateway-only install into the merged app, then remove every legacy
  // launchd/systemd definition so nothing orphaned keeps old ports bound.
  async function migrateLegacyServices() {
    const profile = await installation.load();
    const report = { removedServices: [], convertedGatewayOnly: false };
    // profile.roles is normalized, so this catches both a fresh "server" role
    // and a legacy "gateway"-only install.
    if (profile.roles.includes("server") && !profile.roles.includes("client")) {
      const store = createAppConfigStore({ rootDir: root });
      if (!(await store.load())) {
        const gatewayState = await createGatewayConfig({
          dataDir: path.join(root, "gateway"),
        }).load();
        if (gatewayState.anythingllmBaseUrl && gatewayState.apiKey) {
          await store.save({
            vaultsRoot: path.join(homedir, ".anything-obsidian", "vaults"),
            anythingllmBaseUrl: gatewayState.anythingllmBaseUrl,
            apiKey: gatewayState.apiKey,
          });
        }
      }
      await installation.addRole("client");
      report.convertedGatewayOnly = true;
    }
    for (const name of LEGACY_SERVICE_NAMES) {
      const loaded = (await state(name)).loaded;
      if (platform === "linux") {
        if (loaded || (await state(name)).running)
          await systemctl(["--user", "stop", unit(name)]);
        const existed = await readFile(persistentPath(name), "utf8").then(
          () => true,
          () => false,
        );
        if (existed) {
          await systemctl(["--user", "disable", unit(name)]).catch(() => {});
          await rm(persistentPath(name), { force: true });
          report.removedServices.push(name);
        }
      } else if (loaded) {
        await launchctl(["bootout", `gui/${uid}/${label(name)}`]);
        await rm(persistentPath(name), { force: true });
        await rm(definitionPath(name, false), { force: true });
        report.removedServices.push(name);
      } else {
        const exists = (file) => stat(file).then(() => true, () => false);
        const hadStaged = await exists(definitionPath(name, false));
        if (hadStaged) await rm(definitionPath(name, false), { force: true });
        const hadPersistent = await exists(persistentPath(name));
        if (hadPersistent) await rm(persistentPath(name), { force: true });
        if (hadStaged || hadPersistent) report.removedServices.push(name);
      }
    }
    if (platform === "linux" && report.removedServices.length)
      await systemctl(["--user", "daemon-reload"]);
    return report;
  }
  return {
    async start() {
      return locked(async () => {
        const migration = await migrateLegacyServices();
        const profile = await installation.load();
        const names = installedServices(profile);
        if (!names.length) throw new Error("Nothing configured. Run: anything-obsidian setup");
        await start(names, profile.autostart, await configure(names, profile.autostart));
        return migration;
      });
    },
    async stop() {
      return locked(async () => stop(installedServices(await installation.load())));
    },
    async restart() {
      return locked(async () => {
        const migration = await migrateLegacyServices();
        const profile = await installation.load();
        const names = installedServices(profile);
        if (!names.length) throw new Error("Nothing configured. Run: anything-obsidian setup");
        await stop(names);
        await start(names, profile.autostart, await configure(names, profile.autostart));
        return migration;
      });
    },
    async startService(role) {
      return locked(async () => {
        const profile = await installation.load();
        if (!installedServices(profile).includes(role))
          throw new Error(`Service is not configured: ${role}`);
        await start([role], profile.autostart, await configure([role], profile.autostart));
      });
    },
    async stopService(role) {
      return locked(async () => stop([role]));
    },
    async setAutostart(enabled) {
      return locked(async () => {
        const profile = await installation.update({ autostart: enabled });
        // Changing startup preference does not stop a running service.
        await configure(installedServices(profile), enabled);
      });
    },
    async status() {
      const profile = await installation.load();
      const services = Object.fromEntries(
        await Promise.all(
          installedServices(profile).map(async (role) => [role, await state(role)]),
        ),
      );
      let registered = false;
      if (profile.autostart) {
        const registration = await Promise.all(
          installedServices(profile).map(async (role) => {
            if (platform === "darwin") {
              const escaped = root
                .replaceAll("&", "&amp;")
                .replaceAll("<", "&lt;")
                .replaceAll(">", "&gt;");
              return readFile(persistentPath(role), "utf8")
                .then(
                  (text) =>
                    text.includes(`<string>${escaped}</string>`) && text.includes("AO_SUPERVISED"),
                )
                .catch(() => false);
            }
            try {
              const file = await readFile(persistentPath(role), "utf8");
              const binding = `Environment=${JSON.stringify(`ANYTHING_OBSIDIAN_HOME=${root}`.replaceAll("%", "%%"))}`;
              return (
                file.includes(binding) &&
                (await systemctl(["--user", "is-enabled", unit(role)])).stdout.trim() === "enabled"
              );
            } catch {
              return false;
            }
          }),
        );
        registered = registration.length > 0 && registration.every(Boolean);
      }
      let linger = false;
      if (platform === "linux" && profile.autostart) {
        try {
          linger =
            (
              await loginctl(["show-user", String(uid), "--property=Linger", "--value"])
            ).stdout.trim() === "yes";
        } catch {
          /* shown as unverified */
        }
      }
      return {
        roles: profile.roles,
        services,
        autostart: {
          enabled: profile.autostart,
          registered,
          guarantee: !profile.autostart
            ? "disabled"
            : !registered
              ? "incomplete"
              : platform === "darwin"
                ? "after-login"
                : linger
                  ? "at-boot"
                  : "after-login",
          ...(platform === "linux" ? { linger } : {}),
        },
      };
    },
  };
}
