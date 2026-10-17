import { readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_KEEP = 2;

export async function rotateLogs({ logsRoot, maxBytes = DEFAULT_MAX_BYTES, keep = DEFAULT_KEEP } = {}) {
  if (!logsRoot) throw new Error("logsRoot is required");
  let entries;
  try {
    entries = await readdir(logsRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const rotated = [];
  for (const entry of entries) {
    if (!entry.endsWith(".log")) continue;
    const filePath = path.join(logsRoot, entry);
    const details = await stat(filePath);
    if (details.size <= maxBytes) continue;

    await rm(`${filePath}.${keep}`, { force: true });
    for (let index = keep - 1; index >= 1; index -= 1) {
      try {
        await rename(`${filePath}.${index}`, `${filePath}.${index + 1}`);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    await rename(filePath, `${filePath}.1`);
    rotated.push({ file: entry, sizeBytes: details.size });
  }
  return rotated;
}
