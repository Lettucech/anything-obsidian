import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createServiceController } from "./services.mjs";
import { createInstallationStore } from "./installation.mjs";
import { createGatewayConfig } from "../server/gateway-config.mjs";

async function fixture(t, platform) {
  const home = await mkdtemp(path.join(tmpdir(), "any-obs-services-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, "data with spaces"),
    installation = createInstallationStore(root);
  await installation.addRole("client");
  const calls = [],
    running = new Set(),
    enabled = new Set();
  const launchctl = async (args) => {
    calls.push(args);
    const label = args[1]?.split("/").at(-1);
    if (args[0] === "print") {
      if (!running.has(label)) throw new Error("not loaded");
      return { stdout: "state = running\npid = 123\n" };
    }
    if (args[0] === "bootstrap") running.add(path.basename(args[2], ".plist"));
    if (args[0] === "bootout") running.delete(label);
    return { stdout: "" };
  };
  const systemctl = async (args) => {
    calls.push(args);
    const name = args[2];
    if (args[1] === "enable") enabled.add(name);
    if (args[1] === "disable") enabled.delete(name);
    if (args[1] === "is-enabled") return { stdout: enabled.has(name) ? "enabled" : "disabled" };
    if (args[1] === "show")
      return {
        stdout: `LoadState=loaded\nActiveState=${running.has(name) ? "active" : "inactive"}\nMainPID=${running.has(name) ? 123 : 0}\n`,
      };
    if (["start", "restart"].includes(args[1])) running.add(name);
    if (args[1] === "stop") running.delete(name);
    return { stdout: "" };
  };
  const controller = createServiceController({
    root,
    platform,
    env: { HOME: home, PATH: "/usr/bin:/bin", XDG_CONFIG_HOME: path.join(home, "xdg") },
    homedir: home,
    uid: 501,
    installation,
    launchctl,
    systemctl,
    loginctl: async () => ({ stdout: "yes\n" }),
  });
  return { controller, root, home, calls, installation, running, launchctl };
}

test("macOS start pins the absolute root, runs the single app service and is idempotent", async (t) => {
  const f = await fixture(t, "darwin");
  await f.controller.start();
  const plist = await readFile(
    path.join(f.home, "Library/LaunchAgents/app.anything-obsidian.app.plist"),
    "utf8",
  );
  assert.match(plist, /<string>run<\/string>/);
  assert.match(plist, /<string>app<\/string>/);
  assert.ok(plist.includes(f.root));
  assert.match(plist, /AO_SUPERVISED/);
  const starts = f.calls.filter((call) => call[0] === "bootstrap").length;
  await f.controller.start();
  assert.equal(f.calls.filter((call) => call[0] === "bootstrap").length, starts);
  assert.equal(
    f.calls.some((call) => call.includes("-k")),
    false,
  );
});

test("systemd definitions are reloaded before activation and cannot self-detect as already managed", async (t) => {
  const f = await fixture(t, "linux");
  await f.controller.start();
  const unit = await readFile(
    path.join(f.home, "xdg/systemd/user/anything-obsidian-app.service"),
    "utf8",
  );
  assert.match(unit, /"run" "app"/);
  assert.match(unit, /AO_SUPERVISED=1/);
  assert.ok(unit.includes(f.root));
  assert.ok(
    f.calls.findIndex((call) => call[1] === "daemon-reload") <
      f.calls.findIndex((call) => call[1] === "start"),
  );
  const starts = f.calls.filter((call) => call[1] === "start").length;
  await f.controller.start();
  assert.equal(f.calls.filter((call) => call[1] === "start").length, starts);
});

test("stop preserves registration and autostart, while autostart off preserves running services", async (t) => {
  for (const platform of ["darwin", "linux"]) {
    const f = await fixture(t, platform);
    await f.controller.start();
    await f.controller.setAutostart(false);
    assert.ok(f.running.size);
    assert.equal((await f.controller.status()).autostart.enabled, false);
    await f.controller.stop();
    assert.equal(f.running.size, 0);
    assert.equal((await f.installation.load()).autostart, false);
    await f.controller.start();
    assert.ok(f.running.size);
    assert.equal((await f.installation.load()).autostart, false);
  }
});

test("the single app service serves both roles, and Linux linger still gates the boot guarantee", async (t) => {
  const f = await fixture(t, "linux");
  await f.installation.addRole("server");
  await f.controller.start();
  const status = await f.controller.status();
  assert.equal(Object.keys(status.services).length, 1);
  assert.deepEqual(Object.keys(status.services), ["app"]);
  assert.equal(status.autostart.guarantee, "at-boot");
  await f.controller.restart();
  assert.equal(f.running.size, 1);
});

test("migration removes legacy service definitions and converts a gateway-only install", async (t) => {
  const f = await fixture(t, "darwin");
  // A pre-upgrade machine: gateway role only, gateway.json configured, and a
  // legacy per-role plist still registered.
  await f.installation.update({ roles: ["gateway"] });
  await mkdir(path.join(f.root, "gateway"), { recursive: true });
  await createGatewayConfig({ dataDir: path.join(f.root, "gateway") }).save({
    anythingllmBaseUrl: "http://anytingllm.example.com",
    apiKey: "dev-key",
  });
  const legacyPlist = path.join(f.home, "Library/LaunchAgents/app.anything-obsidian.gateway.plist");
  await mkdir(path.dirname(legacyPlist), { recursive: true });
  await writeFile(legacyPlist, "<plist/>");
  const clientPlist = path.join(f.home, "Library/LaunchAgents/app.anything-obsidian.dashboard.plist");
  await writeFile(clientPlist, "<plist/>");

  await f.controller.start();

  const profile = await f.installation.load();
  assert.deepEqual([...profile.roles].sort(), ["client", "server"]);
  const config = JSON.parse(
    await readFile(path.join(f.root, "config.json"), "utf8"),
  );
  assert.equal(config.anythingllmBaseUrl, "http://anytingllm.example.com");
  assert.equal(config.apiKey, "dev-key");
  await assert.rejects(readFile(legacyPlist, "utf8"));
  await assert.rejects(readFile(clientPlist, "utf8"));
  await readFile(path.join(f.home, "Library/LaunchAgents/app.anything-obsidian.app.plist"), "utf8");
  // Idempotent: a second start neither recreates nor re-removes anything.
  const report = await f.controller.start();
  assert.deepEqual(report.removedServices, []);
  assert.equal(report.convertedGatewayOnly, false);
});

test("a legacy gateway role token normalizes to server on load and migrates on disk", async (t) => {
  const f = await fixture(t, "darwin");
  // Simulate a pre-rename install: the old code wrote "gateway" verbatim.
  await writeFile(
    path.join(f.root, "installation.json"),
    JSON.stringify({ version: 1, roles: ["client", "gateway"], autostart: true, lan: false }),
  );
  // Every load sees "server"…
  assert.deepEqual((await f.installation.load()).roles, ["client", "server"]);
  // …and migrate() persists the rename exactly once.
  const first = await f.installation.migrate();
  assert.equal(first.migrated, true);
  assert.deepEqual(first.roles, ["client", "server"]);
  const again = await f.installation.migrate();
  assert.equal(again.migrated, false);
});
