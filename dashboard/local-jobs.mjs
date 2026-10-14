import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WORKER_ACTIONS } from "./config.mjs";
import { redactSecretsText } from "./redact.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const WORKER_SCRIPT_PATH = path.join(repoRoot, "scripts", "worker.mjs");
export const SERVER_SCRIPT_PATH = path.join(repoRoot, "dashboard", "server.mjs");

export function createLocalJobManager({
  env = {},
  workerPath = WORKER_SCRIPT_PATH,
  // argv[0] keeps the renamed display binary so worker processes carry the
  // anything-obsidian name in Activity Monitor too.
  nodePath = process.argv[0] || process.execPath,
  cwd = repoRoot,
  now = Date.now,
  spawnImpl = nodeSpawn,
  logLimit = 500,
  jobStore = null,
} = {}) {
  const jobs = new Map();
  const activeJobIds = new Map();
  let restored = Promise.resolve();
  if (jobStore?.loadSync) {
    for (const job of jobStore.loadSync()) jobs.set(job.id, job);
  } else if (jobStore) {
    restored = (async () => {
      for (const job of await jobStore.load()) jobs.set(job.id, job);
    })();
  }

  const persist = () => (jobStore
    ? jobStore.save(Array.from(jobs.values())).catch(() => {})
    : Promise.resolve());

  return {
    async start(vaultId, actionId, serviceSnapshot = []) {
      await restored;
      if (Array.isArray(actionId)) {
        serviceSnapshot = actionId;
        actionId = vaultId;
        vaultId = "legacy";
      }
      const action = WORKER_ACTIONS[actionId];
      if (!action) throw new Error(`Unknown action: ${actionId}`);
      if (activeJobIds.has(vaultId)) throw new Error(`A worker job is already running for vault '${vaultId}': ${activeJobIds.get(vaultId)}`);
      if (action.requiresAnythingLLM && !isRunning(serviceSnapshot, "anythingllm")) {
        throw new Error(`${action.label} requires AnythingLLM to be running`);
      }

      const id = `job-${now()}-${randomUUID().slice(0, 8)}`;
      const job = {
        id,
        vaultId,
        actionId,
        label: action.label,
        status: "queued",
        startedAt: new Date(now()).toISOString(),
        finishedAt: null,
        exitCode: null,
        logs: "",
        error: null,
      };
      jobs.set(id, job);
      activeJobIds.set(vaultId, id);
      await persist();

      runLocalJob({ job, action, vaultId, spawnImpl, nodePath, workerPath, cwd, env, logLimit })
        .catch((error) => {
          job.status = "failed";
          job.error = error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
          job.finishedAt = new Date(now()).toISOString();
          activeJobIds.delete(vaultId);
          persist();
        });

      return job;
    },
    get(id) {
      return jobs.get(id) || null;
    },
    latest() {
      return Array.from(jobs.values()).at(-1) || null;
    },
    list() {
      return Array.from(jobs.values());
    },
  };
}

async function runLocalJob({ job, action, vaultId, spawnImpl, nodePath, workerPath, cwd, env, logLimit }) {
  job.status = "running";
  const args = [...action.command, ...(vaultId && vaultId !== "legacy" ? ["--vault", vaultId] : [])];
  const exitCode = await new Promise((resolve, reject) => {
    let logs = "";
    const capture = (chunk) => {
      logs = truncateLines(`${logs}${chunk}`, logLimit);
      job.logs = redactSecretsText(logs);
    };
    const child = spawnImpl(nodePath, [workerPath, ...args], { cwd, env, windowsHide: true });
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    child.on("error", reject);
    child.on("close", (code) => {
      job.logs = redactSecretsText(logs);
      resolve(code);
    });
  });
  job.exitCode = exitCode;
  job.status = exitCode === 0 ? "succeeded" : "failed";
  if (job.status === "failed") job.error = exitCode === null ? "Worker could not be started" : `Worker exited with ${exitCode}`;
}

