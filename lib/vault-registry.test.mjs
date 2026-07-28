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

test("registry updates a vault without allowing duplicate workspace mappings", async () => {
  const rootPath = await mkdirTemp("anything-obsidian-vaults-");
  await mkdir(path.join(rootPath, "work"));
  await mkdir(path.join(rootPath, "personal"));
  const registry = createVaultRegistry({ rootPath, registryPath: path.join(rootPath, "registry.json") });
  await registry.create(vault());
  await registry.create(vault({ id: "personal", directory: "personal", workspaceSlug: "personal" }));

  const updated = await registry.update("work", { name: "Office", enabled: false });
  assert.equal(updated.name, "Office");
  assert.equal(updated.enabled, false);
  await assert.rejects(() => registry.update("work", { workspaceSlug: "personal" }), /Workspace already exists/);
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
  const personal = await registry.create(vault({
    id: "personal", directory: "personal", workspaceSlug: "personal",
  }));

  assert.equal(work.gitAutoPull, false);
  assert.equal(work.gitAutoPush, false);
  assert.equal(work.gitUserEmail, "work@example.test");
  assert.equal(work.embedAfterSync, false);
  assert.equal(work.embedExtensions, ".md,.canvas");
  assert.equal(personal.gitAutoPull, true);
  assert.equal(personal.gitAutoPush, true);
  assert.equal(personal.embedExtensions, "");
});

function vault(overrides = {}) {
  return {
    id: "work",
    name: "Work",
    directory: "work",
    workspaceSlug: "work",
    gitRemote: "origin",
    gitBranch: "main",
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
