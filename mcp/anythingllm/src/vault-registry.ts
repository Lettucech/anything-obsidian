import { readFile } from "node:fs/promises";

export type VaultRecord = {
  id: string;
  name: string;
  workspaceSlug: string;
  enabled: boolean;
  accessMode: "open" | "restricted";
  allowlist: string[];
};

export async function loadVaults(registryPath: string): Promise<VaultRecord[]> {
  try {
    const raw = JSON.parse(await readFile(registryPath, "utf8")) as { vaults?: unknown };
    if (!Array.isArray(raw.vaults)) return [];
    return raw.vaults.filter(isVaultRecord);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }
}

export function resolveVault(vaults: VaultRecord[], vaultId?: string): VaultRecord {
  const enabled = vaults.filter((vault) => vault.enabled);
  if (vaultId) {
    const vault = enabled.find((candidate) => candidate.id === vaultId);
    if (!vault) throw new Error(`Unknown or disabled vault: ${vaultId}`);
    assertAccessible(vault);
    return vault;
  }
  const accessible = enabled.filter((vault) => vault.accessMode === "open");
  if (accessible.length === 1) return accessible[0];
  if (accessible.length === 0) throw new Error("No accessible managed vaults are available");
  throw new Error("vaultId is required when more than one vault is accessible");
}

function assertAccessible(vault: VaultRecord) {
  if (vault.accessMode === "restricted") {
    throw new Error(`Vault '${vault.id}' is restricted; caller identity enforcement is not available yet`);
  }
}

function isVaultRecord(value: unknown): value is VaultRecord {
  if (!value || typeof value !== "object") return false;
  const vault = value as Partial<VaultRecord>;
  return typeof vault.id === "string" && typeof vault.name === "string" &&
    typeof vault.workspaceSlug === "string" && typeof vault.enabled === "boolean" &&
    (vault.accessMode === "open" || vault.accessMode === "restricted") && Array.isArray(vault.allowlist);
}
