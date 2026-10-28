import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const VAULT_DOCUMENT_FOLDER_PREFIX = "anything-obsidian-vault";

export function vaultDocumentFolder(vaultId) {
  return `${VAULT_DOCUMENT_FOLDER_PREFIX}-${vaultId}`;
}

// Namespaced per machine so multiple any-obs instances sharing one
// AnythingLLM never collide on the unified workspace.
export function defaultUnifiedWorkspaceName({ hostname = os.hostname() } = {}) {
  const host = String(hostname ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "host";
  return `any-obs-${host}-${randomBytes(2).toString("hex")}`;
}

/**
 * Idempotently make sure the registry carries one unified workspace.
 *
 * Migration from the legacy per-vault model (vault records carrying their own
 * workspaceSlug): the legacy fields are dropped and every embed manifest is
 * wiped so the next embed re-uploads all vaults into the unified workspace.
 * Old per-vault workspaces are never deleted.
 */
export async function ensureUnifiedWorkspace({
  registry,
  anythingllm,
  stateRoot = "",
  hostname,
  attachSlug = "",
}) {
  const existing = await registry.getWorkspace();
  if (existing) return { workspace: existing, created: false, migrated: false };

  const legacyVaults = (await registry.list()).filter(
    (vault) => typeof vault.workspaceSlug === "string" && vault.workspaceSlug,
  );

  let workspace;
  if (attachSlug) {
    workspace = (await anythingllm.listWorkspaces()).find(
      (candidate) => candidate.slug === attachSlug,
    ) ?? null;
    if (!workspace) throw new Error(`Workspace was not found: ${attachSlug}`);
  } else {
    workspace = await anythingllm.createWorkspace({
      name: defaultUnifiedWorkspaceName({ hostname }),
    });
  }
  await registry.setWorkspace(workspace);

  if (legacyVaults.length) {
    for (const vault of legacyVaults) await registry.update(vault.id, {});
    if (stateRoot) {
      await rm(path.join(stateRoot, "manifests"), { recursive: true, force: true });
    }
  }
  return { workspace, created: true, migrated: legacyVaults.length > 0 };
}

/**
 * Remove one vault's derived data from the unified workspace when it leaves
 * management: embedded chunks (manifest locations), its document folder, and
 * its local manifest. The repository and the workspace itself are never
 * touched. Best effort: errors are collected, never thrown.
 */
export async function purgeVaultEmbeddings({
  baseUrl,
  apiKey,
  workspaceSlug,
  vaultId,
  stateRoot = "",
  fetchImpl = fetch,
}) {
  const errors = [];
  const manifestDir = path.join(stateRoot, "manifests", vaultId);
  const manifestPath = path.join(manifestDir, "embed-manifest.json");

  let locations = [];
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    locations = Object.values(manifest.files ?? {}).flatMap((entry) =>
      Array.isArray(entry?.locations) ? entry.locations : [],
    );
  } catch (error) {
    if (error?.code !== "ENOENT") errors.push(`read manifest: ${describe(error)}`);
  }

  if (locations.length) {
    try {
      await anythingllmRequest(fetchImpl, baseUrl, `/api/v1/workspace/${encodeURIComponent(workspaceSlug)}/update-embeddings`, {
        method: "POST",
        apiKey,
        body: { adds: [], deletes: locations },
      });
    } catch (error) {
      errors.push(`remove embeddings: ${describe(error)}`);
    }
  }

  try {
    await anythingllmRequest(fetchImpl, baseUrl, "/api/v1/document/remove-folder", {
      method: "DELETE",
      apiKey,
      body: { name: vaultDocumentFolder(vaultId) },
    });
  } catch (error) {
    errors.push(`remove document folder: ${describe(error)}`);
  }

  try {
    await rm(manifestDir, { recursive: true, force: true });
  } catch (error) {
    errors.push(`remove manifest: ${describe(error)}`);
  }

  return { vaultId, workspaceSlug, purged: errors.length === 0, ...(errors.length ? { errors } : {}) };
}

async function anythingllmRequest(fetchImpl, baseUrl, apiPath, { method, apiKey, body }) {
  const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}${apiPath}`, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = (await response.text().catch(() => "")).trim();
    throw new Error(`AnythingLLM API ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  return response;
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
