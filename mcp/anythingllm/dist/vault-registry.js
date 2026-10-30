import { readFile } from "node:fs/promises";
export async function loadVaults(registryPath) {
    try {
        const raw = JSON.parse(await readFile(registryPath, "utf8"));
        if (!Array.isArray(raw.vaults))
            return [];
        return raw.vaults.filter(isVaultRecord);
    }
    catch (error) {
        if (error?.code === "ENOENT")
            return [];
        throw error;
    }
}
export function resolveVault(vaults, vaultId) {
    const enabled = vaults.filter((vault) => vault.enabled);
    if (vaultId) {
        const vault = enabled.find((candidate) => candidate.id === vaultId);
        if (!vault)
            throw new Error(`Unknown or disabled vault: ${vaultId}`);
        assertAccessible(vault);
        return vault;
    }
    const accessible = enabled.filter((vault) => vault.accessMode === "open");
    if (accessible.length === 1)
        return accessible[0];
    if (accessible.length === 0)
        throw new Error("No accessible managed vaults are available");
    throw new Error("vaultId is required when more than one vault is accessible");
}
function assertAccessible(vault) {
    if (vault.accessMode === "restricted") {
        throw new Error(`Vault '${vault.id}' is restricted; caller identity enforcement is not available yet`);
    }
}
function isVaultRecord(value) {
    if (!value || typeof value !== "object")
        return false;
    const vault = value;
    return typeof vault.id === "string" && typeof vault.name === "string" && typeof vault.directory === "string" &&
        typeof vault.workspaceSlug === "string" && typeof vault.enabled === "boolean" &&
        (vault.accessMode === "open" || vault.accessMode === "restricted") && Array.isArray(vault.allowlist) &&
        optionalBoolean(vault.gitAutoPull) && optionalBoolean(vault.gitAutoPush) &&
        optionalNumber(vault.syncIntervalSeconds) && optionalBoolean(vault.embedAfterSync);
}
function optionalBoolean(value) {
    return value === undefined || typeof value === "boolean";
}
function optionalNumber(value) {
    return value === undefined || (typeof value === "number" && Number.isFinite(value));
}
