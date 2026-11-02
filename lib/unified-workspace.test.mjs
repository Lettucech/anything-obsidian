import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createVaultRegistry } from "./vault-registry.mjs";
import {
  ensureVaultWorkspace,
  migrateToPerVaultWorkspaces,
  purgeVaultEmbeddings,
  vaultDocumentFolder,
  vaultWorkspaceName,
} from "./unified-workspace.mjs";

test("the per-vault workspace name is deterministic and namespaced to the machine", () => {
  assert.equal(
    vaultWorkspaceName("work", { hostname: "MacBook-Pro.local" }),
    "any-obs-macbook-pro-local-work",
  );
  assert.equal(vaultWorkspaceName("work", { hostname: "" }), "any-obs-host-work");
  assert.notEqual(
    vaultWorkspaceName("work", { hostname: "a" }),
    vaultWorkspaceName("personal", { hostname: "a" }),
  );
});

test("ensureVaultWorkspace creates once, reuses the recorded slug, and replaces a stale one", async () => {
  const { registry, anythingllm } = await setup();
  await registry.create(vault());

  const first = await ensureVaultWorkspace({ vaultId: "work", registry, anythingllm });
  assert.equal(first.created, true);
  assert.match(first.workspaceSlug, /^any-obs-.*-work$/);
  assert.equal(anythingllm.created.length, 1);

  // Idempotent: the recorded slug still resolves upstream.
  const second = await ensureVaultWorkspace({ vaultId: "work", registry, anythingllm });
  assert.deepEqual(second, { workspaceSlug: first.workspaceSlug, created: false });
  assert.equal(anythingllm.created.length, 1);

  // A recorded slug deleted by hand upstream is replaced, never trusted:
  // the deterministic name no longer resolves, so a fresh workspace with
  // that name is created.
  anythingllm.deleted.add(first.workspaceSlug);
  const third = await ensureVaultWorkspace({ vaultId: "work", registry, anythingllm });
  assert.equal(third.created, true);
  assert.equal(third.workspaceSlug, first.workspaceSlug);
  assert.equal(anythingllm.created.length, 2);
});

test("migrateToPerVaultWorkspaces moves a unified install onto per-vault workspaces", async () => {
  const { root, registry, anythingllm, stateRoot } = await setupWithUnified();
  await mkdir(path.join(stateRoot, "manifests", "work"), { recursive: true });
  await writeFile(
    path.join(stateRoot, "manifests", "work", "embed-manifest.json"),
    '{"files":{"a.md":{"hash":"h","locations":["x"]}}}',
  );

  const result = await migrateToPerVaultWorkspaces({ registry, anythingllm, stateRoot, hostname: "" });

  assert.equal(result.migrated, true);
  assert.deepEqual(result.vaults, ["any-obs-host-work", "any-obs-host-personal"]);
  assert.equal(result.unifiedDeleted, true);
  assert.equal(await registry.getWorkspace(), null);
  const vaults = await registry.list();
  assert.deepEqual(
    vaults.map((vault) => vault.workspaceSlug),
    ["any-obs-host-work", "any-obs-host-personal"],
  );
  // Wiped manifests force a full re-embed into each vault's own workspace.
  await assert.rejects(() =>
    readFile(path.join(stateRoot, "manifests", "work", "embed-manifest.json")),
  );
  // Idempotent: nothing left to migrate.
  const again = await migrateToPerVaultWorkspaces({ registry, anythingllm, stateRoot });
  assert.equal(again.migrated, false);
});

test("migration survives a unified workspace that cannot be deleted", async () => {
  const { registry, anythingllm, stateRoot } = await setupWithUnified();
  anythingllm.failDelete = true;
  const logs = [];
  const result = await migrateToPerVaultWorkspaces({
    registry,
    anythingllm,
    stateRoot,
    log: (line) => logs.push(line),
  });
  assert.equal(result.migrated, true);
  assert.equal(result.unifiedDeleted, false);
  assert.equal(await registry.getWorkspace(), null);
  assert.ok(logs.some((line) => line.includes("was not deleted")));
});

