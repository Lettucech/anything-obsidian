import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadVaults, resolveVault, visibleVaults, type CallerIdentity, type VaultRecord } from "./vault-registry.js";

const vaults: VaultRecord[] = [
  { id: "work", name: "Work", directory: "work", workspaceSlug: "work", enabled: true, accessMode: "open", allowlist: [] },
  { id: "personal", name: "Personal", directory: "personal", workspaceSlug: "personal", enabled: true, accessMode: "open", allowlist: [] },
];

const anonymous: CallerIdentity = { kind: "anonymous" };
const admin: CallerIdentity = { kind: "admin" };
const workAgent: CallerIdentity = { kind: "agent", name: "work-agent" };
const otherAgent: CallerIdentity = { kind: "agent", name: "other-agent" };

function restrictedVault(allowlist: string[]): VaultRecord {
  return { id: "secret", name: "Secret", directory: "secret", workspaceSlug: "secret", enabled: true, accessMode: "restricted", allowlist };
}

test("requires a selector when multiple vaults are accessible", () => {
  assert.throws(() => resolveVault(vaults), /vaultId is required/);
  assert.equal(resolveVault(vaults, "work").workspaceSlug, "work");
});

test("open vaults stay accessible to every identity", () => {
  for (const identity of [anonymous, admin, workAgent]) {
    assert.equal(resolveVault(vaults, "work", identity).id, "work");
  }
});

test("restricted vaults are accessible to allowlisted agents and admin only", () => {
  const vault = restrictedVault(["work-agent"]);
  assert.equal(resolveVault([vault], "secret", workAgent).id, "secret");
  assert.equal(resolveVault([vault], "secret", admin).id, "secret");
  assert.throws(() => resolveVault([vault], "secret", anonymous), /restricted and this caller has no access/);
  assert.throws(() => resolveVault([vault], "secret", otherAgent), /restricted and this caller has no access/);
});

test("visibleVaults filters by identity", () => {
  const all = [
    ...vaults,
    restrictedVault(["work-agent"]),
    { ...restrictedVault([]), id: "other-secret", name: "Other", directory: "other-secret", workspaceSlug: "other-secret" },
  ];
  assert.deepEqual(visibleVaults(all, anonymous).map((vault) => vault.id), ["work", "personal"]);
  assert.deepEqual(visibleVaults(all, workAgent).map((vault) => vault.id), ["work", "personal", "secret"]);
  assert.deepEqual(visibleVaults(all, admin).map((vault) => vault.id), ["work", "personal", "secret", "other-secret"]);
});

test("disabled vaults are never visible", () => {
  const disabled = { ...vaults[0], enabled: false };
  assert.deepEqual(visibleVaults([disabled], admin), []);
  assert.throws(() => resolveVault([disabled], "work", admin), /Unknown or disabled vault/);
});

test("rejects registry records with invalid context metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "anything-obsidian-vault-registry-"));
  const registryPath = path.join(root, "vaults.json");
  await writeFile(registryPath, JSON.stringify({
    vaults: [{ ...vaults[0], gitAutoPush: "yes" }],
  }));

  assert.deepEqual(await loadVaults(registryPath), []);
});
