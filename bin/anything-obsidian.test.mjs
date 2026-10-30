import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli, gatewayEnvironment, nodeVersionProblem } from "./anything-obsidian.mjs";
import { createAppConfigStore } from "../lib/app-config.mjs";
import { createInstallationStore } from "../lib/installation.mjs";
import { createGatewayConfig } from "../server/gateway-config.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "any-obs-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lines = [],
    calls = [];
  let running = true;
  const installation = createInstallationStore(root),
    store = createAppConfigStore({ rootDir: root });
  const services = {
    start: async () => {
      calls.push("start");
      running = true;
    },
    stop: async () => {
      calls.push("stop");
      running = false;
    },
    restart: async () => {
      calls.push("restart");
      running = true;
    },
    restartRole: async (role) => {
      calls.push(`restart:${role}`);
      running = true;
    },
    setAutostart: async (enabled) => installation.update({ autostart: enabled }),
    setLan: async (lan) => installation.update({ lan }),
    status: async () => {
      const p = await installation.load();
      return {
        roles: p.roles,
        services: Object.fromEntries(
          [
            ...(p.roles.includes("client") ? ["dashboard", "scheduler", "mcp"] : []),
            ...(p.roles.includes("gateway") ? ["gateway"] : []),
          ].map((name) => [name, { running, pid: running ? 100 : null }]),
        ),
        autostart: { enabled: p.autostart, guarantee: "after-login" },
      };
    },
  };
  let online = true;
  const fetchImpl = async (url) => {
    if (String(url).includes("/workspaces"))
      return new Response(JSON.stringify({ workspaces: [] }), { status: 200 });
    const name = String(url).includes(":21502")
      ? "any-obs-dashboard"
      : String(url).includes(":21503") || String(url).includes(":21504")
        ? "anything-obsidian-mcp"
        : "any-obs-gateway";
    return new Response(JSON.stringify({ ok: online, name, configRoot: root }), {
      status: online ? 200 : 503,
    });
  };
  const deps = {
    store,
    installation,
    services,
    env: { HOME: root, PATH: process.env.PATH, ANYTHING_OBSIDIAN_HOME: root },
    fetchImpl,
    execFileImpl: async () => ({ stdout: "git version 2" }),
    readinessTimeoutMs: 0,
    log: (line) => lines.push(line),
  };
  return {
    root,
    store,
    installation,
    deps,
    lines,
    calls,
    run: (args) => runCli(args, deps),
    setOnline: (value) => (online = value),
  };
}
const clientFlags = (root) => [
  "--vaults-root",
  root + "/vaults",
  "--url",
  "http://gateway.test",
  "--api-key",
  "client-key",
];

test("setup configures a client, registers its role and starts all services only after validation", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.run(["setup", ...clientFlags(f.root)]), 0);
  assert.equal((await f.store.load()).apiKey, "client-key");
  assert.deepEqual((await f.installation.load()).roles, ["client"]);
  assert.deepEqual(f.calls, ["start"]);
  assert.match(f.lines.join("\n"), /Services are ready/);
  assert.equal((await stat(f.store.paths.configPath)).mode & 0o777, 0o600);
});

test("a client and gateway on the same machine retain separate credentials in either setup order", async (t) => {
  for (const serverFirst of [true, false]) {
    const f = await fixture(t);
    const client = () => f.run(["setup", ...clientFlags(f.root)]);
    const server = () =>
      f.run(["setup", "--server", "--url", "http://upstream.test", "--api-key", "developer-key"]);
    assert.equal(await (serverFirst ? server() : client()), 0);
    assert.equal(await (serverFirst ? client() : server()), 0);
    const gateway = await createGatewayConfig({ dataDir: f.root + "/gateway" }).load();
    assert.equal(gateway.apiKey, "developer-key");
    assert.equal(gateway.anythingllmBaseUrl, "http://upstream.test");
    assert.equal((await f.store.load()).apiKey, "client-key");
    assert.equal((await f.installation.load()).roles.length, 2);
  }
});

test("rejected credentials are not saved and services are not started", async (t) => {
  const f = await fixture(t);
  f.deps.fetchImpl = async () => new Response("{}", { status: 401 });
  assert.equal(await f.run(["setup", ...clientFlags(f.root)]), 1);
  assert.equal(await f.store.load(), null);
  assert.deepEqual(f.calls, []);
});

