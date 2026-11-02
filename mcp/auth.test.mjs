import assert from "node:assert/strict";
import test from "node:test";
import { hasBearerToken, resolveIdentity } from "./agent-identity.mjs";

test("accepts only an exact configured bearer token", () => {
  assert.equal(hasBearerToken("Bearer admin-secret", "admin-secret"), true);
  assert.equal(hasBearerToken(undefined, "admin-secret"), false);
  assert.equal(hasBearerToken("Bearer other-secret", "admin-secret"), false);
  assert.equal(hasBearerToken("Bearer admin-secret", ""), false);
});

test("resolveIdentity knows admin (containers) and anonymous (loopback local) only", () => {
  // The LAN agent identities were retired with the 21504 listener; remote
  // identities are server users, resolved gateway-side.
  assert.deepEqual(resolveIdentity("Bearer admin-secret", { adminToken: "admin-secret" }), { kind: "admin" });
  assert.deepEqual(resolveIdentity("Bearer wrong-token", { adminToken: "admin-secret" }), { kind: "anonymous" });
  assert.deepEqual(resolveIdentity(undefined, { adminToken: "admin-secret" }), { kind: "anonymous" });
  assert.deepEqual(resolveIdentity("Bearer anything", { adminToken: "" }), { kind: "anonymous" });
});
