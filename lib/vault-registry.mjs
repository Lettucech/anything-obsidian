import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export function createVaultRegistry({ rootPath = "", registryPath }) {
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
      if (vault.location === "imported") return path.resolve(vault.importPath);
      return resolveVaultPath(rootPath, vault.directory);
    },
  };
}

function normalizeVault(input, rootPath) {
  const location = input.location === "imported" ? "imported" : "managed";
  const id = requiredSlug(input.id, "id");
  const directory = requiredSlug(
    input.directory ?? (location === "imported" ? importedDirectoryName(input.importPath) : undefined),
    "directory",
  );
  const workspaceSlug = requiredSlug(input.workspaceSlug, "workspaceSlug");
  const importPath = location === "imported" ? requiredImportPath(input.importPath, rootPath) : "";
  if (location === "managed") resolveVaultPath(rootPath, directory);
  const syncByDefault = location === "managed";
  return {
    id,
    name: String(input.name ?? id).trim() || id,
    location,
    directory,
    ...(location === "imported" ? { importPath } : {}),
    workspaceSlug,
    repositoryUrl: String(input.repositoryUrl ?? ""),
    gitRemote: String(input.gitRemote ?? "origin"),
    gitBranch: String(input.gitBranch ?? "main"),
    gitAuthMode: input.gitAuthMode === "https-token" ? "https-token" : "none",
    gitAutoPull: input.gitAutoPull ?? syncByDefault,
    gitAutoPush: input.gitAutoPush ?? syncByDefault,
    gitUserName: requiredText(input.gitUserName, "gitUserName"),
    gitUserEmail: requiredText(input.gitUserEmail, "gitUserEmail"),
    gitPushUrl: String(input.gitPushUrl ?? ""),
    gitCommitMessagePrefix: String(input.gitCommitMessagePrefix ?? "Auto sync vault"),
    syncIntervalSeconds: Number(input.syncIntervalSeconds ?? 300),
    embedAfterSync: input.embedAfterSync !== false,
    embedExtensions: String(input.embedExtensions ?? ""),
    embedExcludeDirs: String(input.embedExcludeDirs ?? ""),
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

function requiredText(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} is required`);
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

function requiredImportPath(value, rootPath) {
  const candidate = String(value ?? "").trim();
  if (!candidate) throw new Error("importPath is required for imported vaults");
  const resolved = path.resolve(candidate);
  if (!path.isAbsolute(candidate)) {
    throw new Error("importPath must be an absolute path to an existing vault directory");
  }
  if (rootPath && resolved === path.resolve(rootPath)) {
    throw new Error("importPath must point at a vault directory, not the vault root itself");
  }
  return resolved;
}

function importedDirectoryName(importPath) {
  const basename = path.basename(String(importPath ?? "").trim());
  const slug = basename
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new Error("directory could not be derived from importPath; pass directory explicitly");
  return slug;
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
