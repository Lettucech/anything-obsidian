#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { withFileLock, writeJson } from "../lib/state.mjs";
import { fetchWithTimeout } from "../lib/http.mjs";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");

// Kept single-segment on purpose: AnythingLLM rejects folder names that
// contain path separators (its older permissive behaviour was undocumented),
// so the {folder} value must never grow a "/" — the vault id is the only
// variable part and registry ids are slugs.
export const DEFAULT_DOCUMENT_UPLOAD_PATH_TEMPLATE = "/api/v1/document/upload/{folder}";

// Folder layout before per-vault folders existed: one shared default folder
// with the vault id as a subpath (`anything-obsidian-vault/<vaultId>/...`).
// Stale-document reconciliation must claim that layout too, or old copies
// survive a manifest loss forever.
export const LEGACY_DOCUMENT_FOLDER = "anything-obsidian-vault";

export async function embedVault({
  config,
  all = false,
  onProgress = async () => {},
  signal,
  fetchImpl = fetch,
  pollIntervalMs,
}) {
  const stateDir = config.stateDir ?? path.resolve(repoRoot, ".anything-obsidian-state");
  const run = () =>
    embedUnlocked({ config, stateDir, all, onProgress, signal, fetchImpl, pollIntervalMs });
  return config.operationLockHeld ? run() : withFileLock(`${stateDir}.lock`, run, { signal });
}

async function embedUnlocked({
  config,
  stateDir,
  all,
  onProgress,
  signal,
  fetchImpl,
  pollIntervalMs = 5_000,
}) {
  await config.assertRegistered?.();
  const { apiKey, workspaceSlug, vaultPath } = config;
  const baseUrl = stripTrailingSlash(config.anythingllmBaseUrl);
  const documentFolder = config.documentFolder ?? "anything-obsidian-vault";
  const manifestPath = path.join(stateDir, "embed-manifest.json");
  const remote = { baseUrl, apiKey, workspaceSlug, fetchImpl, signal };
  if (!apiKey) throw new Error("No API key configured. Run: anything-obsidian setup");
  await onProgress({ phase: "checking", completed: 0, total: 0 });
  await assertWorkspaceExists(remote);
  const documents = await listWorkspaceDocuments(remote);
  if (!documents)
    throw new Error("Cannot verify workspace documents; indexing has not been committed");
  const remoteLocations = new Set(
    documents.map((document) => document.docpath ?? document.location).filter(Boolean),
  );
  const identity = { baseUrl, workspaceSlug, documentFolder };
  const previousManifest = await readManifest(manifestPath, all);
  const sameTarget = JSON.stringify(previousManifest.target) === JSON.stringify(identity);
  const manifest = sameTarget ? previousManifest : { files: {} };
  const files = await embeddableVaultFiles(vaultPath, {
    extensions: config.embedExtensions,
    excludeDirs: config.embedExcludeDirs,
  });
  const nextManifest = { version: 2, target: identity, files: {} };
  const additions = [];
  let repaired = 0;
  for (const [index, file] of files.entries()) {
    signal?.throwIfAborted();
    const rel = toPosix(path.relative(vaultPath, file));
    const hash = await sha256(file);
    const previous = manifest.files[rel];
    const present =
      previous?.locations?.length &&
      previous.locations.every((location) => remoteLocations.has(location));
    if (!all && previous?.hash === hash && present) {
      nextManifest.files[rel] = previous;
    } else {
      if (previous && !present) repaired++;
      await onProgress({ phase: "uploading", file: rel, completed: index, total: files.length });
      const uploaded = await uploadFile({
        ...remote,
        file,
        rel,
        vaultId: config.vaultId,
        documentFolder,
        uploadPathTemplate:
          config.documentUploadPathTemplate ?? DEFAULT_DOCUMENT_UPLOAD_PATH_TEMPLATE,
      });
      const locations = uploaded?.documents
        ?.map((document) => document.location)
        .filter((location) => typeof location === "string" && location);
      if (!locations?.length) throw new Error(`Upload returned no document locations for ${rel}`);
      additions.push(...locations);
      nextManifest.files[rel] = { hash, locations, embeddedAt: new Date().toISOString() };
    }
    await onProgress({ phase: "scanning", completed: index + 1, total: files.length });
  }
  const trackedLocations = new Set(
    Object.values(nextManifest.files).flatMap((entry) => entry.locations),
  );
  const prefixes = ownedPathPrefixes({ documentFolder, vaultId: config.vaultId });
  const deletions = [...remoteLocations].filter(
    (location) =>
      prefixes.some((prefix) => location.startsWith(prefix)) && !trackedLocations.has(location),
  );
  const updateEmbeddingsPathTemplate =
    config.updateEmbeddingsPathTemplate ?? "/api/v1/workspace/{slug}/update-embeddings";
  // Add and verify first. A failed replacement must not remove the last good index.
  if (additions.length) {
    await onProgress({ phase: "embedding", completed: 0, total: additions.length });
    await updateEmbeddings({
      ...remote,
      adds: additions,
      deletes: [],
      updateEmbeddingsPathTemplate,
      onProgress,
      phase: "embedding",
      pollIntervalMs,
    });
    await verifyDocuments(remote, additions, []);
  }
  if (deletions.length) {
    await onProgress({ phase: "cleaning", completed: 0, total: deletions.length });
    await updateEmbeddings({
      ...remote,
      adds: [],
      deletes: deletions,
      updateEmbeddingsPathTemplate,
      onProgress,
      phase: "cleaning",
      pollIntervalMs,
    });
    await verifyDocuments(remote, [...trackedLocations], deletions);
  }
  signal?.throwIfAborted();
  await writeJson(manifestPath, nextManifest);
  const result = {
    scanned: files.length,
    uploaded: additions.length,
    removed: deletions.length,
    reconciled: deletions.length,
    repaired,
    workspaceSlug,
    verified: true,
  };
  await onProgress({ phase: "completed", completed: files.length, total: files.length, ...result });
  return result;
}

