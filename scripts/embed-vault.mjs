#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadEnvFile, resolveConfig } from "./lib/env.mjs";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");

export async function embedVault({ config, all = false }) {
  const baseUrl = stripTrailingSlash(config.anythingllmBaseUrl);
  const apiKey = config.apiKey;
  const workspaceSlug = config.workspaceSlug;
  const documentFolder = config.documentFolder ?? "anything-obsidian-vault";
  const vaultPath = config.vaultPath;
  const stateDir = config.stateDir ?? path.resolve(repoRoot, ".anything-obsidian-state");
  const manifestPath = path.join(stateDir, "embed-manifest.json");
  const extensions = csv(config.embedExtensions ?? ".md,.txt,.pdf,.docx").map((ext) =>
    ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`,
  );
  const excludeDirs = new Set(
    csv(
      config.embedExcludeDirs ??
        ".git,.obsidian,node_modules,mcp,.anything-obsidian-storage,.anything-obsidian-state",
    ),
  );
  const uploadPathTemplate =
    config.documentUploadPathTemplate ?? "/api/v1/document/upload/{folder}";
  const updateEmbeddingsPathTemplate =
    config.updateEmbeddingsPathTemplate ?? "/api/v1/workspace/{slug}/update-embeddings";

  if (!apiKey) {
    throw new Error("Missing ANYTHINGLLM_API_KEY in .env.");
  }

  const manifest = await readManifest(manifestPath);
  const files = await listVaultFiles(vaultPath, { extensions, excludeDirs });
  const seen = new Set();
  const additions = [];
  const deletions = [];
  const nextManifest = { version: 1, files: { ...manifest.files } };

  for (const file of files) {
    const rel = toPosix(path.relative(vaultPath, file));
    seen.add(rel);

    const hash = await sha256(file);
    const previous = manifest.files[rel];
    if (!all && previous?.hash === hash && previous?.locations?.length) {
      continue;
    }

    const uploaded = await uploadFile({
      file,
      rel,
      baseUrl,
      apiKey,
      documentFolder,
      uploadPathTemplate,
    });
    const locations = uploaded.documents
      ?.map((document) => document.location)
      .filter(Boolean);

    if (!locations?.length) {
      console.warn(`No document locations returned for ${rel}; skipping embedding update.`);
      continue;
    }

    additions.push(...locations);
    if (previous?.locations?.length) deletions.push(...previous.locations);
    nextManifest.files[rel] = { hash, locations, embeddedAt: new Date().toISOString() };
    console.log(`Prepared ${rel}`);
  }

  for (const [rel, previous] of Object.entries(manifest.files)) {
    if (seen.has(rel)) continue;
    if (previous?.locations?.length) deletions.push(...previous.locations);
    delete nextManifest.files[rel];
    console.log(`Marked deleted ${rel}`);
  }

  if (additions.length || deletions.length) {
    await updateEmbeddings({
      adds: additions,
      deletes: deletions,
      baseUrl,
      apiKey,
      workspaceSlug,
      updateEmbeddingsPathTemplate,
    });
    await mkdir(stateDir, { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
  }

  return {
    scanned: files.length,
    uploaded: additions.length,
    removed: deletions.length,
    workspaceSlug,
  };
}

async function uploadFile({
  file,
  rel,
  baseUrl,
  apiKey,
  documentFolder,
  uploadPathTemplate,
}) {
  const url = apiUrl(
    baseUrl,
    uploadPathTemplate.replace("{folder}", encodeURIComponent(documentFolder)),
  );
  const body = new FormData();
  const blob = new Blob([await readFile(file)]);
  body.append("file", blob, path.basename(file));
  body.append(
    "metadata",
    JSON.stringify({
      title: rel,
      docSource: "anything-obsidian vault",
      chunkSource: rel,
    }),
  );

  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body,
  });
  return readResponse(response, `upload ${rel}`);
}

async function updateEmbeddings({
  adds,
  deletes,
  baseUrl,
  apiKey,
  workspaceSlug,
  updateEmbeddingsPathTemplate,
}) {
  const url = apiUrl(
    baseUrl,
    updateEmbeddingsPathTemplate.replace("{slug}", encodeURIComponent(workspaceSlug)),
  );
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ adds, deletes }),
  });
  return readResponse(response, "update embeddings");
}

async function readResponse(response, action) {
  const text = await response.text();
  const data = text ? safeJson(text) : null;
  if (!response.ok) {
    throw new Error(`${action} failed with ${response.status}: ${text}`);
  }
  return data;
}

async function listVaultFiles(dir, { extensions, excludeDirs }) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory() && excludeDirs.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listVaultFiles(abs, { extensions, excludeDirs })));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!extensions.includes(path.extname(entry.name).toLowerCase())) continue;
    files.push(abs);
  }

  return files.sort();
}

async function sha256(file) {
  const info = await stat(file);
  const hash = createHash("sha256");
  hash.update(`${info.size}:${info.mtimeMs}:`);
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

async function readManifest(manifestPath) {
  try {
    const raw = await readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw);
    return { version: 1, files: parsed.files ?? {} };
  } catch {
    return { version: 1, files: {} };
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function csv(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function apiUrl(baseUrl, pathOrUrl) {
  if (pathOrUrl.startsWith("http")) return pathOrUrl;
  return `${baseUrl}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function extendConfig(config, env) {
  return {
    ...config,
    documentFolder: env.ANYTHINGLLM_DOCUMENT_FOLDER ?? config.documentFolder,
    stateDir: env.KB_STATE_DIR
      ? path.resolve(repoRoot, env.KB_STATE_DIR)
      : config.stateDir,
    embedExtensions: env.KB_EMBED_EXTENSIONS ?? config.embedExtensions,
    embedExcludeDirs: env.KB_EMBED_EXCLUDE_DIRS ?? config.embedExcludeDirs,
    documentUploadPathTemplate:
      env.ANYTHINGLLM_DOCUMENT_UPLOAD_PATH_TEMPLATE ?? config.documentUploadPathTemplate,
    updateEmbeddingsPathTemplate:
      env.ANYTHINGLLM_UPDATE_EMBEDDINGS_PATH_TEMPLATE ??
      config.updateEmbeddingsPathTemplate,
  };
}

async function runCli() {
  const env = { ...(await loadEnvFile(path.join(repoRoot, ".env"))), ...process.env };
  const config = extendConfig(resolveConfig(env), env);
  const result = await embedVault({ config, all: process.argv.includes("--all") });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
