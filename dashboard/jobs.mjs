import { randomUUID } from "node:crypto";

import { WORKER_ACTIONS } from "./config.mjs";
import { redactSecretsText } from "./redact.mjs";

const PROJECT_NAME = "anything-obsidian";
const WORKER_IMAGE = "anything-obsidian-worker";

export function createJobManager({ docker, now = Date.now } = {}) {
  const jobs = new Map();
  const activeJobIds = new Map();

  return {
    async start(vaultId, actionId, serviceSnapshot = []) {
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

      runJob({ docker, job, action, vaultId })
        .catch((error) => {
          job.status = "failed";
          job.error = error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
          job.finishedAt = new Date(now()).toISOString();
          activeJobIds.delete(vaultId);
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

async function runJob({ docker, job, action, vaultId }) {
  job.status = "running";
  const syncer = await docker.inspectContainerDetails("anything-obsidian-syncer");
  const container = await docker.createContainer(workerContainerConfig({ syncer, action, vaultId }));
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

export function workerContainerConfig({ syncer, action, vaultId }) {
  return {
    Image: syncer.Config?.Image || WORKER_IMAGE,
    Cmd: [...action.command, ...(vaultId && vaultId !== "legacy" ? ["--vault", vaultId] : [])],
    Env: workerEnv(syncer.Config?.Env || []),
    HostConfig: {
      AutoRemove: false,
      NetworkMode: syncer.HostConfig?.NetworkMode || `${PROJECT_NAME}_default`,
      Binds: workerBinds(syncer.Mounts || []),
    },
  };
}

function workerEnv(envValues) {
  const allowed = new Set(["ANYTHINGLLM_BASE_URL", "VAULTS_ROOT", "VAULT_REGISTRY_PATH", "VAULT_SECRETS_PATH", "VAULT_STATE_ROOT"]);
  return envValues.filter((entry) => allowed.has(entry.split("=")[0]));
}

function workerBinds(mounts) {
  const destinations = new Set([
    "/workspace/.env",
    "/vaults",
    "/workspace/.anything-obsidian-state",
    "/workspace/.anything-obsidian-registry",
    "/workspace/.anything-obsidian-secrets",
  ]);
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