test("status fails for stopped or unhealthy services, and succeeds only when every required service is ready", async (t) => {
  const f = await fixture(t);
  await f.run(["setup", ...clientFlags(f.root)]);
  await f.run(["stop"]);
  assert.equal(await f.run(["status", "--json"]), 1);
  assert.equal(JSON.parse(f.lines.at(-1)).ok, false);
  f.setOnline(false);
  assert.equal(await f.run(["start"]), 1);
  f.setOnline(true);
  assert.equal(await f.run(["start"]), 0);
  assert.equal(await f.run(["status", "--json"]), 0);
});

test("stop/restart preserve startup preference and autostart off does not stop running services", async (t) => {
  const f = await fixture(t);
  await f.run(["setup", ...clientFlags(f.root)]);
  await f.run(["stop"]);
  assert.equal((await f.installation.load()).autostart, true);
  await f.run(["restart"]);
  assert.deepEqual(f.calls, ["start", "stop", "restart"]);
  await f.run(["autostart", "off"]);
  assert.equal((await f.installation.load()).autostart, false);
  assert.equal(f.calls.at(-1), "restart");
});

test("foreground gateway runner never receives client credentials, inherited upstream settings or port overrides", async (t) => {
  const f = await fixture(t);
  await f.run(["setup", "--server", "--url", "http://upstream.test", "--api-key", "developer-key"]);
  let options;
  f.deps.spawnImpl = (_command, _args, opts) => {
    options = opts;
    const child = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => child.emit("close", 0));
    return child;
  };
  Object.assign(f.deps.env, {
    ANYTHINGLLM_API_KEY: "wrong",
    ANYTHINGLLM_BASE_URL: "http://wrong",
    GATEWAY_PORT: "29999",
  });
  assert.equal(await f.run(["run", "gateway"]), 0);
  assert.equal(options.env.ANYTHINGLLM_API_KEY, undefined);
  assert.equal(options.env.GATEWAY_PORT, undefined);
  assert.equal(options.env.ANYTHING_OBSIDIAN_HOME, f.root);
  assert.deepEqual(gatewayEnvironment(f.root, f.deps.env), options.env);
});

test("strict argument parsing rejects removed commands and unknown flags", async (t) => {
  const f = await fixture(t);
  for (const args of [
    ["start", "--bg"],
    ["start", "--detach"],
    ["setup", "--unknown"],
    ["start-bg"],
    ["init"],
    ["gateway"],
  ])
    assert.notEqual(await f.run(args), 0);
  assert.equal(await f.run(["--help"]), 0);
  assert.equal(nodeVersionProblem("22.14.0"), null);
  assert.match(nodeVersionProblem("20.1.0"), /needs Node/);
});

test("reconfiguration applies the changed role and preserves vault location, LAN settings and ports", async (t) => {
  const f = await fixture(t);
  await f.run(["setup", ...clientFlags(f.root)]);
  const previous = await f.store.load();
  await f.store.save({ ...previous, mcpAllowedHosts: "notes.local", notifications: false });
  assert.equal(
    await f.run(["setup", "--url", "http://replacement.test", "--api-key", "new-key"]),
    0,
  );
  const current = await f.store.load();
  assert.equal(current.vaultsRoot, previous.vaultsRoot);
  assert.equal(current.mcpAllowedHosts, "notes.local");
  assert.equal(current.notifications, false);
  assert.equal(current.apiKey, "new-key");
  assert.ok(f.calls.includes("restart:client"));
});

test("LAN allowed hosts and generated token are persisted and JSON output is one object", async (t) => {
  const f = await fixture(t);
  await f.run(["setup", ...clientFlags(f.root)]);
  f.lines.length = 0;
  assert.equal(
    await f.run(["lan", "on", "--allowed-hosts", "notes.local,192.168.1.10", "--json"]),
    0,
  );
  assert.equal(f.lines.length, 1);
  const output = JSON.parse(f.lines[0]);
  assert.ok(output.token);
  assert.equal((await f.store.load()).mcpAllowedHosts, "notes.local,192.168.1.10");
  assert.equal((await f.store.load()).lanToken, output.token);
});

test("JSON status errors remain machine readable when configuration is corrupt", async (t) => {
  const { writeFile } = await import("node:fs/promises");
  const f = await fixture(t);
  await f.run(["setup", ...clientFlags(f.root)]);
  await writeFile(f.store.paths.configPath, "{bad json");
  assert.equal(await f.run(["status", "--json"]), 1);
  const output = JSON.parse(f.lines.at(-1));
  assert.equal(output.ok, false);
  assert.ok(output.error);
});
