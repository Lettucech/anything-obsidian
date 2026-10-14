import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export function createSyncStatusStore({ filePath } = {}) {
  if (!filePath) throw new Error("filePath is required");

  async function readAll() {
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8"));
      if (parsed && typeof parsed === "object" && parsed.vaults && typeof parsed.vaults === "object") {
        return parsed.vaults;
      }
      return {};
    } catch (error) {
      if (error?.code === "ENOENT") return {};
      if (error instanceof SyntaxError) return {};
      throw error;
    }
  }

  return {
    filePath,
    async get(vaultId) {
      return (await readAll())[vaultId] ?? null;
    },
    async all() {
      return readAll();
    },
    async record(vaultId, entry) {
      const vaults = await readAll();
      vaults[vaultId] = {
        status: entry.status === "failed" ? "failed" : "succeeded",
        finishedAt: entry.finishedAt ?? new Date().toISOString(),
        pushed: Boolean(entry.pushed),
        embedded: Boolean(entry.embedded),
        ...(entry.error ? { error: String(entry.error).slice(0, 500) } : {}),
      };
      await mkdir(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ version: 1, vaults }, null, 2)}\n`);
      await rename(temporary, filePath);
      return vaults[vaultId];
    },
  };
}

export function syncStatusPath(stateRoot) {
  return path.join(stateRoot, "last-sync.json");
}
