import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadVaults, resolveVault, type VaultRecord } from "./vault-registry.js";

const vaults: VaultRecord[] = [
  { id: "work", name: "Work", directory: "work", workspaceSlug: "work", enabled: true, accessMode: "open", allowlist: [] },
  { id: "personal", name: "Personal", directory: "personal", workspaceSlug: "personal", enabled: true, accessMode: "open", allowlist: [] },
];

test("requires a selector when multiple vaults are accessible", () => {
  assert.throws(() => resolveVault(vaults), /vaultId is required/);
  assert.equal(resolveVault(vaults, "work").workspaceSlug, "work");
});

test("reports restricted vaults as not yet enforced", () => {
  assert.throws(
    () => resolveVault([{ ...vaults[0], accessMode: "restricted" }], "work"),
    /identity enforcement is not available yet/,
  );
});

test("rejects registry records with invalid context metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "anything-obsidian-vault-registry-"));
  const registryPath = path.join(root, "vaults.json");
  await writeFile(registryPath, JSON.stringify({
    vaults: [{ ...vaults[0], gitAutoPush: "yes" }],
  }));

  assert.deepEqual(await loadVaults(registryPath), []);
});
