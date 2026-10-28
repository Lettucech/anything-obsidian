import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createVaultRegistry } from "./vault-registry.mjs";

test("registry rejects vault paths outside the configured root", async () => {
  const rootPath = await mkdirTemp("anything-obsidian-vaults-");
  const registry = createVaultRegistry({
    rootPath,
    registryPath: path.join(rootPath, "registry.json"),
  });

  await assert.rejects(
    () => registry.create(vault({ directory: "../outside" })),
    /vault root/,
  );
});

test("registry accepts an imported vault that lives outside the root", async () => {
  const rootPath = await mkdirTemp("anything-obsidian-vaults-");
  const imported = await mkdirTemp("anything-obsidian-imported-");
  const registry = createVaultRegistry({ rootPath, registryPath: path.join(rootPath, "registry.json") });

  const created = await registry.create(vault({
    id: "my-vault",
    directory: "my-vault",
    location: "imported",
    importPath: imported,
  }));

  assert.equal(created.location, "imported");
  assert.equal(created.importPath, imported);
  assert.equal(registry.resolvePath(created), imported);
  assert.equal((await registry.list())[0].importPath, imported);
  // A user's own directory is never auto-synced unless they ask for it.
  assert.equal(created.gitAutoPull, false);
  assert.equal(created.gitAutoPush, false);
});

test("registry derives a slug directory name for an imported vault", async () => {
  const rootPath = await mkdirTemp("anything-obsidian-vaults-");
  const imported = await mkdirTemp("My Notes_2026-");
  const registry = createVaultRegistry({ rootPath, registryPath: path.join(rootPath, "registry.json") });

  const created = await registry.create(vault({
    id: "notes", location: "imported", importPath: imported, directory: undefined,
  }));

  assert.match(created.directory, /^my-notes-2026-[a-z0-9-]+$/);
});

test("registry rejects relative import paths and the vault root itself", async () => {
  const rootPath = await mkdirTemp("anything-obsidian-vaults-");
  const imported = await mkdirTemp("anything-obsidian-imported-");
  const registry = createVaultRegistry({ rootPath, registryPath: path.join(rootPath, "registry.json") });

  await assert.rejects(
    () => registry.create(vault({ id: "rel", directory: "rel", location: "imported", importPath: "../outside" })),
    /absolute path/,
  );
  await assert.rejects(
    () => registry.create(vault({ id: "root", directory: "root", location: "imported", importPath: rootPath })),
    /not the vault root itself/,
  );
  assert.equal((await registry.list()).length, 0);
});

test("removing a vault preserves its local repository directory", async () => {
  const rootPath = await mkdirTemp("anything-obsidian-vaults-");
  await mkdir(path.join(rootPath, "work"));
  const registry = createVaultRegistry({
    rootPath,
    registryPath: path.join(rootPath, "registry.json"),
  });

  await registry.create(vault());
  await registry.remove("work");

  await access(path.join(rootPath, "work"));
  assert.equal((await registry.list()).length, 0);
});

test("registry updates a vault and keeps the unified workspace separate", async () => {
  const rootPath = await mkdirTemp("anything-obsidian-vaults-");
  await mkdir(path.join(rootPath, "work"));
  await mkdir(path.join(rootPath, "personal"));
  const registry = createVaultRegistry({ rootPath, registryPath: path.join(rootPath, "registry.json") });
  await registry.create(vault());
  await registry.create(vault({ id: "personal", directory: "personal" }));

  const updated = await registry.update("work", { name: "Office", enabled: false });
  assert.equal(updated.name, "Office");
  assert.equal(updated.enabled, false);
  assert.equal(updated.workspaceSlug, undefined);
  await assert.rejects(() => registry.update("work", { directory: "personal" }), /Vault directory already exists/);

  assert.equal(await registry.getWorkspace(), null);
  const workspace = await registry.setWorkspace({ slug: "any-obs-host-01", name: "Anything Obsidian" });
  assert.deepEqual(workspace, { slug: "any-obs-host-01", name: "Anything Obsidian" });
  assert.deepEqual(await registry.getWorkspace(), workspace);
  await assert.rejects(() => registry.setWorkspace({ slug: "" }), /workspace slug/);
  // A workspace survives vault churn — it is instance state, not vault state.
  await registry.remove("work");
  assert.deepEqual(await registry.getWorkspace(), workspace);
});

test("registry keeps Git and embedding policy separately for each vault", async () => {
  const rootPath = await mkdirTemp("anything-obsidian-vaults-");
  const registry = createVaultRegistry({ rootPath, registryPath: path.join(rootPath, "registry.json") });
  const work = await registry.create(vault({
    gitAutoPull: false,
    gitAutoPush: false,
    gitUserName: "Work Bot",
    gitUserEmail: "work@example.test",
    gitPushUrl: "https://example.test/work.git",
    gitCommitMessagePrefix: "Sync work",
    embedAfterSync: false,
    embedExtensions: ".md,.canvas",
    embedExcludeDirs: ".git,.private",
  }));
  const personal = await registry.create(vault({ id: "personal", directory: "personal" }));

  assert.equal(work.gitAutoPull, false);
  assert.equal(work.gitAutoPush, false);
  assert.equal(work.gitUserEmail, "work@example.test");
  assert.equal(work.embedAfterSync, false);
  assert.equal(work.embedExtensions, ".md,.canvas");
  assert.equal(personal.gitAutoPull, true);
  assert.equal(personal.gitAutoPush, true);
  assert.equal(personal.embedExtensions, "");
});

test("registry requires an explicit Git author for automatic commits", async () => {
  const rootPath = await mkdirTemp("anything-obsidian-vaults-");
  const registry = createVaultRegistry({ rootPath, registryPath: path.join(rootPath, "registry.json") });

  await assert.rejects(() => registry.create(vault({ gitUserName: "" })), /gitUserName is required/);
  await assert.rejects(() => registry.create(vault({ gitUserEmail: "  " })), /gitUserEmail is required/);
});

function vault(overrides = {}) {
  return {
    id: "work",
    name: "Work",
    directory: "work",
    repositoryUrl: "https://github.com/acme/work.git",
    gitRemote: "origin",
    gitBranch: "main",
    gitUserName: "Work Bot",
    gitUserEmail: "work@example.test",
    syncIntervalSeconds: 300,
    enabled: true,
    accessMode: "open",
    allowlist: [],
    ...overrides,
  };
}

async function mkdirTemp(prefix) {
  const rootPath = path.join(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(rootPath, { recursive: true });
  return rootPath;
}
