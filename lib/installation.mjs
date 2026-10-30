import path from "node:path";
import { readJson, writeJson, withFileLock } from "./state.mjs";

export function createInstallationStore(root) {
  const filePath = path.join(root, "installation.json");
  return {
    filePath,
    async load() {
      return readJson(filePath, { version: 1, roles: [], autostart: true, lan: false });
    },
    async update(patch) {
      return withFileLock(`${filePath}.lock`, async () => {
        const current = await this.load();
        const next = { ...current, ...patch, version: 1 };
        if (
          !Array.isArray(next.roles) ||
          next.roles.some((role) => !["client", "gateway"].includes(role))
        )
          throw new Error("Invalid installation roles");
        next.roles = [...new Set(next.roles)];
        await writeJson(filePath, next);
        return next;
      });
    },
    async addRole(role) {
      return withFileLock(`${filePath}.lock`, async () => {
        const current = await this.load();
        const next = { ...current, roles: [...new Set([...current.roles, role])] };
        await writeJson(filePath, next);
        return next;
      });
    },
  };
}
