import { readFile } from "node:fs/promises";
import path from "node:path";

export const ANONYMOUS_IDENTITY = { kind: "anonymous" };
export const ADMIN_IDENTITY = { kind: "admin" };

export async function loadVaults(registryPath) {
  try {
    const raw = JSON.parse(await readFile(registryPath, "utf8"));
    if (!Array.isArray(raw?.vaults)) return [];
    return raw.vaults.filter(isVaultRecord);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function loadWorkspace(registryPath) {
  try {
    const raw = JSON.parse(await readFile(registryPath, "utf8"));
    const workspace = raw?.workspace;
    return workspace && typeof workspace.slug === "string" && workspace.slug ? workspace : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function resolveVault(vaults, vaultId, identity = ANONYMOUS_IDENTITY) {
  const enabled = vaults.filter((vault) => vault.enabled);
  if (vaultId) {
    const vault = enabled.find((candidate) => candidate.id === vaultId);
    if (!vault) throw new Error(`Unknown or disabled vault: ${vaultId}`);
    assertAccessible(vault, identity);
    return vault;
  }
  const accessible = enabled.filter((vault) => isAccessible(vault, identity));
  if (accessible.length === 1) return accessible[0];
  if (accessible.length === 0) throw new Error("No accessible managed vaults are available");
  throw new Error("vaultId is required when more than one vault is accessible");
}

export function visibleVaults(vaults, identity) {
  return vaults.filter((vault) => vault.enabled && isAccessible(vault, identity));
}

function isAccessible(vault, identity) {
  if (vault.accessMode !== "restricted") return true;
  if (identity.kind === "admin") return true;
  if (identity.kind === "agent") return vault.allowlist.includes(identity.name);
  return false;
}

function assertAccessible(vault, identity) {
  if (!isAccessible(vault, identity)) {
    throw new Error(`Vault '${vault.id}' is restricted and this caller has no access`);
  }
}

function isVaultRecord(value) {
  if (!value || typeof value !== "object") return false;
  return typeof value.id === "string" && typeof value.name === "string" && typeof value.directory === "string" &&
    locationShape(value) &&
    typeof value.enabled === "boolean" &&
    (value.accessMode === "open" || value.accessMode === "restricted") && Array.isArray(value.allowlist) &&
    optionalBoolean(value.gitAutoPull) && optionalBoolean(value.gitAutoPush) &&
    optionalNumber(value.syncIntervalSeconds) && optionalBoolean(value.embedAfterSync);
}

function locationShape(value) {
  if (value.location === undefined || value.location === "managed") return true;
  return value.location === "imported" && typeof value.importPath === "string" && path.isAbsolute(value.importPath);
}

function optionalBoolean(value) {
  return value === undefined || typeof value === "boolean";
}

function optionalNumber(value) {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}