function truncateLines(text, limit) {
  const lines = text.split("\n");
  return lines.length <= limit ? text : `${lines.slice(-limit).join("\n")}`;
}

export function startDashboardProcess({
  env,
  nodePath = process.execPath,
  serverPath = SERVER_SCRIPT_PATH,
  cwd = repoRoot,
  pidPath,
  logPath,
  spawnImpl = nodeSpawn,
  killImpl = defaultKill,
} = {}) {
  const existing = readSchedulerStatus({ pidPath, killImpl });
  if (existing.running) return { started: false, alreadyRunning: true, pid: existing.pid };

  mkdirSync(path.dirname(pidPath), { recursive: true });
  mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, "a");
  try {
    const child = spawnImpl(nodePath, [serverPath], {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
    });
    writeFileSync(pidPath, `${child.pid}\n`);
    child.unref?.();
    return { started: true, pid: child.pid };
  } finally {
    closeSync(logFd);
  }
}

export async function waitForHttp(url, { fetchImpl = fetch, timeoutMs = 10000, sleep = defaultSleep } = {}) {
  const stepMs = 200;
  for (let waited = 0; waited < timeoutMs; waited += stepMs) {
    try {
      const response = await fetchImpl(url);
      if (response.status < 500) return true;
    } catch {
      // not serving yet
    }
    await sleep(stepMs);
  }
  return false;
}

export function startSchedulerProcess({
  env,
  nodePath = process.execPath,
  workerPath = WORKER_SCRIPT_PATH,
  cwd = repoRoot,
  pidPath,
  logPath,
  spawnImpl = nodeSpawn,
  killImpl = defaultKill,
} = {}) {
  const existing = readSchedulerStatus({ pidPath, killImpl });
  if (existing.running) return { started: false, alreadyRunning: true, pid: existing.pid };

  mkdirSync(path.dirname(pidPath), { recursive: true });
  mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, "a");
  try {
    const child = spawnImpl(nodePath, [workerPath, "scheduler"], {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
    });
    writeFileSync(pidPath, `${child.pid}\n`);
    child.unref?.();
    return { started: true, pid: child.pid };
  } finally {
    closeSync(logFd);
  }
}

export function stopSchedulerProcess({ pidPath, killImpl = defaultKill, graceMs = 5000, sleep = defaultSleep } = {}) {
  const status = readSchedulerStatus({ pidPath, killImpl });
  if (!status.running) {
    removePidFile(pidPath);
    return { stopped: false, pid: status.pid };
  }
  killImpl(status.pid, "SIGTERM");
  return (async () => {
    const stepMs = 100;
    for (let waited = 0; waited < graceMs && isProcessAlive(status.pid, killImpl); waited += stepMs) {
      await sleep(stepMs);
    }
    if (isProcessAlive(status.pid, killImpl)) {
      killImpl(status.pid, "SIGKILL");
    }
    removePidFile(pidPath);
    return { stopped: true, pid: status.pid };
  })();
}

export function readSchedulerStatus({ pidPath, killImpl = defaultKill } = {}) {
  let pid;
  try {
    pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
  } catch {
    return { running: false, pid: null };
  }
  if (!Number.isInteger(pid) || pid <= 0) return { running: false, pid: null };
  return { running: isProcessAlive(pid, killImpl), pid };
}

export function tailLogFile(filePath, lines = 300) {
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
  const entries = text.split("\n");
  if (entries.at(-1) === "") entries.pop();
  return entries.slice(-lines).join("\n");
}

function isProcessAlive(pid, killImpl) {
  try {
    killImpl(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function removePidFile(pidPath) {
  try {
    rmSync(pidPath, { force: true });
  } catch {
    // best effort cleanup
  }
}

function defaultKill(pid, signal) {
  process.kill(pid, signal);
}

async function defaultSleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isRunning(services, id) {
  return services.some((service) => service.id === id && service.running);
}
