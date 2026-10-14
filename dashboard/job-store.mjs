import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";

export const DEFAULT_MAX_JOBS = 50;
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

export function createFileJobStore({
  filePath,
  maxJobs = DEFAULT_MAX_JOBS,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  if (!filePath) throw new Error("filePath is required");

  const normalize = (jobs) => jobs.map((job) => (
    job && (job.status === "queued" || job.status === "running")
      ? {
          ...job,
          status: "failed",
          exitCode: job.exitCode ?? null,
          finishedAt: job.finishedAt ?? new Date().toISOString(),
          error: "Interrupted by restart",
        }
      : job
  ));

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
    async save(jobs) {
      const kept = trimJobs(jobs, { maxJobs, maxBytes });
      await mkdir(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ version: 1, jobs: kept }, null, 2)}\n`);
      await rename(temporary, filePath);
      return kept;
    },
  };
}

function trimJobs(jobs, { maxJobs, maxBytes }) {
  let kept = jobs.slice(-maxJobs);
  const size = () => kept.reduce((total, job) => total + JSON.stringify(job).length + 1, 40);
  while (kept.length > 1 && size() > maxBytes) {
    kept = kept.slice(1);
  }
  return kept;
}
