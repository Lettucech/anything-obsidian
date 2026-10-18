import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

import { ANONYMOUS_IDENTITY, loadVaults, resolveVault } from "./vault-registry.mjs";

const TEXT_EXTENSIONS = new Set([".md", ".canvas"]);
const MAX_LIST_FILES = 1_000;

export function createVaultFileService({ vaultsRoot, registryPath, hostVaultsRoot, identity = ANONYMOUS_IDENTITY }) {
  async function vault(vaultId) {
    return resolveVault(await loadVaults(registryPath), vaultId, identity);
  }

  return {
    async listFiles(input = {}) {
      const selected = await vault(input.vaultId);
      const root = await vaultDirectory(vaultsRoot, selected);
      const relativeDirectory = input.path ?? "";
      const directory = await existingDirectory(root, relativeDirectory);
      const maxEntries = bounded(input.maxEntries, 200, 1, MAX_LIST_FILES, "maxEntries");
      const files = [];
      let truncated = false;

      async function walk(current, relative) {
        if (files.length >= maxEntries) {
          truncated = true;
          return;
        }
        for (const entry of await readdir(current, { withFileTypes: true })) {
          if (entry.isSymbolicLink() || entry.name === ".git") continue;
          const child = path.join(current, entry.name);
          const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            await walk(child, childRelative);
          } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
            files.push({ path: childRelative, sizeBytes: (await stat(child)).size });
          }
          if (files.length >= maxEntries) {
            truncated = true;
            return;
          }
        }
      }

      await walk(directory, normalizedRelativePath(relativeDirectory, { allowEmpty: true }));
      return { vaultId: selected.id, files, truncated };
    },

    async readFile(input) {
      const selected = await vault(input.vaultId);
      const root = await vaultDirectory(vaultsRoot, selected);
      const relativePath = sourceRelativePath(input.path);
      const target = await existingFile(root, relativePath);
      const startLine = bounded(input.startLine, 1, 1, Number.MAX_SAFE_INTEGER, "startLine");
      const maxLines = bounded(input.maxLines, 400, 1, 1_000, "maxLines");
      const maxBytes = bounded(input.maxBytes, 64 * 1024, 1, 256 * 1024, "maxBytes");
      const details = await stat(target);
      const lines = await readLines(target, { startLine, maxLines, maxBytes });

      return {
        vaultId: selected.id,
        file: { path: relativePath, sizeBytes: details.size, sha256: await hashFile(target) },
        ...lines,
      };
    },

    async directory(input = {}) {
      const selected = await vault(input.vaultId);
      return { vaultId: selected.id, directory: vaultHostDirectory(selected) };
    },

    async context(input = {}) {
      const selected = await vault(input.vaultId);
      const root = await vaultDirectory(vaultsRoot, selected);
      const policyFiles = [];
      for (const candidate of ["AGENTS.md", "README.md"]) {
        if (await isRegularFile(path.join(root, candidate))) policyFiles.push(candidate);
      }

      return {
        vaultId: selected.id,
        name: selected.name,
        directory: vaultHostDirectory(selected),
        sourceOfTruth: "local-vault-files",
        policyFiles,
        editMode: "local-filesystem",
        mcpWriteEnabled: false,
        sync: {
          gitAutoPull: selected.gitAutoPull ?? null,
          gitAutoPush: selected.gitAutoPush ?? null,
          syncIntervalSeconds: selected.syncIntervalSeconds ?? null,
          embedAfterSync: selected.embedAfterSync ?? null,
        },
        rag: { role: "derived-index", freshness: "not-guaranteed" },
      };
    },
  };

  function hostVaultDirectory(directory) {
    if (!hostVaultsRoot) throw new Error("HOST_VAULTS_ROOT is required to reveal a local vault directory");
    const root = path.resolve(hostVaultsRoot);
    const resolved = path.resolve(root, normalizedRelativePath(directory, { allowEmpty: false }));
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error("vault directory escaped HOST_VAULTS_ROOT");
    }
    return resolved;
  }

  function vaultHostDirectory(selected) {
    if (selected.location === "imported") return path.resolve(selected.importPath);
    return hostVaultDirectory(selected.directory);
  }
}

async function vaultDirectory(vaultsRoot, selected) {
  if (selected.location === "imported") {
    let target;
    try {
      target = await realpath(selected.importPath);
    } catch {
      throw new Error(`Imported vault path is not reachable: ${selected.importPath}`);
    }
    if (!(await stat(target)).isDirectory()) {
      throw new Error(`Imported vault path is not a directory: ${selected.importPath}`);
    }
    return target;
  }
  const root = await realpath(vaultsRoot);
  return existingDirectory(root, selected.directory);
}

function sourceRelativePath(value) {
  const relativePath = normalizedRelativePath(value, { allowEmpty: false });
  if (!TEXT_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) {
    throw new Error("only supports Markdown and Canvas files");
  }
  return relativePath;
}

function normalizedRelativePath(value, { allowEmpty }) {
  if (typeof value !== "string") throw new Error("path must be a string");
  const trimmed = value.trim().replace(/\\/g, "/");
  if (!trimmed && allowEmpty) return "";
  if (!trimmed || path.posix.isAbsolute(trimmed)) throw new Error("path must be a non-empty relative vault path");
  const normalized = path.posix.normalize(trimmed);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.split("/").includes(".git")) {
    throw new Error("path must not escape the vault or access Git metadata");
  }
  return normalized;
}

async function existingDirectory(root, relativePath) {
  const target = await safeTarget(root, relativePath);
  const details = await lstat(target);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("path is not a directory");
  return target;
}

async function existingFile(root, relativePath) {
  const target = await safeTarget(root, relativePath);
  const details = await lstat(target);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error("path is not a regular file");
  return target;
}

async function isRegularFile(target) {
  try {
    const details = await lstat(target);
    return details.isFile() && !details.isSymbolicLink();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function safeTarget(root, relativePath) {
  const normalized = normalizedRelativePath(relativePath, { allowEmpty: true });
  const target = path.resolve(root, normalized);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("path escaped vault root");
  const resolvedTarget = await realpath(target);
  if (resolvedTarget !== root && !resolvedTarget.startsWith(`${root}${path.sep}`)) {
    throw new Error("path escaped vault root through a symbolic link");
  }
  return target;
}

async function readLines(filePath, { startLine, maxLines, maxBytes }) {
  const content = await readFile(filePath, "utf8");
  const lines = content.split(/(?<=\n)/);
  const selected = [];
  let byteLength = 0;
  for (let index = startLine - 1; index < lines.length && selected.length < maxLines; index += 1) {
    const line = lines[index];
    const bytes = Buffer.byteLength(line, "utf8");
    if (selected.length > 0 && byteLength + bytes > maxBytes) break;
    if (selected.length === 0 && bytes > maxBytes) {
      selected.push(Buffer.from(line, "utf8").subarray(0, maxBytes).toString("utf8"));
      break;
    }
    selected.push(line);
    byteLength += bytes;
  }
  const nextLine = startLine + selected.length;
  return { content: selected.join(""), startLine, nextLine: nextLine <= lines.length ? nextLine : undefined };
}

async function hashFile(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function bounded(value, fallback, min, max, name) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return resolved;
}