test("purge verifies remote cleanup, preserves sibling documents and source files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "any-obs-purge-"));
  const manifestDir = path.join(root, "manifests", "work");
  await mkdir(manifestDir, { recursive: true });
  await writeFile(path.join(manifestDir, "embed-manifest.json"), JSON.stringify({ files: {} }));
  await writeFile(path.join(root, "note.md"), "source");
  const remote = new Set([
    `${vaultDocumentFolder("work")}/a.json`,
    `${vaultDocumentFolder("other")}/b.json`,
  ]);
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith("/documents"))
      return new Response(
        JSON.stringify({ documents: [...remote].map((docpath) => ({ docpath })) }),
      );
    if (url.endsWith("/update-embeddings"))
      JSON.parse(init.body).deletes.forEach((location) => remote.delete(location));
    return new Response("{}");
  };
  try {
    const result = await purgeVaultEmbeddings({
      baseUrl: "http://upstream.test",
      apiKey: "fake",
      workspaceSlug: "any-obs-host-work",
      vaultId: "work",
      stateRoot: root,
      fetchImpl,
    });
    assert.equal(result.purged, true);
    assert.deepEqual([...remote], [`${vaultDocumentFolder("other")}/b.json`]);
    await assert.rejects(readFile(path.join(manifestDir, "embed-manifest.json")), {
      code: "ENOENT",
    });
    assert.equal(await readFile(path.join(root, "note.md"), "utf8"), "source");
    assert.equal(calls.filter((call) => call.init.method === "DELETE").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed cleanup keeps the manifest for a later retry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "any-obs-purge-fail-"));
  const manifestDir = path.join(root, "manifests", "work");
  await mkdir(manifestDir, { recursive: true });
  await writeFile(path.join(manifestDir, "embed-manifest.json"), "retained");
  try {
    const result = await purgeVaultEmbeddings({
      baseUrl: "http://upstream.test",
      apiKey: "fake",
      workspaceSlug: "any-obs-host-work",
      vaultId: "work",
      stateRoot: root,
      fetchImpl: async () => new Response("offline", { status: 503 }),
    });
    assert.equal(result.purged, false);
    assert.equal(await readFile(path.join(manifestDir, "embed-manifest.json"), "utf8"), "retained");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "any-obs-pervault-"));
  const registryPath = path.join(root, "registry", "vaults.json");
  const registry = createVaultRegistry({ rootPath: path.join(root, "vaults"), registryPath });
  return { root, registry, anythingllm: fakeAnythingllm(), stateRoot: path.join(root, "state") };
}

// A pre-upgrade unified install: registry-level workspace, vault records
// without their own slugs.
async function setupWithUnified() {
  const base = await setup();
  await base.registry.create(vault());
  await base.registry.create(vault({ id: "personal", name: "Personal", directory: "personal" }));
  await base.registry.setWorkspace({ slug: "any-obs-host-old1", name: "Unified" });
  return base;
}

function fakeAnythingllm() {
  return {
    created: [],
    deleted: new Set(),
    failDelete: false,
    async listWorkspaces() {
      return [{ slug: "shared", name: "Shared KB" }, ...this.created].filter(
        (workspace) => !this.deleted.has(workspace.slug),
      );
    },
    async createWorkspace({ name }) {
      const workspace = { slug: name, name };
      this.created.push(workspace);
      return workspace;
    },
    async deleteWorkspace({ slug }) {
      if (this.failDelete) throw new Error("AnythingLLM API 500");
      this.deleted.add(slug);
    },
  };
}

function vault(overrides = {}) {
  return {
    id: "work",
    name: "Work",
    directory: "work",
    gitUserName: "A",
    gitUserEmail: "a@b",
    ...overrides,
  };
}
