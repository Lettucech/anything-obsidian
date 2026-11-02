import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createInstallationStore } from "./installation.mjs";
import { migrateLanAgents } from "./lan-migration.mjs";
import { createUserStore, hashToken } from "../server/iam.mjs";
import { createHash } from "node:crypto";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "any-obs-lan-migration-"));
  await mkdir(path.join(root, "agent-tokens"), { recursive: true });
  await mkdir(path.join(root, "gateway"), { recursive: true });
  await mkdir(path.join(root, "registry"), { recursive: true });
  const installation = createInstallationStore(root);
  await installation.update({ lan: true });
  return { root, installation };
}

test("lan agent tokens migrate by hash into server users and clear the flag", async (t) => {
  const f = await fixture(t);
  const token = "held-by-an-agent";
  await writeFile(
    path.join(f.root, "agent-tokens", "agents.json"),
    JSON.stringify({
      agents: [
        { name: "work-agent", tokenHash: hashToken(token), createdAt: "2026-10-01T00:00:00Z" },
        { name: "bad-record" },
      ],
    }),
  );
  await writeFile(
    path.join(f.root, "registry", "vaults.json"),
    JSON.stringify({ workspace: { slug: "any-obs-host-abc" }, vaults: [] }),
  );

  const report = await migrateLanAgents({ root: f.root, installation: f.installation, vaultRegistryPath: path.join(f.root, "registry", "vaults.json"), log: () => {} });

  assert.equal(report.migrated, true);
  assert.deepEqual(report.imported, ["work-agent"]);
  // The holder's existing token keeps working, verbatim hash. (verify reads
  // the store's cached snapshot, so prime it with a read first.)
  const users = createUserStore({ dataDir: path.join(f.root, "gateway") });
  await users.list();
  assert.deepEqual(users.verify(token), { kind: "user", name: "work-agent", role: "member" });
  // Granted read on the vault workspace that existed at migration time.
  const entitlements = await users.entitlements("work-agent");
  assert.deepEqual(entitlements.read, ["any-obs-host-abc"]);
  // The flag is cleared and the old store is left in place.
  assert.equal((await f.installation.load()).lan, false);
  await readFile(path.join(f.root, "agent-tokens", "agents.json"), "utf8");
  // Second run is a no-op.
  const again = await migrateLanAgents({ root: f.root, installation: f.installation, vaultRegistryPath: path.join(f.root, "registry", "vaults.json"), log: () => {} });
  assert.equal(again.migrated, false);
});

test("migration without a lan flag or agent store is a quiet no-op", async (t) => {
  const f = await fixture(t);
  await f.installation.update({ lan: false });
  const report = await migrateLanAgents({ root: f.root, installation: f.installation, vaultRegistryPath: path.join(f.root, "registry", "vaults.json"), log: () => {} });
  assert.equal(report.migrated, false);
});

test("name collisions are skipped, not overwritten", async (t) => {
  const f = await fixture(t);
  const users = createUserStore({ dataDir: path.join(f.root, "gateway") });
  const { token } = await users.create({ name: "work-agent", role: "admin" });
  await writeFile(
    path.join(f.root, "agent-tokens", "agents.json"),
    JSON.stringify({ agents: [{ name: "work-agent", tokenHash: createHash("sha256").update("other").digest("hex") }] }),
  );
  const report = await migrateLanAgents({ root: f.root, installation: f.installation, vaultRegistryPath: path.join(f.root, "registry", "vaults.json"), log: () => {} });
  assert.deepEqual(report.skipped, ["work-agent"]);
  // The pre-existing admin token still verifies; the agent's does not.
  assert.equal(users.verify(token).role, "admin");
  assert.equal(users.verify("other"), null);
});
