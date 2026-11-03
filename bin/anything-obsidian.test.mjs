import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PassThrough } from "node:stream";
import { runCli, gatewayEnvironment, nodeVersionProblem, chooseOption } from "./anything-obsidian.mjs";
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
    status: async () => {
      const p = await installation.load();
      return {
        roles: p.roles,
        services: Object.fromEntries(
          (p.roles.length ? ["app"] : []).map((name) => [
            name,
            { running, pid: running ? 100 : null },
          ]),
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
    if (String(url).includes("/api/")) {
      // Dashboard-mounted gateway admin API and feature endpoints.
      return new Response(JSON.stringify({ jobs: [], sources: [], vaults: [], enabled: true }), {
        status: online ? 200 : 503,
      });
    }
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

test("setup --server configures the client and enables the gateway; gateway.json stays its own store", async (t) => {
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
    // The last setup wins for config.json; gateway.json keeps its own copy
    // and is the only credential store the gateway ever reads.
    assert.equal(
      (await f.store.load()).apiKey,
      serverFirst ? "client-key" : "developer-key",
    );
    const roles = (await f.installation.load()).roles;
    assert.ok(roles.includes("client") && roles.includes("server"));
  }
});

test("rejected credentials are not saved and services are not started", async (t) => {
  const f = await fixture(t);
  f.deps.fetchImpl = async () => new Response("{}", { status: 401 });
  assert.equal(await f.run(["setup", ...clientFlags(f.root)]), 1);
  assert.equal(await f.store.load(), null);
  assert.deepEqual(f.calls, []);
});

function fakePromptFactory(f, questions) {
  return () => ({
    question: async (text, fallback) => {
      questions.push(text);
      const answer = f.answers.shift();
      return answer === undefined ? fallback : answer;
    },
    confirm: async () => true,
    secret: async (text, fallback) => {
      questions.push(text);
      const answer = f.answers.shift();
      return answer === undefined ? fallback : answer;
    },
    choose: async (text, options, opts = {}) => {
      questions.push(text);
      const answer = f.answers.shift();
      if (answer === undefined || answer === "") return opts.defaultIndex ?? 0;
      return Number(answer) - 1;
    },
    close() {},
  });
}

test("interactive setup asks the mode and collects server join values separately", async (t) => {
  const f = await fixture(t);
  const questions = [];
  f.deps.promptFactory = fakePromptFactory(f, questions);
  f.answers = ["2", "http://server.test", "issued-token"];
  assert.equal(await f.run(["setup", "--vaults-root", f.root + "/vaults"]), 0);
  const asked = questions.join("\n");
  assert.match(asked, /joining a server/);
  assert.match(asked, /Server URL/);
  assert.match(asked, /User token from your administrator/);
  assert.doesNotMatch(asked, /developer API key/);
  const config = await f.store.load();
  assert.equal(config.anythingllmBaseUrl, "http://server.test");
  assert.equal(config.apiKey, "issued-token");
});

test("interactive setup defaults to the local AnythingLLM prompts", async (t) => {
  const f = await fixture(t);
  const questions = [];
  f.deps.promptFactory = fakePromptFactory(f, questions);
  // Empty answer accepts the default mode (local).
  f.answers = ["", "http://anythingllm.test", "dev-key"];
  assert.equal(await f.run(["setup", "--vaults-root", f.root + "/vaults"]), 0);
  const asked = questions.join("\n");
  assert.match(asked, /AnythingLLM URL/);
  assert.match(asked, /AnythingLLM developer API key/);
  assert.doesNotMatch(asked, /User token from your administrator/);
  assert.equal((await f.store.load()).apiKey, "dev-key");
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
    ["gateway", "bogus"],
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
  assert.ok(f.calls.includes("restart"));
});

test("the retired lan command is a no-op pointing at the server feature", async (t) => {
  const f = await fixture(t);
  await f.run(["setup", ...clientFlags(f.root)]);
  f.lines.length = 0;
  assert.equal(await f.run(["lan", "on", "--json"]), 0);
  const output = JSON.parse(f.lines[0]);
  assert.equal(output.deprecated, true);
  assert.match(output.message, /server on/);
  // Nothing changed on disk.
  assert.equal((await f.store.load()).lanToken, undefined);
});

test("the server command reports status and gateway stays as a deprecated alias", async (t) => {
  const f = await fixture(t);
  await f.run(["setup", ...clientFlags(f.root)]);
  f.lines.length = 0;
  assert.equal(await f.run(["server", "status"]), 0);
  assert.match(f.lines.at(-1), /^Server: off/);
  f.lines.length = 0;
  assert.equal(await f.run(["gateway", "status"]), 0);
  assert.match(f.lines[0], /Deprecation/);
  assert.match(f.lines.at(-1), /^Server: off/);
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

function rawIO() {
  const input = new EventEmitter();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (value) => {
    input.isRaw = value;
  };
  input.resume = () => {};
  const written = [];
  return { input, output: { write: (text) => written.push(String(text)) }, written };
}

test("chooseOption: arrow keys move, enter picks, digits shortcut, ctrl+c cancels", async () => {
  const { input, output, written } = rawIO();
  const pending = chooseOption({ input, output }, "Pick", ["Local", "Gateway"], { defaultIndex: 0 });
  input.emit("data", "\x1b[B"); // down → Gateway
  input.emit("data", "\x1b[A"); // up → Local
  input.emit("data", "\x1b[B"); // down → Gateway
  input.emit("data", "\r");
  assert.equal(await pending, 1);
  assert.equal(input.isRaw, false); // raw mode restored
  assert.ok(written.join("").includes("❯"));

  const second = chooseOption({ input, output }, "Pick", ["Local", "Gateway"], { defaultIndex: 0 });
  input.emit("data", "2"); // digit shortcut
  assert.equal(await second, 1);

  const third = chooseOption({ input, output }, "Pick", ["Local", "Gateway"], { defaultIndex: 0 });
  input.emit("data", "\x03");
  await assert.rejects(third, /Setup cancelled/);
});

test("chooseOption: non-TTY input falls back to a numbered question", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const pending = chooseOption({ input, output }, "Pick", ["Local", "Gateway"], { defaultIndex: 0 });
  input.write("2\n");
  assert.equal(await pending, 1);
  input.end();
});

test("connect --list reports detected coding agents", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, ".codex"), { recursive: true });
  await mkdir(path.join(f.root, ".cursor"), { recursive: true });
  assert.equal(await f.run(["connect", "--list", "--json"]), 0);
  const rows = JSON.parse(f.lines.at(-1));
  const byId = Object.fromEntries(rows.map((row) => [row.id, row.detected]));
  assert.equal(byId.codex, true);
  assert.equal(byId.cursor, true);
  assert.equal(byId["claude-code"], false);
});

