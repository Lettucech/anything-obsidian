import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

// Ports randomised per run: a killed previous run must never wedge this one.
const portBase = 24600 + Math.floor(Math.random() * 300);
let portCursor = portBase;
const nextPort = () => ++portCursor;

test("app.mjs boots one process, keeps the gateway off, and toggles it in-process", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "any-obs-app-entry-"));
  const ports = { dash: nextPort(), mcp: nextPort(), gw: nextPort() };
  let app;
  let stderr = "";
  // A child that already closed must resolve immediately: re-attaching
  // once("close") after the event fires never resolves.
  const onceClose = (child) =>
    child.exitCode !== null || child.signalCode
      ? Promise.resolve()
      : new Promise((resolve) => child.once("close", resolve));
  const stopApp = async () => {
    if (!app || app.exitCode !== null || app.signalCode) return;
    app.kill("SIGTERM");
    await Promise.race([onceClose(app), new Promise((r) => setTimeout(r, 5000))]);
    if (app.exitCode === null && app.signalCode === null) {
      app.kill("SIGKILL");
      await onceClose(app);
    }
  };
  t.after(async () => {
    await stopApp().catch(() => {});
    app?.stderr?.destroy();
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(path.join(root, "vaults"), { recursive: true });
  await mkdir(path.join(root, "gateway"), { recursive: true });
  await writeFile(path.join(root, "config.json"), JSON.stringify({
    vaultsRoot: path.join(root, "vaults"),
    anythingllmBaseUrl: "http://127.0.0.1:1", // unreachable: readiness stays degraded by design
    apiKey: "test-key",
    dashboardPort: ports.dash,
  }));
  await writeFile(path.join(root, "installation.json"), JSON.stringify({
    version: 1, roles: ["client"], autostart: true, lan: false,
  }));
  await writeFile(path.join(root, "gateway", "gateway.json"), JSON.stringify({
    anythingllmBaseUrl: "http://127.0.0.1:1", apiKey: "test-key", port: ports.gw,
  }));

  app = spawn(process.execPath, [path.join(repoRoot, "app.mjs")], {
    env: {
      ...process.env,
      ANYTHING_OBSIDIAN_HOME: root,
      DASHBOARD_PORT: String(ports.dash),
      MCP_PORT: String(ports.mcp),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  app.stderr.on("data", (chunk) => (stderr += chunk));

  const probe = async (port, pathname, init) => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
        signal: AbortSignal.timeout(2000),
        ...init,
      });
      return { status: res.status, body: await res.text() };
    } catch {
      return { status: 0, body: "" };
    }
  };
  const waitUntil = async (fn, ms = 15000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (app.exitCode !== null || app.signalCode) break; // child died: fail fast
      if (await fn()) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  };

  try {
    assert.ok(
      await waitUntil(async () => (await probe(ports.dash, "/health")).status === 200),
      `dashboard never became healthy; child stderr:\n${stderr.slice(0, 800)}`,
    );
    assert.equal((await probe(ports.mcp, "/health")).status, 200, stderr.slice(0, 800));
    // Default off: no gateway listener.
    assert.equal((await probe(ports.gw, "/ready")).status, 0);

    const post = (pathname, body) =>
      probe(ports.dash, pathname, {
        method: "POST",
        headers: { "content-type": "application/json", host: "127.0.0.1" },
        body: JSON.stringify(body),
      });

    const on = await post("/api/features/gateway", { action: "on" });
    assert.equal(on.status, 200, on.body.slice(0, 200));
    assert.equal(JSON.parse(on.body).running, true);
    assert.ok(
      await waitUntil(async () => (await probe(ports.gw, "/health")).status === 200),
      `gateway never served; child stderr:\n${stderr.slice(0, 800)}`,
    );
    assert.equal(JSON.parse((await probe(ports.gw, "/health")).body).name, "any-obs-gateway");

    const off = await post("/api/features/gateway", { action: "off" });
    assert.equal(off.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal((await probe(ports.gw, "/ready")).status, 0);

    // The dashboard route surface stays intact next to the mounted gateway.
    assert.match((await probe(ports.dash, "/gateway/")).body, /any-obs gateway/);

    await stopApp();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((await probe(ports.dash, "/health")).status, 0);
  } catch (error) {
    if (app.exitCode === null && app.signalCode === null) {
      throw new Error(`${error.message}\n[app stderr] ${stderr.slice(0, 1200)}`);
    }
    throw error;
  }
});
