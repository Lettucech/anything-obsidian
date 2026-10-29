// Shared-source pipeline: the server side of the vault pipeline. Shared
// knowledge enters the shared workspace only through here — a git source
// clones/pulls into the data volume, a dir source reads a server-local
// directory as-is, then the client's own embedVault (unchanged) reindexes it
// into the shared workspace with per-source folders and manifests.
//
// Refresh is a job: one at a time, queueable over the API/MCP, and
// auto-scheduled by interval. Nothing heavy ever runs synchronously in a
// request.
import { execFile as nodeExecFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { embedVault as defaultEmbedVault } from "../scripts/embed-vault.mjs";
import { vaultDocumentFolder } from "../lib/unified-workspace.mjs";

const SOURCE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// apiKey may be a plain value or a resolver — the gateway passes a resolver
// so every job picks up the current key (wizard-collected or env) at run
// time, including changes made later in the dashboard's Settings tab.
export function createSourceManager({
  dataDir,
  baseUrl,
  apiKey,
  embedVault = defaultEmbedVault,
  runGit = defaultRunGit,
  now = Date.now,
}) {
  const registryPath = path.join(dataDir, "sources.json");
  const sourcesRoot = path.join(dataDir, "sources");
  const stateRoot = path.join(dataDir, "manifests");
  const jobs = new Map();
  let queue = Promise.resolve();
  let jobCounter = 0;

  const manager = {
    async list() {
      return (await readRegistry()).sources;
    },
    async get(id) {
      return (await readRegistry()).sources.find((source) => source.id === id) ?? null;
    },
    async create(input) {
      const id = String(input?.id ?? "");
      if (!SOURCE_ID_PATTERN.test(id)) throw new Error("Source id must be lowercase dash-separated text");
      const kind = input?.kind === "dir" ? "dir" : "git";
      const ref = String(input?.ref ?? "").trim();
      if (!ref) throw new Error("Source ref is required (git URL or absolute directory)");
      if (kind === "dir" && !path.isAbsolute(ref)) {
        throw new Error("A dir source ref must be an absolute path on this server");
      }
      const workspace = String(input?.workspace ?? "").trim();
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(workspace)) {
        throw new Error("A source must target a workspace slug (create one in the Workspaces tab first)");
      }
      const registry = await readRegistry();
      if (registry.sources.some((source) => source.id === id)) throw new Error(`Source already exists: ${id}`);
      const source = {
        id,
        kind,
        ref,
        workspace,
        branch: String(input?.branch ?? "main"),
        intervalSeconds: Math.max(0, Number(input?.intervalSeconds ?? 600) || 0),
        embedExtensions: String(input?.embedExtensions ?? ""),
        embedExcludeDirs: String(input?.embedExcludeDirs ?? ""),
        enabled: input?.enabled !== false,
        lastRefresh: null,
      };
      registry.sources.push(source);
      await writeRegistry(registry);
      return source;
    },
    async remove(id) {
      const registry = await readRegistry();
      const index = registry.sources.findIndex((source) => source.id === id);
      if (index === -1) return null;
      const [removed] = registry.sources.splice(index, 1);
      await writeRegistry(registry);
      return removed;
    },
    requestRefresh(sourceId) {
      return enqueue(sourceId);
    },
    job(id) {
      return jobs.get(id) ?? null;
    },
    listJobs() {
      return [...jobs.values()];
    },
    // Called on a timer by the gateway: queue one job per due source.
    runDueSources() {
      return readRegistry().then((registry) => {
        const due = registry.sources.filter((source) =>
          source.enabled && source.intervalSeconds > 0 &&
          (!source.lastRefresh || now() - Date.parse(source.lastRefresh) >= source.intervalSeconds * 1000),
        );
        for (const source of due) enqueue(source.id);
        return due.map((source) => source.id);
      });
    },
  };

  function enqueue(sourceId) {
    jobCounter += 1;
    const job = {
      id: `job-${now()}-${jobCounter}`,
      sourceId,
      status: "queued",
      startedAt: null,
      finishedAt: null,
      error: null,
    };
    jobs.set(job.id, job);
    queue = queue.then(() => runJob(job)).catch(() => {});
    return job;
  }

  async function runJob(job) {
    job.status = "running";
    job.startedAt = new Date(now()).toISOString();
    try {
      const source = await manager.get(job.sourceId);
      if (!source) throw new Error(`Unknown source: ${job.sourceId}`);
      if (!source.workspace) throw new Error(`Source '${source.id}' has no target workspace — re-create it with one`);
      const resolvedApiKey = typeof apiKey === "function" ? await apiKey() : apiKey;
      if (!resolvedApiKey) throw new Error("No AnythingLLM key configured — set it in the admin dashboard's Settings tab");
      const vaultPath = await refreshWorkingCopy(source);
      const result = await embedVault({
        config: {
          anythingllmBaseUrl: baseUrl,
          apiKey: resolvedApiKey,
          workspaceSlug: source.workspace,
          vaultId: source.id,
          vaultPath,
          documentFolder: vaultDocumentFolder(source.id),
          stateDir: path.join(stateRoot, source.id),
          ...(source.embedExtensions ? { embedExtensions: source.embedExtensions } : {}),
          ...(source.embedExcludeDirs ? { embedExcludeDirs: source.embedExcludeDirs } : {}),
        },
      });
      job.status = "succeeded";
      job.result = result;
      await touchSource(source.id);
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
    } finally {
      job.finishedAt = new Date(now()).toISOString();
    }
  }

  async function refreshWorkingCopy(source) {
    if (source.kind === "dir") return source.ref;
    const target = path.join(sourcesRoot, source.id);
    let cloned = false;
    try {
      await readFile(path.join(target, ".git", "HEAD"), "utf8");
    } catch {
      await mkdir(sourcesRoot, { recursive: true });
      await runGit(["clone", "--branch", source.branch, source.ref, target]);
      cloned = true;
    }
    if (!cloned) {
      await runGit(["-C", target, "pull", "--ff-only"]);
    }
    return target;
  }

  async function touchSource(id) {
    const registry = await readRegistry();
    const source = registry.sources.find((candidate) => candidate.id === id);
    if (source) {
      source.lastRefresh = new Date(now()).toISOString();
      await writeRegistry(registry);
    }
  }

  async function readRegistry() {
    try {
      const parsed = JSON.parse(await readFile(registryPath, "utf8"));
      return {
        version: 1,
        sources: Array.isArray(parsed?.sources) ? parsed.sources : [],
      };
    } catch (error) {
      if (error?.code === "ENOENT") return { version: 1, sources: [] };
      throw error;
    }
  }

  async function writeRegistry(registry) {
    await mkdir(path.dirname(registryPath), { recursive: true });
    const temporary = `${registryPath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`);
    await rename(temporary, registryPath);
  }

  return manager;
}

async function defaultRunGit(args, cwd) {
  const execFileAsync = promisify(nodeExecFile);
  try {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return stdout;
  } catch (error) {
    throw new Error(`git ${args[0]} failed: ${error?.stderr || error?.message || error}`);
  }
}
