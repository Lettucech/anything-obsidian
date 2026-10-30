import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { Writable } from "node:stream";
import { once } from "node:events";
import {
  createAdminGate,
  ensureContainerToken,
  containerTokenPath,
} from "../lib/container-admin.mjs";
import { createContainerController } from "../lib/container-services.mjs";
import { createVaultRegistry } from "../lib/vault-registry.mjs";
import { createSourceManager } from "../server/sources.mjs";
import { createVaultStorage } from "../dashboard/vault-storage.mjs";
import { startContainerRuntime } from "../docker/runtime.mjs";
import { runCli } from "../bin/anything-obsidian.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "any-obs-container-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    env: {
      AO_CONTAINER: "1",
      AO_CONTAINER_ROLE: "client",
      ANYTHING_OBSIDIAN_HOME: root,
      HOME: root,
      PATH: process.env.PATH,
    },
  };
}

test("Docker administration requires a token or signed, expiring session and rejects cross-origin requests", async (t) => {
  const { root, env } = await fixture(t);
  const token = await ensureContainerToken(root);
  assert.equal(await ensureContainerToken(root), token);
  assert.equal((await stat(containerTokenPath(root))).mode & 0o777, 0o600);
  let now = Date.now();
  const gate = createAdminGate(env, { now: () => now });
  const server = createServer(async (req, res) => {
    try {
      if (await gate(req, res)) {
        res.writeHead(200);
        res.end('{"ok":true}');
      }
    } catch (error) {
      res.writeHead(error.statusCode || 500);
      res.end(error.message);
    }
  }).listen(0, "127.0.0.1");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.match(await (await fetch(base)).text(), /Docker admin login/);
  assert.equal((await fetch(base + "/api/status")).status, 401);
  assert.equal(
    (
      await fetch(base + "/api/status", {
        headers: { Authorization: `Bearer ${token}`, Origin: "http://evil.example" },
      })
    ).status,
    403,
  );
  const login = await fetch(base + "/container/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  assert.ok(!cookie.includes(token));
  const headers = { Cookie: cookie.split(";")[0] };
  assert.equal((await fetch(base + "/api/status", { headers })).status, 200);
  assert.equal(
    (await fetch(base + "/api/status", { headers: { Cookie: headers.Cookie + "tampered" } }))
      .status,
    401,
  );
  now += 8 * 60 * 60_000 + 1;
  assert.equal((await fetch(base + "/api/status", { headers })).status, 401);
  assert.equal(
    (await fetch(base + "/ready", { headers: { Authorization: `Bearer ${token}` } })).status,
    200,
  );
});

test("Docker rejects import and filesystem Git sources at the storage and registry boundaries", async (t) => {
  const { root, env } = await fixture(t);
  const registry = createVaultRegistry({
    rootPath: root + "/vaults",
    registryPath: root + "/registry.json",
    env,
  });
  await assert.rejects(
    registry.create({ id: "secret", importPath: "/etc" }),
    /unavailable in Docker/,
  );
  assert.throws(
    () => registry.resolvePath({ location: "imported", importPath: "/etc" }),
    /unavailable in Docker/,
  );
  const storage = createVaultStorage({
    registry,
    env,
    runGit: () => {
      throw new Error("must not execute Git");
    },
  });
  await assert.rejects(storage.import({ importPath: "/etc" }), /unavailable in Docker/);
  await assert.rejects(storage.clone({ repositoryUrl: "file:///etc" }), /HTTP\(S\)/);
  const sources = createSourceManager({
    dataDir: root + "/gateway",
    baseUrl: "http://upstream.test",
    apiKey: "key",
    env,
  });
  t.after(() => sources.close());
  await assert.rejects(
    sources.create({ id: "secret", kind: "dir", ref: "/etc", workspace: "shared" }),
    /unavailable in Docker/,
  );
  for (const ref of [
    "/etc",
    "file:///etc",
    "https://user:secret@git.example/repo",
    "--upload-pack=bad",
  ])
    await assert.rejects(
      sources.create({ id: "secret", kind: "git", ref, workspace: "shared" }),
      /HTTP\(S\)/,
    );
});

test("Docker setup saves an isolated client without invoking a native supervisor", async (t) => {
  const { root, env } = await fixture(t);
  const output = [];
  const services = {
    status: async () => {
      throw new Error("offline");
    },
    start() {
      throw new Error("native supervisor must not run");
    },
  };
  assert.equal(
    await runCli(["setup", "--url", "http://upstream.test", "--api-key", "test-key"], {
      env,
      services,
      log: (line) => output.push(line),
      execFileImpl: async () => ({}),
      fetchImpl: async () => new Response('{"workspaces":[]}'),
    }),
    0,
  );
  const config = JSON.parse(await readFile(root + "/config.json", "utf8"));
  assert.equal(config.vaultsRoot, root + "/vaults");
  assert.ok(config.lanToken.length >= 32);
  assert.ok(!output.join("\n").includes("test-key"));
  for (const command of ["start", "stop", "restart", "update", "autostart", "lan"])
    assert.equal(await runCli([command], { env, services, log: () => {} }), 1);
});

test("container supervisor pauses/resumes the scheduler and drains siblings after an unexpected service exit", async (t) => {
  const { root, env } = await fixture(t);
  const spawned = [];
  const runtime = await startContainerRuntime({
    root,
    role: "client",
    env,
    stopTimeoutMs: 1000,
    output: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
    spawnImpl: (_node, _args, options) => {
      const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], options);
      spawned.push(child);
      return child;
    },
  });
  t.after(() => runtime.shutdown());
  const controller = createContainerController({ root });
  assert.equal((await controller.status()).services.scheduler.running, true);
  await controller.stopService("scheduler");
  assert.equal((await controller.status()).services.scheduler.paused, true);
  await controller.startService("scheduler");
  assert.equal((await controller.status()).services.scheduler.running, true);
  await assert.rejects(controller.stopService("mcp"), /Only scheduler/);
  spawned[0].kill("SIGKILL");
  assert.equal(await runtime.done, 1);
  assert.ok(spawned.every((child) => child.exitCode !== null || child.signalCode !== null));
});
