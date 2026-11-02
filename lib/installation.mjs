import path from "node:path";
import { readJson, writeJson, withFileLock } from "./state.mjs";

// The gateway feature was renamed "server" (2026-11-02 spec). Old installs
// carry the "gateway" role token on disk; it normalizes to "server" on every
// load, and migrate() persists the rewrite once.
const ROLE_ALIASES = { gateway: "server" };
const VALID_ROLES = ["client", "server"];

function normalizeRoles(roles) {
  if (!Array.isArray(roles)) throw new Error("Invalid installation roles");
  const mapped = roles.map((role) => ROLE_ALIASES[role] ?? role);
  if (mapped.some((role) => !VALID_ROLES.includes(role)))
    throw new Error("Invalid installation roles");
  return [...new Set(mapped)];
}

export function createInstallationStore(root) {
  const filePath = path.join(root, "installation.json");
  const readRaw = () =>
    readJson(filePath, { version: 1, roles: [], autostart: true, lan: false });
  return {
    filePath,
    async load() {
      const raw = await readRaw();
      return { ...raw, roles: normalizeRoles(raw.roles ?? []) };
    },
    // One-shot upgrade: rewrites legacy role tokens ("gateway" → "server")
    // on disk. Every load() already normalizes in memory, so this only
    // makes the file match what the app is acting on.
    async migrate() {
      return withFileLock(`${filePath}.lock`, async () => {
        const raw = await readRaw();
        const roles = normalizeRoles(raw.roles ?? []);
        const migrated =
          JSON.stringify(roles) !== JSON.stringify([...(raw.roles ?? [])]);
        if (migrated) await writeJson(filePath, { ...raw, roles, version: 1 });
        return { migrated, roles };
      });
    },
    async update(patch) {
      return withFileLock(`${filePath}.lock`, async () => {
        const current = await this.load();
        const next = { ...current, ...patch, version: 1 };
        next.roles = normalizeRoles(next.roles);
        await writeJson(filePath, next);
        return next;
      });
    },
    async addRole(role) {
      return withFileLock(`${filePath}.lock`, async () => {
        const current = await this.load();
        const next = { ...current, roles: [...new Set([...current.roles, role])] };
        next.roles = normalizeRoles(next.roles);
        await writeJson(filePath, next);
        return next;
      });
    },
    async removeRole(role) {
      return withFileLock(`${filePath}.lock`, async () => {
        const current = await this.load();
        const drop = new Set([role, ROLE_ALIASES[role] ?? role]);
        const next = {
          ...current,
          roles: current.roles.filter((existing) => !drop.has(existing)),
        };
        await writeJson(filePath, next);
        return next;
      });
    },
  };
}
