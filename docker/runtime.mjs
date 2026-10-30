import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, rm, chmod, appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { containerSocketPath } from "../lib/container-services.mjs";
import { rotateLogs } from "../lib/log-rotate.mjs";
import { redactSecretsText } from "../dashboard/redact.mjs";

const cli = fileURLToPath(new URL("../bin/anything-obsidian.mjs", import.meta.url));
export async function startContainerRuntime({
  root,
  role,
  env = process.env,
  secrets = [],
  spawnImpl = spawn,
  stopTimeoutMs = 20_000,
  output = process.stdout,
}) {
  if (!["client", "gateway"].includes(role))
    throw new Error("Container role must be client or gateway");
  const roles = role === "gateway" ? ["gateway"] : ["dashboard", "scheduler", "mcp"];
  const children = new Map();
  const paused = new Set();
  const socketPath = containerSocketPath(root);
  let stopping = false,
    finish;
  const done = new Promise((resolve) => (finish = resolve));
  let writes = Promise.resolve();
  await mkdir(path.dirname(socketPath), { recursive: true });
  await mkdir(path.join(root, "logs"), { recursive: true });
  await rm(socketPath, { force: true });
  const clean = (text) =>
    secrets
      .filter(Boolean)
      .reduce((value, secret) => value.split(secret).join("[redacted]"), redactSecretsText(text));
  const log = (name, text) => {
    text = clean(text);
    output.write(`[${name}] ${text}`);
    writes = writes.then(() =>
      appendFile(path.join(root, "logs", `${name}.log`), text, { mode: 0o600 }),
    );
    writes.catch(() => shutdown(1));
  };
  function launch(name) {
    if (stopping || children.has(name)) return;
    paused.delete(name);
    const child = spawnImpl(process.execPath, [cli, "run", name], {
      env: {
        ...env,
        ANYTHING_OBSIDIAN_HOME: root,
        AO_CONTAINER: "1",
        AO_CONTAINER_ROLE: role,
        AO_SUPERVISED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const record = { child, exited: new Promise((resolve) => child.once("close", resolve)) };
    children.set(name, record);
    for (const stream of [child.stdout, child.stderr]) {
      let pending = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        pending += chunk;
        let newline;
        while ((newline = pending.indexOf("\n")) >= 0) {
          log(name, pending.slice(0, newline + 1));
          pending = pending.slice(newline + 1);
        }
        if (pending.length > 64 * 1024) {
          log(name, "[oversized log line omitted]\n");
          pending = "";
        }
      });
      stream.on("end", () => {
        if (pending) log(name, pending + "\n");
      });
    }
    child.once("error", (error) => {
      log(name, `${error.message}\n`);
      void shutdown(1);
    });
    child.once("exit", (code, exitSignal) => {
      record.abruptExit = Boolean(exitSignal);
      if (!stopping && !paused.has(name)) {
        log(name, `Service exited unexpectedly (${code}); restarting the container is required.\n`);
        void shutdown(1);
      }
    });
    child.once("close", () => {
      if (children.get(name) === record) children.delete(name);
    });
  }
  function signal(record, value) {
    try {
      process.kill(-record.child.pid, value);
    } catch (error) {
      if (error.code !== "ESRCH") record.child.kill(value);
    }
  }
  async function stopChild(name) {
    const record = children.get(name);
    if (!record) return;
    signal(record, "SIGTERM");
    const timer = setTimeout(() => signal(record, "SIGKILL"), stopTimeoutMs);
    try {
      await record.exited;
      // The runtime owns the volume lease and has drained this process group.
      // An abruptly killed wrapper cannot release its own heartbeat lock. Remove
      // only that fresh, orphaned service lease so Docker recovery need not wait
      // for expiry. A normally exiting wrapper releases its lease itself.
      if (record.abruptExit)
        await rm(path.join(root, "run", `${name}.lock`), { recursive: true, force: true });
    } finally {
      clearTimeout(timer);
    }
  }
  const snapshot = () => ({
    roles: [role],
    lan: false,
    autostart: {
      enabled: null,
      registered: null,
      guarantee: "managed-by-docker",
      manager: "docker",
    },
    services: Object.fromEntries(
      roles.map((name) => [
        name,
        {
          running: children.has(name),
          pid: children.get(name)?.child.pid ?? null,
          paused: paused.has(name),
        },
      ]),
    ),
  });
  let action = Promise.resolve();
  const server = createServer((req, res) => {
    action = action
      .then(async () => {
        const respond = (status, data) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(data));
        };
        if (req.method === "GET" && req.url === "/status") return respond(200, snapshot());
        if (
          role !== "client" ||
          !["/services/scheduler/start", "/services/scheduler/stop"].includes(req.url) ||
          req.method !== "POST"
        )
          return respond(409, {
            error: "Docker manages this service. Only scheduler pause/resume is available here.",
          });
        if (stopping) return respond(503, { error: "Container is stopping" });
        if (req.url.endsWith("/stop")) {
          paused.add("scheduler");
          await stopChild("scheduler");
        } else launch("scheduler");
        respond(200, snapshot());
      })
      .catch((error) => {
        if (!res.headersSent) res.writeHead(500);
        res.end(JSON.stringify({ error: clean(error.message) }));
      });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  for (const name of roles) launch(name);
  const timer = setInterval(() => {
    rotateLogs({ logsRoot: path.join(root, "logs") }).catch(() => shutdown(1));
  }, 30_000).unref();
  async function shutdown(code = 0) {
    if (stopping) return done;
    stopping = true;
    clearInterval(timer);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await Promise.all([...children.keys()].map(stopChild));
    await writes.catch(() => {});
    await rm(socketPath, { force: true });
    finish(code);
    return done;
  }
  return { done, shutdown, snapshot };
}
