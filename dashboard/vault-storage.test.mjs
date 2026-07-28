import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createVaultRegistry } from "../lib/vault-registry.mjs";
import { createVaultStorage } from "./vault-storage.mjs";

test("creates a direct-child Git repository without accepting traversal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "anything-obsidian-vaults-"));
  const registry = createVaultRegistry({ rootPath: root, registryPath: path.join(root, "registry.json") });
  const commands = [];
  const storage = createVaultStorage({
    registry,
    runGit: async (args, cwd) => commands.push({ args, cwd }),
  });

  await storage.prepare({ id: "work", directory: "work", vaultMode: "create" });
  assert.deepEqual(commands, [{ args: ["init", "--initial-branch=main"], cwd: path.join(root, "work") }]);
  await assert.rejects(
    () => storage.prepare({ id: "outside", directory: "../outside", vaultMode: "create" }),
    /directory must be lowercase dash-separated/,
  );
});
