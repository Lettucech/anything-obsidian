import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import { setTimeout as delay } from "node:timers/promises";

export async function writeJson(filePath, value, { mode = 0o600 } = {}) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

// A heartbeat lock coordinates independent workers and recovers after a crash.
// Every caller uses identical lease settings; a compromised lease terminates the
// owner rather than allowing it to keep writing alongside a replacement worker.
export async function withFileLock(lockPath, action, { signal, timeoutMs = 300_000 } = {}) {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const started = Date.now();
  let release;
  for (;;) {
    signal?.throwIfAborted();
    try {
      release = await lockfile.lock(lockPath, {
        realpath: false,
        lockfilePath: lockPath,
        stale: 60_000,
        update: 10_000,
        retries: 0,
      });
      break;
    } catch (error) {
      if (error.code !== "ELOCKED") throw error;
      if (Date.now() - started >= timeoutMs) throw new Error(`Operation is busy: ${lockPath}`);
      await delay(100, undefined, { signal });
    }
  }
  try {
    signal?.throwIfAborted();
    return await action();
  } finally {
    await release();
  }
}
