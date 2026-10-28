import assert from "node:assert/strict";
import test from "node:test";

import { decide } from "./proxy-rules.mjs";

const ADMIN = { kind: "admin" };
const USER = { kind: "user", name: "brian" };
const ENTITLEMENTS = {
  read: ["shared", "any-obs-brian-01"],
  write: ["any-obs-brian-01"],
};

function decideAs(identity, method, pathname, body, entitlements = ENTITLEMENTS) {
  return decide({ method, pathname, identity, body, entitlements });
}

test("anonymous callers are rejected everywhere", async () => {
  assert.deepEqual(await decideAs(null, "GET", "/api/v1/workspaces", undefined, { read: [], write: [] }), {
    action: "deny",
    status: 401,
    reason: "Bearer token required",
  });
});

test("workspace listing is gateway-filtered for users, proxied for admin", async () => {
  assert.deepEqual(await decideAs(USER, "GET", "/api/v1/workspaces"), { action: "workspaces-list" });
  assert.deepEqual(await decideAs(ADMIN, "GET", "/api/v1/workspaces"), { action: "proxy" });
});

test("workspace creation is ownership-minting for users", async () => {
  assert.deepEqual(await decideAs(USER, "POST", "/api/v1/workspace/new"), { action: "create-workspace" });
  assert.deepEqual(await decideAs(ADMIN, "POST", "/api/v1/workspace/new"), { action: "proxy" });
});

test("RAG reads require an entitled workspace slug", async () => {
  for (const slug of ["shared", "any-obs-brian-01"]) {
    for (const verb of ["vector-search", "chat"]) {
      assert.deepEqual(await decideAs(USER, "POST", `/api/v1/workspace/${slug}/${verb}`), { action: "proxy" });
    }
  }
  const denied = await decideAs(USER, "POST", "/api/v1/workspace/other-secret/vector-search");
  assert.equal(denied.action, "deny");
  assert.match(denied.reason, /not readable/);
});

test("update-embeddings requires write access; the shared workspace is never user-writable", async () => {
  assert.deepEqual(await decideAs(USER, "POST", "/api/v1/workspace/any-obs-brian-01/update-embeddings"), { action: "proxy" });
  const denied = await decideAs(USER, "POST", "/api/v1/workspace/shared/update-embeddings");
  assert.equal(denied.action, "deny");
  assert.match(denied.reason, /not writable/);
  assert.deepEqual(await decideAs(ADMIN, "POST", "/api/v1/workspace/shared/update-embeddings"), { action: "proxy" });
});

test("document writes only pass for vault pipeline folders", async () => {
  assert.deepEqual(await decideAs(USER, "POST", "/api/v1/document/upload/anything-obsidian-vault-work"), { action: "proxy" });
  assert.deepEqual(
    await decideAs(USER, "POST", "/api/v1/document/upload/anything-obsidian-vault-my-vault"),
    { action: "proxy" },
  );
  for (const folder of ["random", "anything-obsidian-vault", "anything-obsidian-vault-", "shared", "nested/folder"]) {
    const denied = await decideAs(USER, "POST", `/api/v1/document/upload/${encodeURIComponent(folder)}`);
    assert.equal(denied.action, "deny", folder);
    assert.match(denied.reason, /not a vault pipeline folder/);
  }
  assert.deepEqual(await decideAs(ADMIN, "POST", "/api/v1/document/upload/anything"), { action: "proxy" });
});

test("remove-folder checks the folder from the JSON body", async () => {
  assert.deepEqual(
    await decideAs(USER, "DELETE", "/api/v1/document/remove-folder", { name: "anything-obsidian-vault-work" }),
    { action: "proxy" },
  );
  const denied = await decideAs(USER, "DELETE", "/api/v1/document/remove-folder", { name: "evil" });
  assert.equal(denied.action, "deny");
});

test("anything else is admin passthrough and user denial", async () => {
  assert.deepEqual(await decideAs(ADMIN, "POST", "/api/v1/system/anything"), { action: "proxy" });
  assert.deepEqual(await decideAs(ADMIN, "DELETE", "/api/v1/document/abc"), { action: "proxy" });
  const denied = await decideAs(USER, "POST", "/api/v1/system/update-env");
  assert.equal(denied.action, "deny");
  assert.match(denied.reason, /User tokens cannot call this endpoint/);
  assert.equal((await decideAs(USER, "DELETE", "/api/v1/document/abc")).action, "deny");
});
