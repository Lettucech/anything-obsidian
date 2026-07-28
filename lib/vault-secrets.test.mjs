import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createVaultSecretStore } from "./vault-secrets.mjs";

test("stores a per-vault HTTPS credential without exposing it through metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "anything-obsidian-secrets-"));
  const secrets = createVaultSecretStore({ rootPath: root });

  assert.deepEqual(await secrets.save("work", { mode: "https-token", username: "oauth2", token: "work-secret" }), { configured: true });
  assert.deepEqual(await secrets.get("work"), { version: 1, username: "oauth2", token: "work-secret" });
  assert.equal((await stat(path.join(root, "work.json"))).mode & 0o777, 0o600);
  assert.deepEqual(await secrets.save("personal", { mode: "none" }), { configured: false });
  assert.equal(await secrets.get("personal"), null);
});
