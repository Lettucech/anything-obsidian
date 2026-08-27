import assert from "node:assert/strict";
import test from "node:test";
import { hasBearerToken } from "./index.js";

test("accepts only an exact configured bearer token", () => {
  assert.equal(hasBearerToken("Bearer lan-secret", "lan-secret"), true);
  assert.equal(hasBearerToken(undefined, "lan-secret"), false);
  assert.equal(hasBearerToken("Bearer other-secret", "lan-secret"), false);
  assert.equal(hasBearerToken("Bearer lan-secret", ""), false);
});
