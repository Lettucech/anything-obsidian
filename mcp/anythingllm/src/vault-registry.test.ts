import assert from "node:assert/strict";
import test from "node:test";
import { resolveVault, type VaultRecord } from "./vault-registry.js";

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
