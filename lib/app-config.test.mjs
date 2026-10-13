import assert from "node:assert/strict";
import { access, constants, mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_DASHBOARD_PORT,
  configPaths,
  createAppConfigStore,
  defaultConfigRoot,
  expandTilde,
  nativeEnv,
} from "./app-config.mjs";

test("save writes a 0600 config file, creates the layout, and load round-trips", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "anything-obsidian-config-"));
  const store = createAppConfigStore({ rootDir: root });

  const saved = await store.save({
    vaultsRoot: "~/ObsidianVaults",
    anythingllmBaseUrl: "http://localhost:11301/",
    apiKey: "secret-key",
    dashboardPort: 11500,
  });

  assert.equal(saved.vaultsRoot, path.join(os.homedir(), "ObsidianVaults"));
  assert.equal(saved.anythingllmBaseUrl, "http://localhost:11301");
  assert.equal(saved.dashboardPort, 11500);
  const raw = await readFile(configPaths(root).configPath, { encoding: "utf8" });
  assert.match(raw, /"apiKey": "secret-key"/);
  assert.equal((await stat(configPaths(root).configPath)).mode & 0o777, 0o600);
  assert.equal((await stat(configPaths(root).secretsRoot)).mode & 0o777, 0o700);
  for (const dir of ["registry", "agent-tokens", "state", "logs", "run"]) {
    await access(path.join(root, dir), constants.W_OK);
  }

  const loaded = await store.load();
  assert.deepEqual(loaded, saved);
});

test("load returns null when the app has not been initialized", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "anything-obsidian-config-"));
  assert.equal(await createAppConfigStore({ rootDir: root }).load(), null);
});

test("config validation rejects invalid input", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "anything-obsidian-config-"));
  const store = createAppConfigStore({ rootDir: root });
  const base = { vaultsRoot: "/vaults", anythingllmBaseUrl: "http://localhost:11301", apiKey: "k" };

  await assert.rejects(() => store.save({ ...base, vaultsRoot: "relative/path" }), /absolute path/);
  await assert.rejects(() => store.save({ ...base, anythingllmBaseUrl: "not-a-url" }), /HTTP\(S\) URL/);
  await assert.rejects(() => store.save({ ...base, anythingllmBaseUrl: "ftp://localhost" }), /HTTP\(S\) URL/);
  await assert.rejects(() => store.save({ ...base, apiKey: "" }), /apiKey is required/);
  await assert.rejects(() => store.save({ ...base, dashboardPort: 0 }), /dashboardPort/);
  await assert.rejects(() => store.save({ ...base, dashboardPort: 70000 }), /dashboardPort/);
  assert.equal(await store.load(), null);
});

test("default config root honors ANYTHING_OBSIDIAN_HOME and platform conventions", () => {
  assert.equal(
    defaultConfigRoot({ env: { ANYTHING_OBSIDIAN_HOME: "/tmp/custom-home" }, homedir: "/Users/x", platform: "darwin" }),
    "/tmp/custom-home",
  );
  assert.equal(
    defaultConfigRoot({ env: {}, homedir: "/Users/x", platform: "darwin" }),
    "/Users/x/Library/Application Support/anything-obsidian",
  );
  assert.equal(
    defaultConfigRoot({ env: {}, homedir: "/Users/x", platform: "linux" }),
    "/Users/x/.config/anything-obsidian",
  );
  assert.equal(
    defaultConfigRoot({ env: { XDG_CONFIG_HOME: "/xdg" }, homedir: "/Users/x", platform: "linux" }),
    "/xdg/anything-obsidian",
  );
  assert.equal(
    defaultConfigRoot({ env: {}, homedir: "/Users/x", platform: "win32" }),
    path.join("/Users/x", "AppData", "Roaming", "anything-obsidian"),
  );
});

test("config paths derive the full native layout from one root", () => {
  const paths = configPaths("/tmp/app-root");
  assert.equal(paths.configPath, path.join("/tmp/app-root", "config.json"));
  assert.equal(paths.registryPath, path.join("/tmp/app-root", "registry", "vaults.json"));
  assert.equal(paths.secretsRoot, path.join("/tmp/app-root", "secrets"));
  assert.equal(paths.agentTokensRoot, path.join("/tmp/app-root", "agent-tokens"));
  assert.equal(paths.stateRoot, path.join("/tmp/app-root", "state"));
  assert.equal(paths.logsRoot, path.join("/tmp/app-root", "logs"));
  assert.equal(paths.runRoot, path.join("/tmp/app-root", "run"));
  assert.equal(paths.schedulerPidPath, path.join("/tmp/app-root", "run", "scheduler.pid"));
  assert.equal(paths.schedulerLogPath, path.join("/tmp/app-root", "logs", "scheduler.log"));
  assert.equal(paths.dashboardPidPath, path.join("/tmp/app-root", "run", "dashboard.pid"));
  assert.equal(paths.dashboardLogPath, path.join("/tmp/app-root", "logs", "dashboard.log"));
});

test("nativeEnv maps config values to the worker and server environment", () => {
  const paths = configPaths("/tmp/app-root");
  const env = nativeEnv(
    { vaultsRoot: "/Users/x/ObsidianVaults", anythingllmBaseUrl: "http://localhost:11301", apiKey: "secret", dashboardPort: DEFAULT_DASHBOARD_PORT },
    paths,
    { env: { PATH: "/bin:/usr/bin", HOME: "/Users/x", ANYTHINGLLM_API_KEY: "stale" } },
  );

  assert.equal(env.VAULTS_ROOT, "/Users/x/ObsidianVaults");
  assert.equal(env.VAULT_REGISTRY_PATH, paths.registryPath);
  assert.equal(env.VAULT_SECRETS_PATH, paths.secretsRoot);
  assert.equal(env.VAULT_STATE_ROOT, paths.stateRoot);
  assert.equal(env.AGENT_TOKENS_PATH, paths.agentTokensRoot);
  assert.equal(env.ANYTHINGLLM_BASE_URL, "http://localhost:11301");
  assert.equal(env.ANYTHINGLLM_API_KEY, "secret");
  assert.equal(env.DASHBOARD_PORT, String(DEFAULT_DASHBOARD_PORT));
  assert.equal(env.PATH, "/bin:/usr/bin");
  assert.equal(env.HOME, "/Users/x");
});

test("expandTilde resolves home-relative paths", () => {
  assert.equal(expandTilde("~", "/Users/x"), "/Users/x");
  assert.equal(expandTilde("~/Notes", "/Users/x"), path.join("/Users/x", "Notes"));
  assert.equal(expandTilde("/absolute/path", "/Users/x"), "/absolute/path");
  assert.equal(expandTilde("relative/path", "/Users/x"), "relative/path");
});
