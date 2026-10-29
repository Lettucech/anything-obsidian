import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createUserStore, hashToken } from "./iam.mjs";

async function setup() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "any-obs-gateway-iam-"));
  return createUserStore({ dataDir });
}

test("users are created with a role and a once-shown token, verified by hash", async () => {
  const store = await setup();

  const { user, token } = await store.create({ name: "brian", role: "admin" });
  assert.equal(user.name, "brian");
  assert.equal(user.role, "admin");
  assert.ok(token.length > 20);
  assert.deepEqual(store.verify(token), { kind: "user", name: "brian", role: "admin" });
  assert.equal(store.verify("wrong-token"), null);
  assert.equal(store.verify(""), null);

  const listed = await store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].tokenHash, undefined);
  assert.equal(listed[0].name, "brian");

  await assert.rejects(() => store.create({ name: "brian" }), /User already exists/);
  await assert.rejects(() => store.create({ name: "Bad Name" }), /lowercase dash-separated/);
});

test("users carry a role that can change after creation", async () => {
  const store = await setup();
  const { user, token } = await store.create({ name: "brian", role: "admin" });
  assert.equal(user.role, "admin");
  assert.deepEqual(store.verify(token), { kind: "user", name: "brian", role: "admin" });

  await assert.rejects(() => store.create({ name: "x", role: "wizard" }), /Role must be one of/);
  assert.equal((await store.create({ name: "plain" })).user.role, "member");

  const updated = await store.updateRole("brian", "reader");
  assert.deepEqual(updated, { name: "brian", role: "reader", createdAt: user.createdAt });
  assert.deepEqual(store.verify(token), { kind: "user", name: "brian", role: "reader" });
  assert.equal(await store.updateRole("ghost", "admin"), null);
  await assert.rejects(() => store.updateRole("brian", "nope"), /Role must be one of/);
});

test("resetting a token invalidates the old one immediately", async () => {
  const store = await setup();
  const { token } = await store.create({ name: "scout" });

  const reset = await store.resetToken("scout");
  assert.notEqual(reset.token, token);
  assert.ok(reset.token.length > 20);
  assert.equal(store.verify(token), null);
  assert.deepEqual(store.verify(reset.token), { kind: "user", name: "scout", role: "member" });
  assert.equal(await store.resetToken("ghost"), null);
});

test("nothing is pre-created: entitlements come only from owned and granted workspaces", async () => {
  const store = await setup();
  await store.create({ name: "brian" });

  // A fresh user can read nothing at all.
  assert.deepEqual(await store.entitlements("brian"), { read: [], write: [] });

  await store.recordOwnership("any-obs-brian-01", "brian");
  await store.recordWorkspace("space-a", { kind: "shared" });
  await store.grantWorkspaceAccess("space-a", "brian");

  assert.deepEqual(await store.entitlements("brian"), {
    read: ["any-obs-brian-01", "space-a"],
    write: ["any-obs-brian-01"],
  });

  // Revoking the grant takes the read away; the personal write stays.
  assert.deepEqual(await store.revokeWorkspaceAccess("space-a", "brian"), []);
  assert.deepEqual(await store.entitlements("brian"), {
    read: ["any-obs-brian-01"],
    write: ["any-obs-brian-01"],
  });
});

test("workspace records: kinds, grants validation, listing, removal", async () => {
  const store = await setup();
  await store.create({ name: "brian" });
  await store.recordWorkspace("space-a", { kind: "shared" });
  await store.recordWorkspace("space-b", { kind: "shared" });
  await store.recordWorkspace("any-obs-brian-01", { kind: "personal", owner: "brian" });

  await assert.rejects(() => store.grantWorkspaceAccess("space-a", "ghost"), /Unknown user/);
  await assert.rejects(() => store.grantWorkspaceAccess("any-obs-brian-01", "brian"), /Not a shared workspace/);
  assert.deepEqual(await store.grantWorkspaceAccess("space-a", "brian"), ["brian"]);
  // Recording again is a no-op, never an overwrite.
  await store.recordWorkspace("space-a", { kind: "personal", owner: "ghost" });
  assert.deepEqual(await store.workspaceRecord("space-a"), { kind: "shared", grants: ["brian"] });

  assert.deepEqual(await store.workspaces(), [
    { slug: "space-a", kind: "shared", grants: ["brian"] },
    { slug: "space-b", kind: "shared", grants: [] },
    { slug: "any-obs-brian-01", kind: "personal", owner: "brian" },
  ]);

  assert.equal(await store.removeWorkspace("space-b"), true);
  assert.equal(await store.removeWorkspace("space-b"), false);
});

test("a legacy volume (plain owner strings) loads as personal workspaces", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "any-obs-gateway-iam-legacy-"));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(dataDir, "users.json"), JSON.stringify({
    users: [{ name: "brian", tokenHash: hashToken("t"), role: "member" }],
    workspaces: { "any-obs-brian-01": "brian" },
  }));
  const store = createUserStore({ dataDir });
  assert.deepEqual(await store.workspaces(), [
    { slug: "any-obs-brian-01", kind: "personal", owner: "brian" },
  ]);
  assert.deepEqual(await store.entitlements("brian"), {
    read: ["any-obs-brian-01"],
    write: ["any-obs-brian-01"],
  });
});

test("readers never receive write entitlements", async () => {
  const store = await setup();
  await store.create({ name: "reader-1", role: "reader" });
  await store.recordOwnership("any-obs-reader-01", "reader-1");
  assert.deepEqual(await store.entitlements("reader-1"), {
    read: ["any-obs-reader-01"],
    write: [],
  });
});

test("removed users lose token access; workspace records stay", async () => {
  const store = await setup();
  const { token } = await store.create({ name: "scout" });
  await store.recordOwnership("any-obs-mine-01", "scout");

  assert.deepEqual(await store.remove("scout"), { name: "scout" });
  assert.equal(store.verify(token), null);
  assert.equal(await store.remove("scout"), null);
  assert.deepEqual(await store.workspaces(), [
    { slug: "any-obs-mine-01", kind: "personal", owner: "scout" },
  ]);
});

test("token hashes are sha-256 of the raw token", async () => {
  const store = await setup();
  const { token } = await store.create({ name: "hash-check" });
  assert.match(hashToken(token), /^[a-f0-9]{64}$/);
  assert.notEqual(hashToken(token), token);
});
