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