async function verifyDocuments(remote, expected, removed) {
  const documents = await listWorkspaceDocuments(remote);
  if (!documents)
    throw new Error("Cannot verify the embedding result; the manifest was not advanced");
  const actual = new Set(documents.map((document) => document.docpath ?? document.location));
  const missing = expected.filter((location) => !actual.has(location));
  const remaining = removed.filter((location) => actual.has(location));
  if (missing.length || remaining.length)
    throw new Error(
      `Index verification failed: ${missing.length} missing, ${remaining.length} stale document(s). Retry the job.`,
    );
}

async function uploadFile({
  file,
  rel,
  baseUrl,
  apiKey,
  vaultId,
  documentFolder,
  uploadPathTemplate,
  fetchImpl,
  signal,
}) {
  const url = apiUrl(
    baseUrl,
    uploadPathTemplate.replace("{folder}", encodeURIComponent(documentFolder)),
  );
  // The vaultId prefix is what makes unified-workspace search results
  // attributable: RAG hits map straight back to the owning vault's files.
  const source = vaultId ? `${vaultId}/${rel}` : rel;
  const body = new FormData();
  const blob = new Blob([await readFile(file)]);
  body.append("file", blob, path.basename(file));
  body.append(
    "metadata",
    JSON.stringify({
      title: source,
      docSource: "anything-obsidian vault",
      chunkSource: source,
    }),
  );

  const response = await fetchWithTimeout(fetchImpl, url, {
    signal,
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body,
  });
  return readResponse(response, `upload ${rel}`);
}

async function assertWorkspaceExists({ baseUrl, apiKey, workspaceSlug, fetchImpl, signal }) {
  const response = await fetchWithTimeout(fetchImpl, apiUrl(baseUrl, "/api/v1/workspaces"), {
    signal,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
  });
  const data = await readResponse(response, "list workspaces");
  const workspaces = Array.isArray(data?.workspaces) ? data.workspaces : [];
  const slugs = workspaces.map((workspace) => workspace.slug).filter(Boolean);

  if (slugs.includes(workspaceSlug)) return;

  const available = slugs.length ? slugs.join(", ") : "none";
  throw new Error(
    `AnythingLLM workspace '${workspaceSlug}' was not found. Available workspaces: ${available}. ` +
      "Attach an existing workspace or create one from this vault's dashboard configuration.",
  );
}

// The upstream `update-embeddings` endpoint blocks server-side until the
// whole batch is processed, and a vault-sized batch outlives any sane client
// wait (the 120s fetch default used to abort the job while AnythingLLM kept
// embedding fine on its own). So the request is fired without awaiting it and
// the workspace document list is polled instead: pins land per document as
// their chunks are inserted, so the poll reports real progress — and the
// verified listing, not the request, decides success.
const EMBED_REQUEST_TIMEOUT_MS = 30 * 60_000;

