import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WORKER_ACTIONS } from "./config.mjs";
import { redactSecretsText } from "./redact.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const WORKER_SCRIPT_PATH = path.join(repoRoot, "scripts", "worker.mjs");

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
  const children = new Map();
  const tasks = new Set();
  let closing = false;
  let restored = Promise.resolve();
  if (jobStore?.loadSync) {
    for (const job of jobStore.loadSync()) jobs.set(job.id, job);
  } else if (jobStore) {
    restored = (async () => {
      for (const job of await jobStore.load()) jobs.set(job.id, job);
    })();
  }

  const persist = () => (jobStore ? jobStore.save(Array.from(jobs.values())) : Promise.resolve());

  return {
    async start(vaultId, actionId, serviceSnapshot = []) {
      await restored;
      if (closing) throw new Error("Dashboard is stopping");
      const action = WORKER_ACTIONS[actionId];
      if (!action) throw new Error(`Unknown action: ${actionId}`);
      if (activeJobIds.has(vaultId))
        throw new Error(
          `A worker job is already running for vault '${vaultId}': ${activeJobIds.get(vaultId)}`,
        );
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
      try {
        await persist();
      } catch (error) {
        jobs.delete(id);
        activeJobIds.delete(vaultId);
        throw error;
      }

      const task = runLocalJob({
        job,
        action,
        vaultId,
        spawnImpl,
        nodePath,
        workerPath,
        cwd,
        env,
        logLimit,
        onChild: (child) => children.set(id, child),
        onUpdate: persist,
      })
        .catch((error) => {
          job.status = "failed";
          job.error = redactSecretsText(error instanceof Error ? error.message : String(error), [
            env.ANYTHINGLLM_API_KEY,
            env.GIT_PASSWORD,
          ]);
        })
        .finally(async () => {
          children.delete(id);
          job.finishedAt = new Date(now()).toISOString();
          activeJobIds.delete(vaultId);
          const terminal = [...jobs.values()].filter(
            (job) => !["queued", "running"].includes(job.status),
          );
          for (const old of terminal.slice(0, Math.max(0, terminal.length - 50)))
            jobs.delete(old.id);
          await persist();
        })
        .catch((error) =>
          console.error(
            redactSecretsText(`Job persistence failed: ${error.message}`, [
              env.ANYTHINGLLM_API_KEY,
            ]),
          ),
        );
      tasks.add(task);
      task.finally(() => tasks.delete(task));

      return job;
    },
    async close() {
      closing = true;
      for (const [id, child] of children) {
        jobs.get(id).error = "Interrupted by service stop";
        child.kill?.("SIGTERM");
      }
      const timer = setTimeout(() => {
        for (const child of children.values()) child.kill?.("SIGKILL");
      }, 5000);
      timer.unref();
      try {
        await Promise.all([...tasks]);
      } finally {
        clearTimeout(timer);
      }
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

async function runLocalJob({
  job,
  action,
  vaultId,
  spawnImpl,
  nodePath,
  workerPath,
  cwd,
  env,
  logLimit,
  onChild,
  onUpdate,
}) {
  job.status = "running";
  const args = [...action.command, "--vault", vaultId];
  const exitCode = await new Promise((resolve, reject) => {
    let logs = "",
      lastPersisted = 0;
    const capture = (chunk) => {
      logs = truncateLines(`${logs}${chunk}`, logLimit).slice(-64 * 1024);
      job.logs = redactSecretsText(logs, [env.ANYTHINGLLM_API_KEY, env.GIT_PASSWORD]);
      if (Date.now() - lastPersisted >= 500) {
        lastPersisted = Date.now();
        onUpdate().catch((error) => {
          job.error = `Cannot persist job progress: ${error.message}`;
          child.kill?.("SIGTERM");
        });
      }
    };
    const child = spawnImpl(nodePath, [workerPath, ...args], { cwd, env, windowsHide: true });
    onChild(child);
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    child.on("error", reject);
    child.on("close", (code) => {
      job.logs = redactSecretsText(logs, [env.ANYTHINGLLM_API_KEY, env.GIT_PASSWORD]);
      resolve(code);
    });
  });
  job.exitCode = exitCode;
  job.status = exitCode === 0 && !job.error ? "succeeded" : "failed";
  if (job.status === "failed" && !job.error)
    job.error =
      exitCode === null ? "Worker could not be started" : `Worker exited with ${exitCode}`;
}

function truncateLines(text, limit) {
  const lines = text.split("\n");
  return lines.length <= limit ? text : `${lines.slice(-limit).join("\n")}`;
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

function isRunning(services, id) {
  return services.some((service) => service.id === id && service.running);
}
