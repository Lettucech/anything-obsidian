import { assertLocalImport, assertRemoteRepository } from "../lib/deployment.mjs";
import { execFile as nodeExecFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { embedVault as defaultEmbedVault } from "../scripts/embed-vault.mjs";
import { vaultDocumentFolder, purgeVaultEmbeddings } from "../lib/unified-workspace.mjs";
import { createFileJobStore } from "../dashboard/job-store.mjs";
import { redactSecretsText } from "../dashboard/redact.mjs";
import { readJson, writeJson, withFileLock } from "../lib/state.mjs";

const SOURCE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ACTIVE = new Set(["queued", "running"]);

export function createSourceManager({
  dataDir,
  baseUrl,
  apiKey,
  embedVault = defaultEmbedVault,
  purge = purgeVaultEmbeddings,
  runGit = defaultRunGit,
  now = Date.now,
  fetchImpl = fetch,
  jobStore = createFileJobStore({ filePath: path.join(dataDir, "jobs.json") }),
  jobTimeoutMs = 30 * 60_000,
  env = process.env,
}) {
  const registryPath = path.join(dataDir, "sources.json");
  const jobs = new Map(jobStore.loadSync().map((job) => [job.id, job]));
  const controllers = new Map();
  const acceptance = new Map();
  let queue = Promise.resolve();
  let accepting = true;
  const ready = jobStore.save([...jobs.values()]);
  const persist = () => jobStore.save([...jobs.values()]);
  const clean = (value) => {
    let text = redactSecretsText(value);
    if (typeof apiKey === "string" && apiKey) text = text.split(apiKey).join("[redacted]");
    return text.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[redacted]@");
  };
  const mutateRegistry = (action) =>
    withFileLock(`${registryPath}.lock`, async () => {
      const registry = await readRegistry();
      const result = await action(registry);
      await writeJson(registryPath, registry);
      return result;
    });
  const readRegistry = () => readJson(registryPath, { version: 1, sources: [] });
  const manager = {
    ready,
    async list() {
      return (await readRegistry()).sources;
    },
    async get(id) {
      return (await manager.list()).find((source) => source.id === id) ?? null;
    },
    async create(input) {
      const id = String(input?.id ?? "");
      if (!SOURCE_ID_PATTERN.test(id))
        throw new Error("Source id must be lowercase dash-separated text");
      const kind = input?.kind ?? "git";
      if (kind === "dir") assertLocalImport(env);
      if (kind === "git") assertRemoteRepository(input?.ref, env);
      if (!["dir", "git"].includes(kind)) throw new Error("Source kind must be dir or git");
      const ref = String(input?.ref ?? "").trim();
      if (!ref) throw new Error("Source ref is required (git URL or absolute directory)");
      if (kind === "dir" && !path.isAbsolute(ref))
        throw new Error("A dir source ref must be an absolute path on this server");
      const workspace = String(input?.workspace ?? "").trim();
      if (!SOURCE_ID_PATTERN.test(workspace))
        throw new Error(
          "A source must target a workspace slug (create one in the Workspaces tab first)",
        );
      const intervalSeconds = Number(input?.intervalSeconds ?? 600);
      if (!Number.isInteger(intervalSeconds) || intervalSeconds < 0)
        throw new Error("intervalSeconds must be a non-negative integer");
      return mutateRegistry((registry) => {
        if (registry.sources.some((source) => source.id === id))
          throw new Error(`Source already exists: ${id}`);
        const source = {
          id,
          kind,
          ref,
          workspace,
          branch: String(input?.branch ?? "main"),
          intervalSeconds,
          embedExtensions: String(input?.embedExtensions ?? ""),
          embedExcludeDirs: String(input?.embedExcludeDirs ?? ""),
          enabled: input?.enabled !== false,
          lastRefresh: null,
        };
        registry.sources.push(source);
        return source;
      });
    },
    async remove(id) {
      const source = await manager.get(id);
      if (!source) return null;
      if ([...jobs.values()].some((job) => job.sourceId === id && ACTIVE.has(job.status)))
        throw conflict("Wait for the active source job before removing it");
      await mutateRegistry((registry) =>
        Object.assign(
          registry.sources.find((source) => source.id === id),
          { enabled: false, cleanupPending: true },
        ),
      );
      return enqueue(id, { action: "remove" });
    },
    async requestRefresh(id, { force = false } = {}) {
      const source = await manager.get(id);
      if (!source || source.cleanupPending)
        throw Object.assign(new Error("Source was not found or is pending removal"), {
          statusCode: 404,
        });
      return enqueue(id, { action: "refresh", force });
    },
    job(id) {
      return jobs.get(id) ?? null;
    },
    listJobs() {
      return [...jobs.values()].reverse();
    },
    async retry(id) {
      const job = jobs.get(id);
      if (!job) throw Object.assign(new Error("Job was not found"), { statusCode: 404 });
      if (ACTIVE.has(job.status)) throw conflict("Job is still active");
      return job.action === "remove"
        ? manager.remove(job.sourceId)
        : manager.requestRefresh(job.sourceId, { force: job.force });
    },
    async cancel(id) {
      const job = jobs.get(id);
      if (!job) return null;
      if (!ACTIVE.has(job.status)) return job;
      controllers.get(id)?.abort(new Error("Cancelled by administrator"));
      job.status = "cancelled";
      job.finishedAt = new Date(now()).toISOString();
      await persist();
      return job;
    },
    async runDueSources() {
      await ready;
      const active = new Set(
        [...jobs.values()].filter((job) => ACTIVE.has(job.status)).map((job) => job.sourceId),
      );
      const due = (await manager.list()).filter(
        (source) =>
          source.enabled &&
          !source.cleanupPending &&
          !active.has(source.id) &&
          source.intervalSeconds > 0 &&
          (!source.lastAttempt ||
            now() - Date.parse(source.lastAttempt) >= source.intervalSeconds * 1000),
      );
      for (const source of due) await manager.requestRefresh(source.id);
      return due.map((source) => source.id);
    },
    async close() {
      accepting = false;
      for (const controller of controllers.values())
        controller.abort(new Error("Gateway stopped; retry interrupted jobs"));
      await queue;
      await persist();
    },
  };

  async function enqueue(sourceId, { action = "refresh", force = false } = {}) {
    await ready;
    if (!accepting) throw conflict("Gateway is stopping");
    const source = await manager.get(sourceId);
    if (!source) throw Object.assign(new Error("Source was not found"), { statusCode: 404 });
    if (action === "refresh" && source.cleanupPending)
      throw Object.assign(new Error("Source is pending removal"), { statusCode: 409 });
    const existing = [...jobs.values()].find(
      (job) => job.sourceId === sourceId && ACTIVE.has(job.status),
    );
    if (existing) {
      if (existing.action !== action || (force && !existing.force))
        throw conflict("Another operation is already active for this source");
      await acceptance.get(existing.id);
      return existing;
    }
    if ([...jobs.values()].filter((job) => ACTIVE.has(job.status)).length >= 50)
      throw Object.assign(new Error("Job queue is full; wait for existing work to finish"), {
        statusCode: 429,
      });
    const job = {
      id: `job-${randomUUID()}`,
      sourceId,
      workspace: source.workspace,
      action,
      force,
      status: "queued",
      phase: "queued",
      createdAt: new Date(now()).toISOString(),
      startedAt: null,
      finishedAt: null,
      progress: null,
      logs: "",
      error: null,
    };
    jobs.set(job.id, job);
    // Reserve in memory before any await, and persist before acknowledging acceptance.
    const controller = new AbortController();
    controllers.set(job.id, controller);
    const accepted = persist();
    acceptance.set(job.id, accepted);
    try {
      await accepted;
    } catch (error) {
      jobs.delete(job.id);
      controllers.delete(job.id);
      throw error;
    } finally {
      acceptance.delete(job.id);
    }
    queue = queue
      .then(() => runJob(job, controller))
      .catch((error) => console.error(clean(`Job persistence failed: ${error.message}`)));
    return job;
  }

  async function runJob(job, controller) {
    if (job.status === "cancelled") {
      controllers.delete(job.id);
      return;
    }
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(jobTimeoutMs)]);
    let lastPersisted = 0;
    const report = async (progress) => {
      const phaseChanged = job.phase !== progress.phase;
      job.phase = progress.phase;
      job.progress = progress;
      job.logs = clean(
        `${job.logs}${new Date(now()).toISOString()} ${progress.phase}${progress.file ? `: ${progress.file}` : ""}\n`,
      ).slice(-64 * 1024);
      if (
        (phaseChanged && !["uploading", "scanning"].includes(progress.phase)) ||
        now() - lastPersisted >= 500 ||
        progress.completed === progress.total
      ) {
        await persist();
        lastPersisted = now();
      }
    };
    job.status = "running";
    job.startedAt = new Date(now()).toISOString();
    try {
      await report({ phase: "starting" });
      await mutateRegistry((registry) => {
        const source = registry.sources.find((source) => source.id === job.sourceId);
        if (source) source.lastAttempt = job.startedAt;
      });
      const source = await manager.get(job.sourceId);
      if (!source) throw new Error(`Unknown source: ${job.sourceId}`);
      const key = typeof apiKey === "function" ? await apiKey() : apiKey;
      if (!key)
        throw new Error(
          "No AnythingLLM key configured — set it in the admin dashboard's Settings tab",
        );
      const sanitize = (error) => clean(String(error).split(key).join("[redacted]"));
      try {
        if (job.action === "remove") {
          await report({ phase: "removing" });
          const result = await purge({
            baseUrl,
            apiKey: key,
            workspaceSlug: source.workspace,
            vaultId: source.id,
            stateRoot: dataDir,
            fetchImpl,
            signal,
          });
          if (!result.purged) throw new Error(result.errors.join("; "));
          await mutateRegistry((registry) => {
            registry.sources = registry.sources.filter((candidate) => candidate.id !== source.id);
          });
          job.result = result;
        } else {
          await report({ phase: source.kind === "git" ? "syncing" : "reading" });
          const vaultPath = await refreshWorkingCopy(source, signal);
          job.result = await embedVault({
            config: {
              anythingllmBaseUrl: baseUrl,
              apiKey: key,
              workspaceSlug: source.workspace,
              vaultId: source.id,
              vaultPath,
              documentFolder: vaultDocumentFolder(source.id),
              stateDir: path.join(dataDir, "manifests", source.id),
              ...(source.embedExtensions ? { embedExtensions: source.embedExtensions } : {}),
              ...(source.embedExcludeDirs ? { embedExcludeDirs: source.embedExcludeDirs } : {}),
            },
            all: job.force,
            signal,
            fetchImpl,
            onProgress: report,
          });
          signal.throwIfAborted();
          await mutateRegistry((registry) => {
            const current = registry.sources.find((candidate) => candidate.id === source.id);
            if (current) {
              current.lastRefresh = new Date(now()).toISOString();
              current.lastError = null;
            }
          });
        }
        job.status = "succeeded";
      } catch (error) {
        throw new Error(sanitize(error.message));
      }
    } catch (error) {
      job.status = controller.signal.aborted ? "cancelled" : "failed";
      job.error = clean(error.message);
      await mutateRegistry((registry) => {
        const current = registry.sources.find((source) => source.id === job.sourceId);
        if (current) current.lastError = job.error;
      });
      job.logs = clean(`${job.logs}${job.error}\n`).slice(-64 * 1024);
    } finally {
      job.finishedAt = new Date(now()).toISOString();
      controllers.delete(job.id);
      // Bound both the persisted and in-memory history, retaining active jobs.
      const terminal = [...jobs.values()].filter((job) => !ACTIVE.has(job.status));
      for (const old of terminal.slice(0, Math.max(0, terminal.length - 50))) jobs.delete(old.id);
      await persist();
    }
  }

  async function refreshWorkingCopy(source, signal) {
    if (source.kind === "dir") {
      assertLocalImport(env);
      return source.ref;
    }
    assertRemoteRepository(source.ref, env);
    const target = path.join(dataDir, "sources", source.id);
    try {
      await readFile(path.join(target, ".git", "HEAD"), "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await mkdir(path.dirname(target), { recursive: true });
      await runGit(["clone", "--branch", source.branch, source.ref, target], undefined, { signal });
      return target;
    }
    await runGit(["-C", target, "pull", "--ff-only"], undefined, { signal });
    return target;
  }
  return manager;
}

function conflict(message) {
  return Object.assign(new Error(message), { statusCode: 409 });
}
async function defaultRunGit(args, cwd, { signal } = {}) {
  try {
    return (
      await promisify(nodeExecFile)("git", args, {
        cwd,
        signal,
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      })
    ).stdout;
  } catch (error) {
    throw new Error(`git ${args[0]} failed: ${error.stderr || error.message}`);
  }
}
