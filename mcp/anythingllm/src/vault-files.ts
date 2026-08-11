import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  appendFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { TextDecoder } from "node:util";
import { loadVaults, resolveVault, type VaultRecord } from "./vault-registry.js";

const TEXT_EXTENSIONS = new Set([".md", ".canvas"]);
const MAX_WRITE_BYTES = 512 * 1024;
const MAX_CHUNK_BYTES = 128 * 1024;
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
const MAX_PATCH_FILE_BYTES = 8 * 1024 * 1024;
const MAX_LIST_FILES = 1_000;

type ReindexResult = { status: "queued"; jobId?: string } | { status: "not_queued"; error: string };
type Upload = {
  vaultId: string;
  targetPath: string;
  relativePath: string;
  temporaryPath: string;
  expectedSha256?: string;
  targetExisted: boolean;
  sizeBytes: number;
};

export function createVaultFileService({
  vaultsRoot,
  registryPath,
  reindex,
}: {
  vaultsRoot: string;
  registryPath: string;
  reindex: (vaultId: string) => Promise<{ jobId?: string }>;
}) {
  const uploads = new Map<string, Upload>();

  async function vault(vaultId?: string) {
    return resolveVault(await loadVaults(registryPath), vaultId);
  }

  return {
    async listFiles(input: { vaultId?: string; path?: string; maxEntries?: number }) {
      const selected = await vault(input.vaultId);
      const root = await vaultRoot(vaultsRoot, selected);
      const relativeDirectory = input.path ?? "";
      const directory = await existingDirectory(root, relativeDirectory);
      const maxEntries = bounded(input.maxEntries, 200, 1, MAX_LIST_FILES, "maxEntries");
      const files: Array<{ path: string; sizeBytes: number }> = [];
      let truncated = false;

      async function walk(current: string, relative: string) {
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
            const details = await stat(child);
            files.push({ path: childRelative, sizeBytes: details.size });
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

    async readFile(input: {
      vaultId?: string;
      path: string;
      startLine?: number;
      maxLines?: number;
      maxBytes?: number;
    }) {
      const selected = await vault(input.vaultId);
      const root = await vaultRoot(vaultsRoot, selected);
      const relativePath = writableRelativePath(input.path);
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

    async writeFile(input: { vaultId?: string; path: string; content: string; expectedSha256?: string }) {
      const bytes = Buffer.byteLength(input.content, "utf8");
      if (bytes > MAX_WRITE_BYTES) {
        throw new Error(`content exceeds ${MAX_WRITE_BYTES} bytes; use the bounded upload tools for a new large file or applyPatch for an existing file`);
      }
      const selected = await vault(input.vaultId);
      const root = await vaultRoot(vaultsRoot, selected);
      const relativePath = writableRelativePath(input.path);
      const target = await writableFile(root, relativePath);
      await assertCurrent(target, input.expectedSha256);
      await atomicWrite(target, input.content);
      return {
        vaultId: selected.id,
        file: await fileDetails(target, relativePath),
        reindex: await queueReindex(selected.id, reindex),
      };
    },

    async applyPatch(input: {
      vaultId?: string;
      path: string;
      expectedSha256: string;
      oldText: string;
      newText: string;
    }) {
      if (!input.oldText) throw new Error("oldText must not be empty; use writeFile or upload to create a file");
      if (Buffer.byteLength(input.oldText, "utf8") + Buffer.byteLength(input.newText, "utf8") > MAX_WRITE_BYTES) {
        throw new Error(`patch exceeds ${MAX_WRITE_BYTES} bytes`);
      }
      const selected = await vault(input.vaultId);
      const root = await vaultRoot(vaultsRoot, selected);
      const relativePath = writableRelativePath(input.path);
      const target = await existingFile(root, relativePath);
      const details = await stat(target);
      if (details.size > MAX_PATCH_FILE_BYTES) {
        throw new Error(`file exceeds ${MAX_PATCH_FILE_BYTES} bytes; patching this file is not supported`);
      }
      const currentHash = await hashFile(target);
      if (currentHash !== input.expectedSha256) throw changedError();
      const current = await readFile(target, "utf8");
      const first = current.indexOf(input.oldText);
      if (first === -1) throw new Error("oldText was not found in the current file");
      if (current.indexOf(input.oldText, first + input.oldText.length) !== -1) {
        throw new Error("oldText occurs more than once; provide a unique patch target");
      }
      await atomicWrite(target, `${current.slice(0, first)}${input.newText}${current.slice(first + input.oldText.length)}`);
      return {
        vaultId: selected.id,
        file: await fileDetails(target, relativePath),
        reindex: await queueReindex(selected.id, reindex),
      };
    },

    async beginUpload(input: { vaultId?: string; path: string; expectedSha256?: string }) {
      const selected = await vault(input.vaultId);
      const root = await vaultRoot(vaultsRoot, selected);
      const relativePath = writableRelativePath(input.path);
      const target = await writableFile(root, relativePath);
      const targetExisted = await exists(target);
      await assertCurrent(target, input.expectedSha256);
      const uploadId = randomUUID();
      const temporaryPath = path.join(path.dirname(target), `.obsidian-mcp-upload-${uploadId}.tmp`);
      await writeFile(temporaryPath, "", { flag: "wx", mode: 0o600 });
      uploads.set(uploadId, {
        vaultId: selected.id,
        targetPath: target,
        relativePath,
        temporaryPath,
        expectedSha256: input.expectedSha256,
        targetExisted,
        sizeBytes: 0,
      });
      return { uploadId, maxChunkBytes: MAX_CHUNK_BYTES, maxUploadBytes: MAX_UPLOAD_BYTES };
    },

    async appendUpload(input: { uploadId: string; contentBase64: string }) {
      const upload = requiredUpload(uploads, input.uploadId);
      const bytes = decodeBase64(input.contentBase64);
      if (bytes.length > MAX_CHUNK_BYTES) throw new Error(`upload chunk exceeds ${MAX_CHUNK_BYTES} bytes`);
      if (upload.sizeBytes + bytes.length > MAX_UPLOAD_BYTES) throw new Error(`upload exceeds ${MAX_UPLOAD_BYTES} bytes`);
      await appendFile(upload.temporaryPath, bytes);
      upload.sizeBytes += bytes.length;
      return { uploadId: input.uploadId, sizeBytes: upload.sizeBytes };
    },

    async finishUpload(input: { uploadId: string; sha256?: string }) {
      const upload = requiredUpload(uploads, input.uploadId);
      try {
        await assertUploadTargetCurrent(upload);
        await assertUtf8(upload.temporaryPath);
        const sha256 = await hashFile(upload.temporaryPath);
        if (input.sha256 && input.sha256 !== sha256) throw new Error("uploaded content hash did not match sha256");
        await rename(upload.temporaryPath, upload.targetPath);
        uploads.delete(input.uploadId);
        return {
          vaultId: upload.vaultId,
          file: await fileDetails(upload.targetPath, upload.relativePath),
          reindex: await queueReindex(upload.vaultId, reindex),
        };
      } catch (error) {
        uploads.delete(input.uploadId);
        await rm(upload.temporaryPath, { force: true });
        throw error;
      }
    },
  };
}

async function vaultRoot(vaultsRoot: string, vault: VaultRecord) {
  if (!vault.directory || !/^[a-z0-9][a-z0-9-]*$/.test(vault.directory)) {
    throw new Error(`Vault '${vault.id}' has an invalid directory`);
  }
  const root = await realpath(vaultsRoot);
  const candidate = await realpath(path.join(root, vault.directory));
  if (path.dirname(candidate) !== root) throw new Error(`Vault '${vault.id}' is outside the configured vault root`);
  return candidate;
}

function writableRelativePath(value: string) {
  const relative = normalizedRelativePath(value, { allowEmpty: false });
  if (relative.split("/").includes(".git")) throw new Error("Git metadata cannot be accessed through the vault filesystem MCP");
  if (!TEXT_EXTENSIONS.has(path.extname(relative).toLowerCase())) {
    throw new Error("The vault filesystem MCP only supports .md and .canvas files");
  }
  return relative;
}

function normalizedRelativePath(value: string, { allowEmpty }: { allowEmpty: boolean }) {
  if (typeof value !== "string" || value.includes("\\") || path.isAbsolute(value)) {
    throw new Error("path must be a relative vault path");
  }
  const normalized = value.replace(/^\.\//, "").replace(/\/+$/, "");
  if (!normalized && allowEmpty) return "";
  const segments = normalized.split("/");
  if (!normalized || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("path must be a relative vault path");
  }
  if (segments.includes(".git")) throw new Error("Git metadata cannot be accessed through the vault filesystem MCP");
  return normalized;
}

async function existingDirectory(root: string, relativePath: string) {
  if (!relativePath) return root;
  const directory = await safeTarget(root, normalizedRelativePath(relativePath, { allowEmpty: false }), false);
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("path is not a directory");
  return directory;
}

async function existingFile(root: string, relativePath: string) {
  const target = await safeTarget(root, relativePath, false);
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("path is not a regular file");
  return target;
}

async function writableFile(root: string, relativePath: string) {
  const target = await safeTarget(root, relativePath, true);
  const info = await optionalLstat(target);
  if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error("path is not a regular file");
  return target;
}

async function safeTarget(root: string, relativePath: string, createParents: boolean) {
  let current = root;
  const segments = relativePath.split("/");
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    const info = await optionalLstat(current);
    if (!info && createParents) {
      await mkdir(current);
      continue;
    }
    if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error("path escapes the vault through a non-directory or symlink");
  }
  const target = path.join(current, segments.at(-1)!);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error("path must be a relative vault path");
  const info = await optionalLstat(target);
  if (info?.isSymbolicLink()) throw new Error("symbolic links cannot be accessed through the vault filesystem MCP");
  return target;
}

async function assertCurrent(target: string, expectedSha256?: string) {
  const targetExists = await exists(target);
  if (!targetExists) {
    if (expectedSha256) throw new Error("expectedSha256 was supplied but the file does not exist");
    return;
  }
  if (!expectedSha256) throw new Error("expectedSha256 is required when replacing an existing file");
  if (await hashFile(target) !== expectedSha256) throw changedError();
}

async function assertUploadTargetCurrent(upload: Upload) {
  const existsNow = await exists(upload.targetPath);
  if (upload.targetExisted !== existsNow) throw changedError();
  if (upload.expectedSha256 && await hashFile(upload.targetPath) !== upload.expectedSha256) throw changedError();
}

async function atomicWrite(target: string, content: string) {
  const temporaryPath = path.join(path.dirname(target), `.obsidian-mcp-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, content, { flag: "wx", mode: 0o600 });
    await rename(temporaryPath, target);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function readLines(file: string, { startLine, maxLines, maxBytes }: { startLine: number; maxLines: number; maxBytes: number }) {
  const reader = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  const lines: string[] = [];
  let lineNumber = 0;
  let sizeBytes = 0;
  let hasMore = false;
  for await (const line of reader) {
    lineNumber += 1;
    if (lineNumber < startLine) continue;
    const next = `${line}\n`;
    const nextBytes = Buffer.byteLength(next, "utf8");
    if (lines.length >= maxLines || sizeBytes + nextBytes > maxBytes) {
      hasMore = true;
      break;
    }
    lines.push(next);
    sizeBytes += nextBytes;
  }
  return { content: lines.join(""), startLine, nextLine: startLine + lines.length, hasMore };
}

async function fileDetails(file: string, relativePath: string) {
  const details = await stat(file);
  return { path: relativePath, sizeBytes: details.size, sha256: await hashFile(file) };
}

async function hashFile(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function assertUtf8(file: string) {
  const content = await readFile(file);
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new Error("uploaded content must be valid UTF-8 text");
  }
}

async function queueReindex(vaultId: string, reindex: (vaultId: string) => Promise<{ jobId?: string }>): Promise<ReindexResult> {
  try {
    const result = await reindex(vaultId);
    return { status: "queued", ...result };
  } catch (error) {
    return { status: "not_queued", error: error instanceof Error ? error.message : String(error) };
  }
}

async function optionalLstat(target: string) {
  try {
    return await lstat(target);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function exists(target: string) {
  return (await optionalLstat(target)) !== null;
}

function requiredUpload(uploads: Map<string, Upload>, uploadId: string) {
  const upload = uploads.get(uploadId);
  if (!upload) throw new Error(`Unknown or completed upload: ${uploadId}`);
  return upload;
}

function decodeBase64(value: string) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("contentBase64 must be valid padded base64");
  }
  return Buffer.from(value, "base64");
}

function bounded(value: number | undefined, fallback: number, min: number, max: number, name: string) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < min || result > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return result;
}

function changedError() {
  return new Error("file changed since it was read; read it again and retry with the current sha256");
}
