import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withFileLock } from "./state.mjs";
import { listWorkspaceDocuments } from "../scripts/embed-vault.mjs";
import { fetchWithTimeout } from "./http.mjs";

export const VAULT_DOCUMENT_FOLDER_PREFIX = "anything-obsidian-vault";

export function vaultDocumentFolder(vaultId) {
  return `${VAULT_DOCUMENT_FOLDER_PREFIX}-${vaultId}`;
}

// Namespaced per machine so multiple any-obs instances sharing one
// AnythingLLM never collide on the unified workspace.
export function defaultUnifiedWorkspaceName({ hostname = os.hostname() } = {}) {
  const host =
    String(hostname ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "host";
  return `any-obs-${host}-${randomBytes(2).toString("hex")}`;
}

// Deterministic per-vault slug: any-obs-<host>-<vaultId>. The host prefix
// keeps instances sharing one AnythingLLM from colliding, the vaultId keeps
// vaults from crowding each other out of retrieval (the per-vault model,
// 2026-11 — see docs/superpowers/specs/2026-11-02-per-vault-workspaces.md).
export function vaultWorkspaceName(vaultId, { hostname = os.hostname() } = {}) {
  const host =
    String(hostname ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "host";
  return `any-obs-${host}-${vaultId}`;
}

/**
 * Idempotently make sure one vault has its own workspace: the recorded slug
 * if it still exists upstream, else a deterministic any-obs-<host>-<vaultId>
 * workspace created (or re-attached by name) and recorded. A recorded slug
 * that no longer resolves upstream — a workspace deleted by hand, or a
 * pre-unified-era leftover — is replaced, never trusted blindly.
 */
export async function ensureVaultWorkspace({ vaultId, registry, anythingllm, hostname }) {
  const vault = await registry.get(vaultId);
  if (!vault) throw new Error(`Unknown vault: ${vaultId}`);
  const workspaces = await anythingllm.listWorkspaces();
  if (vault.workspaceSlug) {
    const recorded = workspaces.find((candidate) => candidate.slug === vault.workspaceSlug);
    if (recorded) return { workspaceSlug: vault.workspaceSlug, created: false };
  }
  const name = vaultWorkspaceName(vaultId, { hostname });
  const existing = workspaces.find((candidate) => candidate.slug === name);
  const workspace = existing ?? (await anythingllm.createWorkspace({ name }));
  await registry.update(vaultId, { workspaceSlug: workspace.slug });
  return { workspaceSlug: workspace.slug, created: !existing };
}

/**
 * One-shot upgrade from the unified-workspace model (2026-10-28) to per-vault
 * workspaces: assign each vault its own workspace upstream, wipe every embed
 * manifest so the normal scheduler cycle re-embeds each vault from source,
 * delete the now-redundant unified workspace (best effort — a stray empty
 * workspace is harmless), and clear the registry's workspace record.
 * Vault files and repositories are never touched.
 */
export async function migrateToPerVaultWorkspaces({
  registry,
  anythingllm,
  stateRoot = "",
  hostname,
  log = () => {},
}) {
  const unified = await registry.getWorkspace();
  if (!unified) return { migrated: false };

  const vaults = await registry.list();
  const assigned = [];
  for (const vault of vaults) {
    if (vault.workspaceSlug) {
      assigned.push(vault.workspaceSlug);
      continue;
    }
    const { workspaceSlug } = await ensureVaultWorkspace({
      vaultId: vault.id,
      registry,
      anythingllm,
      hostname,
    });
    assigned.push(workspaceSlug);
  }

  // Every manifest is now stale (chunks live in the unified workspace, vaults
  // re-embed into their own). Wiping them makes the next scheduled embed a
  // full re-upload per vault — the ordinary embed-all path.
  if (stateRoot) await rm(path.join(stateRoot, "manifests"), { recursive: true, force: true });

  let unifiedDeleted = false;
  try {
    await anythingllm.deleteWorkspace({ slug: unified.slug });
    unifiedDeleted = true;
  } catch (error) {
    log(
      `[any-obs-app] unified workspace '${unified.slug}' was not deleted: ${
        error instanceof Error ? error.message : String(error)
      } (it can be removed by hand)`,
    );
  }
  await registry.clearWorkspace();
  log(
    `[any-obs-app] migrated to per-vault workspaces (${vaults.length} vault(s)); every vault re-embeds on its next sync`,
  );
  return { migrated: true, vaults: assigned, unifiedSlug: unified.slug, unifiedDeleted };
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
  signal,
}) {
  const manifestDir = path.join(stateRoot, "manifests", vaultId);
  return withFileLock(
    `${manifestDir}.lock`,
    async () => {
      const remote = { baseUrl, apiKey, workspaceSlug, fetchImpl, signal };
      try {
        const documents = await listWorkspaceDocuments(remote);
        if (!documents) throw new Error("Cannot list workspace documents to verify cleanup");
        const prefix = `${vaultDocumentFolder(vaultId)}/`;
        const locations = documents
          .map((doc) => doc.docpath ?? doc.location)
          .filter((location) => typeof location === "string" && location.startsWith(prefix));
        if (locations.length)
          await anythingllmRequest(
            fetchImpl,
            baseUrl,
            `/api/v1/workspace/${encodeURIComponent(workspaceSlug)}/update-embeddings`,
            {
              method: "POST",
              apiKey,
              body: { adds: [], deletes: locations },
              signal,
            },
          );
        const remaining = await listWorkspaceDocuments(remote);
        if (
          !remaining ||
          remaining.some((doc) => (doc.docpath ?? doc.location ?? "").startsWith(prefix))
        )
          throw new Error("Derived documents remain in the workspace; retry cleanup");
        await anythingllmRequest(fetchImpl, baseUrl, "/api/v1/document/remove-folder", {
          method: "DELETE",
          apiKey,
          body: { name: vaultDocumentFolder(vaultId) },
          signal,
        });
        await rm(manifestDir, { recursive: true, force: true });
        return { vaultId, workspaceSlug, purged: true };
      } catch (error) {
        return { vaultId, workspaceSlug, purged: false, errors: [describe(error)] };
      }
    },
    { signal },
  );
}

async function anythingllmRequest(fetchImpl, baseUrl, apiPath, { method, apiKey, body, signal }) {
  const response = await fetchWithTimeout(fetchImpl, `${baseUrl.replace(/\/+$/, "")}${apiPath}`, {
    method,
    signal,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (response.status === 404 && method === "DELETE") return {};
  if (!response.ok) {
    const text = (await response.text().catch(() => "")).trim();
    throw new Error(`AnythingLLM API ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  const data = await response.json().catch(() => null);
  if (data?.success === false || data?.error)
    throw new Error(data.error || "Upstream cleanup failed");
  return data;
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
