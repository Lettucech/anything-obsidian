import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { hasBearerToken, loadAgentIdentities, resolveIdentity } from "./agent-identity.js";

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

test("accepts only an exact configured bearer token", () => {
  assert.equal(hasBearerToken("Bearer lan-secret", "lan-secret"), true);
  assert.equal(hasBearerToken(undefined, "lan-secret"), false);
  assert.equal(hasBearerToken("Bearer other-secret", "lan-secret"), false);
  assert.equal(hasBearerToken("Bearer lan-secret", ""), false);
});

test("loadAgentIdentities tolerates a missing or malformed file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "anything-obsidian-agent-identity-"));
  assert.deepEqual(await loadAgentIdentities(path.join(root, "missing.json")), []);

  const malformed = path.join(root, "malformed.json");
  await writeFile(malformed, JSON.stringify({ agents: [{ name: "x" }, { name: "ok", tokenHash: "ab".repeat(32) }, "junk"] }));
  assert.deepEqual(await loadAgentIdentities(malformed), [{ name: "ok", tokenHash: "ab".repeat(32) }]);
});

test("resolveIdentity matches admin, allowlisted agents, or anonymous", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "anything-obsidian-agent-identity-"));
  const agentsPath = path.join(root, "agents.json");
  await writeFile(agentsPath, JSON.stringify({
    agents: [
      { name: "work-agent", tokenHash: tokenHash("agent-token-1") },
      { name: "research-agent", tokenHash: tokenHash("agent-token-2") },
    ],
  }));
  const agents = await loadAgentIdentities(agentsPath);

  assert.deepEqual(resolveIdentity("Bearer admin-secret", { adminToken: "admin-secret", agents }), { kind: "admin" });
  assert.deepEqual(resolveIdentity("Bearer agent-token-2", { adminToken: "admin-secret", agents }), { kind: "agent", name: "research-agent" });
  assert.deepEqual(resolveIdentity("Bearer wrong-token", { adminToken: "admin-secret", agents }), { kind: "anonymous" });
  assert.deepEqual(resolveIdentity(undefined, { adminToken: "admin-secret", agents }), { kind: "anonymous" });
  assert.deepEqual(resolveIdentity("Bearer agent-token-1", { adminToken: "", agents }), { kind: "agent", name: "work-agent" });
  assert.deepEqual(resolveIdentity("Bearer agent-token-1", { adminToken: "", agents: [] }), { kind: "anonymous" });
});