async function updateEmbeddings({
  adds,
  deletes,
  baseUrl,
  apiKey,
  workspaceSlug,
  updateEmbeddingsPathTemplate,
  fetchImpl,
  signal,
  onProgress,
  phase = "embedding",
  pollIntervalMs = 5_000,
  settledGracePolls = 3,
}) {
  const url = apiUrl(
    baseUrl,
    updateEmbeddingsPathTemplate.replace("{slug}", encodeURIComponent(workspaceSlug)),
  );
  const expectPresent = adds ?? [];
  const expectAbsent = deletes ?? [];
  const total = expectPresent.length + expectAbsent.length;
  let requestError = null;
  let requestSettled = false;
  const request = fetchWithTimeout(
    fetchImpl,
    url,
    {
      signal,
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ adds, deletes }),
    },
    EMBED_REQUEST_TIMEOUT_MS,
  )
    .then((response) => readResponse(response, "update embeddings"))
    .catch((error) => {
      requestError = error;
    })
    .finally(() => {
      requestSettled = true;
    });
  try {
    if (total === 0) {
      await request;
    } else {
      const remote = { baseUrl, apiKey, workspaceSlug, fetchImpl, signal };
      let grace = settledGracePolls;
      let reported = -1;
      for (;;) {
        signal?.throwIfAborted();
        if (requestError) break;
        const documents = await listWorkspaceDocuments(remote);
        if (Array.isArray(documents)) {
          const locations = new Set(
            documents.map((document) => document.docpath ?? document.location).filter(Boolean),
          );
          const completed =
            expectPresent.filter((location) => locations.has(location)).length +
            expectAbsent.filter((location) => !locations.has(location)).length;
          if (completed !== reported) {
            reported = completed;
            if (onProgress) await onProgress({ phase, completed, total });
          }
          if (completed === total) break;
        }
        // Upstream says it is done but the listing disagrees (or is
        // unreadable) — give it a few polls, then let the caller's
        // verification describe the failure.
        if (requestSettled && --grace <= 0) break;
        await sleep(pollIntervalMs, signal);
      }
    }
  } finally {
    request.catch(() => {}); // never leave a dangling rejection when bailing early
  }
  if (requestError) throw requestError;
}

function ownedPathPrefixes({ documentFolder, vaultId }) {
  const prefixes = [`${documentFolder}/`];
  // The shared legacy folder hosts every vault under a per-vault subpath, so
  // there the vault-scoped prefix replaces the folder-wide one — claiming the
  // whole folder would delete sibling vaults' documents.
  if (documentFolder === LEGACY_DOCUMENT_FOLDER) prefixes.length = 0;
  if (vaultId) prefixes.push(`${LEGACY_DOCUMENT_FOLDER}/${vaultId}/`);
  return prefixes;
}

// AnythingLLM has no folder-listing endpoint; the workspace detail response
// carries every document with its `docpath` (`<folder>/<...>/<name>.json`).
// Gateways expose the same shape through a synthesized
// `/workspace/{slug}/documents` route because user tokens may not read the
// full workspace detail.
export async function listWorkspaceDocuments({
  baseUrl,
  apiKey,
  workspaceSlug,
  fetchImpl = fetch,
  signal,
}) {
  const slug = encodeURIComponent(workspaceSlug);
  for (const apiPath of [`/api/v1/workspace/${slug}/documents`, `/api/v1/workspace/${slug}`]) {
    let data = null;
    try {
      const response = await fetchWithTimeout(fetchImpl, apiUrl(baseUrl, apiPath), {
        signal,
        headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
      });
      if (!response.ok) continue;
      const text = await response.text();
      data = text ? safeJson(text) : null;
    } catch {
      continue;
    }
    const workspace = Array.isArray(data?.workspace) ? data.workspace[0] : data?.workspace;
    if (Array.isArray(workspace?.documents)) return workspace.documents;
    if (Array.isArray(data?.documents)) return data.documents;
  }
  return null;
}

async function readResponse(response, action) {
  const text = await response.text();
  const data = text ? safeJson(text) : null;
  if (!response.ok || data?.success === false || data?.error) {
    throw new Error(`${action} failed with ${response.status}: ${text}`);
  }
  return data;
}

export const DEFAULT_EMBED_EXTENSIONS = ".md,.txt,.pdf,.docx";
export const DEFAULT_EMBED_EXCLUDE_DIRS =
  ".git,.obsidian,node_modules,mcp,.anything-obsidian-storage,.anything-obsidian-state";

export async function embeddableVaultFiles(vaultPath, { extensions, excludeDirs } = {}) {
  return listVaultFiles(vaultPath, {
    extensions: normalizeExtensions(extensions ?? DEFAULT_EMBED_EXTENSIONS),
    excludeDirs: new Set(csv(excludeDirs ?? DEFAULT_EMBED_EXCLUDE_DIRS)),
  });
}

function normalizeExtensions(value) {
  return csv(value).map((ext) =>
    ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`,
  );
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
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

async function readManifest(manifestPath, force) {
  try {
    const raw = await readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw);
    return { ...parsed, files: parsed.files ?? {} };
  } catch (error) {
    if (force && error instanceof SyntaxError) return { version: 2, files: {} };
    if (error.code !== "ENOENT")
      throw new Error(`Cannot read embedding manifest: ${error.message}`);
    return { version: 2, files: {} };
  }
}

// Resolves early when the signal aborts; the loop's throwIfAborted reports it.
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const done = () => {
      signal?.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
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
