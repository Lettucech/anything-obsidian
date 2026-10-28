import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createVaultRegistry } from "./vault-registry.mjs";
import {
  defaultUnifiedWorkspaceName,
  ensureUnifiedWorkspace,
  purgeVaultEmbeddings,
  vaultDocumentFolder,
} from "./unified-workspace.mjs";

test("the default unified workspace name is namespaced to the machine", () => {
  const first = defaultUnifiedWorkspaceName({ hostname: "MacBook-Pro.local" });
  const second = defaultUnifiedWorkspaceName({ hostname: "MacBook-Pro.local" });
  assert.match(first, /^any-obs-macbook-pro-local-[a-f0-9]{4}$/);
  assert.match(second, /^any-obs-macbook-pro-local-[a-f0-9]{4}$/);
  assert.notEqual(first, second);
  assert.match(defaultUnifiedWorkspaceName({ hostname: "" }), /^any-obs-host-/);
});

test("ensureUnifiedWorkspace creates once and then is idempotent", async () => {
  const { registry, anythingllm } = await setup();
  await registry.create(vault());

  const first = await ensureUnifiedWorkspace({ registry, anythingllm, stateRoot: "" });
  assert.equal(first.created, true);
  assert.equal(first.migrated, false);
  assert.match(first.workspace.slug, /^any-obs-/);

  const second = await ensureUnifiedWorkspace({ registry, anythingllm, stateRoot: "" });
  assert.deepEqual(second, { workspace: first.workspace, created: false, migrated: false });
  assert.equal(anythingllm.created.length, 1);
});

test("ensureUnifiedWorkspace attaches an existing workspace when asked", async () => {
  const { registry, anythingllm } = await setup();

  const result = await ensureUnifiedWorkspace({
    registry, anythingllm, stateRoot: "", attachSlug: "shared",
  });

  assert.equal(result.workspace.slug, "shared");
  assert.equal(anythingllm.created.length, 0);
  assert.deepEqual(await registry.getWorkspace(), { slug: "shared", name: "Shared KB" });
});

test("ensureUnifiedWorkspace rejects an attach for a workspace that does not exist", async () => {
  const { registry, anythingllm } = await setup();

  await assert.rejects(
    () => ensureUnifiedWorkspace({ registry, anythingllm, stateRoot: "", attachSlug: "missing" }),
    /Workspace was not found/,
  );
  assert.equal(await registry.getWorkspace(), null);
});

test("migrating a legacy per-vault registry drops slugs and wipes manifests", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "any-obs-unified-"));
  const stateRoot = path.join(root, "state");
  const registryPath = path.join(root, "registry", "vaults.json");
  await mkdir(path.dirname(registryPath), { recursive: true });
  await mkdir(path.join(stateRoot, "manifests", "work"), { recursive: true });
  await mkdir(path.join(stateRoot, "manifests", "personal"), { recursive: true });
  await writeFile(path.join(stateRoot, "manifests", "work", "embed-manifest.json"), '{"files":{"a.md":{"hash":"h","locations":["custom-documents/a.md"]}}}');
  await writeFile(registryPath, JSON.stringify({
    vaults: [
      { id: "work", name: "Work", directory: "work", workspaceSlug: "work", enabled: true, accessMode: "open", allowlist: [], gitAutoPull: true, gitAutoPush: true, gitUserName: "A", gitUserEmail: "a@b" },
      { id: "personal", name: "Personal", directory: "personal", workspaceSlug: "personal", enabled: true, accessMode: "open", allowlist: [], gitAutoPull: false, gitAutoPush: false, gitUserName: "A", gitUserEmail: "a@b" },
    ],
  }));

  const registry = createVaultRegistry({ rootPath: path.join(root, "vaults"), registryPath });
  const anythingllm = fakeAnythingllm();
  const result = await ensureUnifiedWorkspace({ registry, anythingllm, stateRoot });

  assert.equal(result.migrated, true);
  const vaults = await registry.list();
  assert.deepEqual(vaults.map((vault) => vault.workspaceSlug), [undefined, undefined]);
  // The wiped manifests force a full re-embed into the unified workspace.
  await assert.rejects(() => readFile(path.join(stateRoot, "manifests", "work", "embed-manifest.json")));
  assert.equal((await registry.getWorkspace()).slug, anythingllm.created[0].slug);
});

test("purgeVaultEmbeddings removes chunks, documents, and the manifest — best effort", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "any-obs-purge-"));
  const stateRoot = path.join(root, "state");
  const manifestDir = path.join(stateRoot, "manifests", "work");
  await mkdir(manifestDir, { recursive: true });
  await writeFile(path.join(manifestDir, "embed-manifest.json"), JSON.stringify({
    files: {
      "a.md": { hash: "h1", locations: ["custom-documents/work/a.md"] },
      "b.md": { hash: "h2", locations: ["custom-documents/work/b.md"] },
    },
  }));

  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method, body: init.body });
    if (url.endsWith("/api/v1/document/remove-folder") && init.body?.includes("fail-me")) {
      return { ok: false, status: 500, text: async () => "boom" };
    }
    return { ok: true, status: 200, text: async () => "{}" };
  };

  const result = await purgeVaultEmbeddings({
    baseUrl: "http://anythingllm:3001/",
    apiKey: "key",
    workspaceSlug: "any-obs-host-01",
    vaultId: "work",
    stateRoot,
    fetchImpl,
  });

  assert.equal(result.purged, true);
  assert.deepEqual(calls, [
    {
      url: "http://anythingllm:3001/api/v1/workspace/any-obs-host-01/update-embeddings",
      method: "POST",
      body: JSON.stringify({ adds: [], deletes: ["custom-documents/work/a.md", "custom-documents/work/b.md"] }),
    },
    {
      url: "http://anythingllm:3001/api/v1/document/remove-folder",
      method: "DELETE",
      body: JSON.stringify({ name: vaultDocumentFolder("work") }),
    },
  ]);
  await assert.rejects(() => readFile(path.join(manifestDir, "embed-manifest.json")));

  const failing = await purgeVaultEmbeddings({
    baseUrl: "http://anythingllm:3001",
    apiKey: "key",
    workspaceSlug: "any-obs-host-01",
    vaultId: "fail-me",
    stateRoot,
    fetchImpl,
  });
  assert.equal(failing.purged, false);
  assert.match(failing.errors.join("; "), /AnythingLLM API 500: boom/);
});

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "any-obs-unified-"));
  const registry = createVaultRegistry({
    rootPath: path.join(root, "vaults"),
    registryPath: path.join(root, "registry", "vaults.json"),
  });
  return { registry, anythingllm: fakeAnythingllm() };
}

function fakeAnythingllm() {
  return {
    created: [],
    async listWorkspaces() {
      return [{ slug: "shared", name: "Shared KB" }, ...this.created];
    },
    async createWorkspace({ name }) {
      const workspace = { slug: name, name };
      this.created.push(workspace);
      return workspace;
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
