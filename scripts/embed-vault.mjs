#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");
const env = loadEnv(path.join(repoRoot, ".env"));
const args = new Set(process.argv.slice(2));

const baseUrl = stripTrailingSlash(
  env.ANYTHINGLLM_BASE_URL ?? `http://localhost:${env.HOST_ANYTHINGLLM_PORT ?? "11301"}`,
);
const apiKey = env.ANYTHINGLLM_API_KEY;
const workspaceSlug = env.ANYTHINGLLM_WORKSPACE_SLUG ?? "obsidian";
const documentFolder = env.ANYTHINGLLM_DOCUMENT_FOLDER ?? "anything-obsidian-vault";
const vaultPath = path.resolve(repoRoot, env.VAULT_PATH ?? "../vault");
const stateDir = path.resolve(repoRoot, env.KB_STATE_DIR ?? ".anything-obsidian-state");
const manifestPath = path.join(stateDir, "embed-manifest.json");
const extensions = csv(env.KB_EMBED_EXTENSIONS ?? ".md,.txt,.pdf,.docx").map((ext) =>
  ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`,
);
const excludeDirs = new Set(
  csv(
    env.KB_EMBED_EXCLUDE_DIRS ??
      ".git,.obsidian,node_modules,mcp,.anything-obsidian-storage,.anything-obsidian-state",
  ),
);
const uploadPathTemplate =
  env.ANYTHINGLLM_DOCUMENT_UPLOAD_PATH_TEMPLATE ?? "/api/v1/document/upload/{folder}";
const updateEmbeddingsPathTemplate =
  env.ANYTHINGLLM_UPDATE_EMBEDDINGS_PATH_TEMPLATE ??
  "/api/v1/workspace/{slug}/update-embeddings";

if (!apiKey) {
  fail("Missing ANYTHINGLLM_API_KEY in .env.");
}

const manifest = await readManifest();
const files = await listVaultFiles(vaultPath);
const seen = new Set();
const additions = [];
const deletions = [];
const nextManifest = { version: 1, files: { ...manifest.files } };

for (const file of files) {
  const rel = toPosix(path.relative(vaultPath, file));
  seen.add(rel);

  const hash = await sha256(file);
  const previous = manifest.files[rel];
  if (!args.has("--all") && previous?.hash === hash && previous?.locations?.length) {
    continue;
  }

  const uploaded = await uploadFile(file, rel);
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
  await updateEmbeddings(additions, deletions);
  await mkdir(stateDir, { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
}

console.log(
  JSON.stringify(
    {
      scanned: files.length,
      uploaded: additions.length,
      removed: deletions.length,
      workspaceSlug,
    },
    null,
    2,
  ),
);

async function uploadFile(file, rel) {
  const url = apiUrl(
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

async function updateEmbeddings(adds, deletes) {
  const url = apiUrl(
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

async function listVaultFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory() && excludeDirs.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listVaultFiles(abs)));
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

async function readManifest() {
  try {
    const raw = await readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw);
    return { version: 1, files: parsed.files ?? {} };
  } catch {
    return { version: 1, files: {} };
  }
}

function loadEnv(file) {
  const values = {};
  try {
    const raw = readFileSyncCompat(file);
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index === -1) continue;
      const key = trimmed.slice(0, index).trim();
      let value = trimmed.slice(index + 1).trim();
      value = value.replace(/^['"]|['"]$/g, "");
      values[key] = process.env[key] ?? value;
    }
  } catch {
    // Missing .env is handled by required config checks.
  }
  return { ...values, ...process.env };
}

function readFileSyncCompat(file) {
  return readFileSync(file, "utf8");
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

function apiUrl(pathOrUrl) {
  if (pathOrUrl.startsWith("http")) return pathOrUrl;
  return `${baseUrl}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
