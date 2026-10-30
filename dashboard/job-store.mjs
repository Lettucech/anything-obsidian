import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { writeJson } from "../lib/state.mjs";

const DEFAULT_MAX_JOBS = 50;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

export function createFileJobStore({
  filePath,
  maxJobs = DEFAULT_MAX_JOBS,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  if (!filePath) throw new Error("filePath is required");
  let writes = Promise.resolve();

  const normalize = (jobs) =>
    jobs.map((job) =>
      job && (job.status === "queued" || job.status === "running")
        ? {
            ...job,
            status: "failed",
            exitCode: job.exitCode ?? null,
            finishedAt: job.finishedAt ?? new Date().toISOString(),
            error: "Interrupted by restart",
          }
        : job,
    );

  const readJobs = () => {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8"));
      return Array.isArray(parsed?.jobs) ? parsed.jobs : [];
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      return [];
    }
  };

  return {
    filePath,
    loadSync() {
      return normalize(readJobs());
    },
    async load() {
      let jobs;
      try {
        const parsed = JSON.parse(await readFile(filePath, "utf8"));
        jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
      } catch (error) {
        if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
        jobs = [];
      }
      return normalize(jobs);
    },
    save(jobs) {
      const kept = trimJobs(jobs, { maxJobs, maxBytes });
      const snapshot = JSON.parse(JSON.stringify(kept));
      const next = writes
        .then(() => writeJson(filePath, { version: 1, jobs: snapshot }))
        .then(() => snapshot);
      writes = next.catch(() => {});
      return next;
    },
  };
}

function trimJobs(jobs, { maxJobs, maxBytes }) {
  const active = (job) => ["queued", "running"].includes(job.status);
  const retained = new Set(jobs.filter(active));
  let bytes = JSON.stringify([...retained]).length;
  let count = 0;
  for (const job of [...jobs].reverse()) {
    if (active(job)) continue;
    const size = JSON.stringify(job).length + 1;
    if (count >= maxJobs || bytes + size > maxBytes) continue;
    retained.add(job);
    bytes += size;
    count++;
  }
  return jobs.filter((job) => retained.has(job));
}
