import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export function createVaultSecretStore({ rootPath }) {
  if (!rootPath) throw new Error("rootPath is required");

  async function get(vaultId) {
    try {
      const value = JSON.parse(await readFile(secretPath(rootPath, vaultId), "utf8"));
      return isHttpTokenSecret(value) ? value : null;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  return {
    get,
    async save(vaultId, input = {}) {
      if (input.mode === "none") {
        await removeSecret(rootPath, vaultId);
        return { configured: false };
      }
      if (input.mode !== "https-token" || !String(input.token ?? "")) {
        return { configured: Boolean(await get(vaultId)) };
      }
      const value = {
        version: 1,
        username: String(input.username || "x-access-token"),
        token: String(input.token),
      };
      await mkdir(rootPath, { recursive: true, mode: 0o700 });
      const destination = secretPath(rootPath, vaultId);
      const temporary = `${destination}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, destination);
      return { configured: true };
    },
    async remove(vaultId) {
      await removeSecret(rootPath, vaultId);
    },
  };
}

function secretPath(rootPath, vaultId) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(vaultId)) throw new Error("Invalid vault id");
  return path.join(rootPath, `${vaultId}.json`);
}

async function removeSecret(rootPath, vaultId) {
  await rm(secretPath(rootPath, vaultId), { force: true });
}

function isHttpTokenSecret(value) {
  return value && typeof value === "object" && typeof value.username === "string" && typeof value.token === "string";
}
