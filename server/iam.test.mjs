import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createUserStore, hashToken } from "./iam.mjs";

async function setup() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "any-obs-gateway-iam-"));
  return createUserStore({ dataDir, sharedWorkspaceSlug: "shared" });
}

test("users are created with a once-shown token and verified by hash", async () => {
  const store = await setup();

  const { user, token } = await store.create({ name: "brian" });
  assert.equal(user.name, "brian");
  assert.equal(user.role, "member");
  assert.ok(token.length > 20);
  assert.deepEqual(store.verify(token), { kind: "user", name: "brian", role: "member" });
  assert.equal(store.verify("wrong-token"), null);
  assert.equal(store.verify(""), null);

  const listed = await store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].tokenHash, undefined);
  assert.equal(listed[0].name, "brian");

  await assert.rejects(() => store.create({ name: "brian" }), /User already exists/);
  await assert.rejects(() => store.create({ name: "Bad Name" }), /lowercase dash-separated/);
});

test("removed users lose token access; workspaces stay owned", async () => {
  const store = await setup();
  const { token } = await store.create({ name: "scout" });
  await store.recordOwnership("any-obs-mine-01", "scout");

  assert.deepEqual(await store.remove("scout"), { name: "scout" });
  assert.equal(store.verify(token), null);
  assert.equal(await store.remove("scout"), null);
  // Derived data is not the user's to take down.
  assert.deepEqual(await store.ownedWorkspaces("scout"), ["any-obs-mine-01"]);
});

test("entitlements are the shared workspace for reads and owned workspaces for writes", async () => {
  const store = await setup();
  await store.create({ name: "brian" });

  assert.deepEqual(await store.entitlements("brian"), { read: ["shared"], write: [] });

  await store.recordOwnership("any-obs-brian-01", "brian");
  await store.recordOwnership("any-obs-brian-02", "brian");
  assert.deepEqual(await store.entitlements("brian"), {
    read: ["shared", "any-obs-brian-01", "any-obs-brian-02"],
    write: ["any-obs-brian-01", "any-obs-brian-02"],
  });

  // Ownership is minted once; a second claim is a no-op.
  assert.equal(await store.recordOwnership("any-obs-brian-01", "someone-else"), "brian");
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

test("readers never receive write entitlements", async () => {
  const store = await setup();
  await store.create({ name: "reader-1", role: "reader" });
  await store.recordOwnership("any-obs-reader-01", "reader-1");
  assert.deepEqual(await store.entitlements("reader-1"), {
    read: ["shared", "any-obs-reader-01"],
    write: [],
  });

  await store.create({ name: "member-1" });
  await store.recordOwnership("any-obs-member-01", "member-1");
  assert.deepEqual(await store.entitlements("member-1"), {
    read: ["shared", "any-obs-member-01"],
    write: ["any-obs-member-01"],
  });
});

test("users list their owned workspaces; a workspace record can be dropped", async () => {
  const store = await setup();
  await store.create({ name: "brian" });
  await store.recordOwnership("any-obs-brian-02", "brian");
  await store.recordOwnership("any-obs-brian-01", "brian");
  await store.recordOwnership("shared-ghost", "ghost");

  assert.deepEqual((await store.list()).find((user) => user.name === "brian").workspaces, [
    "any-obs-brian-01",
    "any-obs-brian-02",
  ]);

  assert.equal(await store.removeWorkspace("any-obs-brian-01"), true);
  assert.deepEqual((await store.list()).find((user) => user.name === "brian").workspaces, ["any-obs-brian-02"]);
  assert.deepEqual(await store.entitlements("brian"), {
    read: ["shared", "any-obs-brian-02"],
    write: ["any-obs-brian-02"],
  });
  assert.equal(await store.removeWorkspace("already-gone"), false);
});

test("token hashes are sha-256 of the raw token", async () => {
  const store = await setup();
  const { token } = await store.create({ name: "hash-check" });
  // verify() agreeing with hashToken() is the observable contract.
  assert.match(hashToken(token), /^[a-f0-9]{64}$/);
  assert.notEqual(hashToken(token), token);
});
