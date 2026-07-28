import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export function createVaultRegistry({ rootPath = "/vaults", registryPath }) {
  if (!registryPath) throw new Error("registryPath is required");

  return {
    async list() {
      return (await readRegistry(registryPath)).vaults;
    },
    async get(id) {
      return (await readRegistry(registryPath)).vaults.find((vault) => vault.id === id) ?? null;
    },
    async create(input) {
      const vault = normalizeVault(input, rootPath);
      const registry = await readRegistry(registryPath);
      assertUnique(registry.vaults, vault);
      registry.vaults.push(vault);
      await writeRegistry(registryPath, registry);
      return vault;
    },
    async update(id, input) {
      const registry = await readRegistry(registryPath);
      const index = registry.vaults.findIndex((vault) => vault.id === id);
      if (index === -1) return null;
      const updated = normalizeVault({ ...registry.vaults[index], ...input, id }, rootPath);
      assertUnique(registry.vaults.filter((vault) => vault.id !== id), updated);
      registry.vaults[index] = updated;
      await writeRegistry(registryPath, registry);
      return updated;
    },
    async remove(id) {
      const registry = await readRegistry(registryPath);
      const index = registry.vaults.findIndex((vault) => vault.id === id);
      if (index === -1) return null;
      const [removed] = registry.vaults.splice(index, 1);
      await writeRegistry(registryPath, registry);
      return removed;
    },
    resolvePath(vault) {
      return resolveVaultPath(rootPath, vault.directory);
    },
  };
}

function normalizeVault(input, rootPath) {
  const id = requiredSlug(input.id, "id");
  const directory = requiredSlug(input.directory, "directory");
  const workspaceSlug = requiredSlug(input.workspaceSlug, "workspaceSlug");
  resolveVaultPath(rootPath, directory);
  return {
    id,
    name: String(input.name ?? id).trim() || id,
    directory,
    workspaceSlug,
    gitRemote: String(input.gitRemote ?? "origin"),
    gitBranch: String(input.gitBranch ?? "main"),
    syncIntervalSeconds: Number(input.syncIntervalSeconds ?? 300),
    enabled: input.enabled !== false,
    accessMode: input.accessMode === "restricted" ? "restricted" : "open",
    allowlist: Array.isArray(input.allowlist) ? input.allowlist.map(String) : [],
  };
}

function requiredSlug(value, name) {
  const text = String(value ?? "");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(text)) {
    throw new Error(`${name} must be lowercase dash-separated text beneath the vault root`);
  }
  return text;
}

function resolveVaultPath(rootPath, directory) {
  const root = path.resolve(rootPath);
  const resolved = path.resolve(root, directory);
  if (path.dirname(resolved) !== root) {
    throw new Error("Vault directory must be a direct child of the vault root");
  }
  return resolved;
}

function assertUnique(vaults, vault) {
  for (const existing of vaults) {
    if (existing.id === vault.id) throw new Error(`Vault id already exists: ${vault.id}`);
    if (existing.directory === vault.directory) throw new Error(`Vault directory already exists: ${vault.directory}`);
    if (existing.workspaceSlug === vault.workspaceSlug) throw new Error(`Workspace already exists: ${vault.workspaceSlug}`);
  }
}

async function readRegistry(registryPath) {
  try {
    const parsed = JSON.parse(await readFile(registryPath, "utf8"));
    return { version: 1, vaults: Array.isArray(parsed.vaults) ? parsed.vaults : [] };
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 1, vaults: [] };
    throw error;
  }
}

async function writeRegistry(registryPath, registry) {
  await mkdir(path.dirname(registryPath), { recursive: true });
  const temporary = `${registryPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`);
  await rename(temporary, registryPath);
}