test("connect <agent> writes the config, is idempotent and removes cleanly", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, ".codex"), { recursive: true });
  const tomlPath = path.join(f.root, ".codex", "config.toml");

  assert.equal(await f.run(["connect", "codex", "--json"]), 0);
  const first = JSON.parse(f.lines.at(-1));
  assert.equal(first.results[0].status, "connected");
  assert.equal(first.appReachable, true);
  assert.match(await readFile(tomlPath, "utf8"), /\[mcp_servers\.anything-obsidian\]/);

  assert.equal(await f.run(["connect", "codex", "--json"]), 0);
  const second = JSON.parse(f.lines.at(-1));
  assert.equal(second.results[0].status, "unchanged");

  assert.equal(await f.run(["connect", "--remove", "codex", "--json"]), 0);
  const third = JSON.parse(f.lines.at(-1));
  assert.equal(third.results[0].status, "removed");
  assert.equal(third.appReachable, undefined);
  assert.doesNotMatch(await readFile(tomlPath, "utf8"), /anything-obsidian/);
});

test("connect with no args wires every detected agent", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, ".claude"), { recursive: true });
  await mkdir(path.join(f.root, ".cursor"), { recursive: true });
  assert.equal(await f.run(["connect", "--json"]), 0);
  const payload = JSON.parse(f.lines.at(-1));
  assert.deepEqual(
    payload.results.map((result) => result.id).sort(),
    ["claude-code", "cursor"],
  );
  assert.equal(payload.appReachable, true);
});

test("connect with no detected agents reports and exits cleanly", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.run(["connect"]), 0);
  assert.match(f.lines.join("\n"), /No supported coding agents detected/);
});

test("connect with an unknown agent fails and lists the known agents", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.run(["connect", "nope"]), 1);
  assert.match(f.lines.join("\n"), /Unknown agent "nope"/);
});

test("connect flags a missing explicit target and an unreachable app", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.run(["connect", "codex"]), 1);
  assert.match(f.lines.join("\n"), /not-installed/);

  await mkdir(path.join(f.root, ".codex"), { recursive: true });
  f.setOnline(false);
  assert.equal(await f.run(["connect", "codex"]), 0);
  const text = f.lines.join("\n");
  assert.match(text, /anything-obsidian start/);
  assert.match(text, /npx skills add Lettucech\/anything-obsidian/);
});
