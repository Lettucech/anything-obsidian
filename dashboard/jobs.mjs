import { randomUUID } from "node:crypto";

import { WORKER_ACTIONS } from "./config.mjs";
import { redactSecretsText } from "./redact.mjs";

const PROJECT_NAME = "anything-obsidian";
const WORKER_IMAGE = "anything-obsidian-worker";

export function createJobManager({ docker, now = Date.now } = {}) {
  const jobs = new Map();
  let activeJobId = null;

  return {
    async start(actionId, serviceSnapshot = []) {
      const action = WORKER_ACTIONS[actionId];
      if (!action) throw new Error(`Unknown action: ${actionId}`);
      if (activeJobId) throw new Error(`A worker job is already running: ${activeJobId}`);
      if (action.requiresAnythingLLM && !isRunning(serviceSnapshot, "anythingllm")) {
        throw new Error(`${action.label} requires AnythingLLM to be running`);
      }

      const id = `job-${now()}-${randomUUID().slice(0, 8)}`;
      const job = {
        id,
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
      activeJobId = id;

      runJob({ docker, job, action })
        .catch((error) => {
          job.status = "failed";
          job.error = error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
          job.finishedAt = new Date(now()).toISOString();
          activeJobId = null;
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

async function runJob({ docker, job, action }) {
  job.status = "running";
  const syncer = await docker.inspectContainerDetails("anything-obsidian-syncer");
  const container = await docker.createContainer(workerContainerConfig({ syncer, action }));
  try {
    await docker.startContainerById(container.Id);
    const result = await docker.waitContainer(container.Id);
    job.exitCode = result.StatusCode;
    job.logs = redactSecretsText(await docker.containerLogs(container.Id, { tail: 500 }));
    job.status = result.StatusCode === 0 ? "succeeded" : "failed";
    if (job.status === "failed") job.error = `Worker exited with ${result.StatusCode}`;
  } finally {
    await docker.removeContainer(container.Id);
  }
}

export function workerContainerConfig({ syncer, action }) {
  return {
    Image: syncer.Config?.Image || WORKER_IMAGE,
    Cmd: [...action.command],
    Env: workerEnv(syncer.Config?.Env || []),
    HostConfig: {
      AutoRemove: false,
      NetworkMode: syncer.HostConfig?.NetworkMode || `${PROJECT_NAME}_default`,
      Binds: workerBinds(syncer.Mounts || []),
    },
  };
}

function workerEnv(envValues) {
  const allowed = new Set(["ANYTHINGLLM_BASE_URL", "VAULT_PATH"]);
  return envValues.filter((entry) => allowed.has(entry.split("=")[0]));
}

function workerBinds(mounts) {
  const destinations = new Set(["/workspace/.env", "/vault", "/workspace/.anything-obsidian-state"]);
  return mounts
    .filter((mount) => destinations.has(mount.Destination))
    .map((mount) => {
      const source = mount.Type === "volume" ? mount.Name : mount.Source;
      const mode = mount.Destination === "/workspace/.env" ? ":ro" : "";
      return `${source}:${mount.Destination}${mode}`;
    });
}

function isRunning(services, id) {
  return services.some((service) => service.id === id && service.running);
}
