import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { agentsPath, createAgentTokenStore } from "./agent-tokens.mjs";

test("creates named agents and stores only the token hash", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "anything-obsidian-agent-tokens-"));
  const tokens = randomTokenFactory();
  const store = createAgentTokenStore({ rootPath: root, randomToken: tokens.next });

  const created = await store.create("work-agent");
  assert.deepEqual(created.agent, {
    name: "work-agent",
    tokenHash: createHash("sha256").update(created.token, "utf8").digest("hex"),
    createdAt: created.agent.createdAt,
  });
  assert.ok(created.token.length > 0);
  assert.notEqual(created.token, created.agent.tokenHash);

  const stored = JSON.parse(await readFile(agentsPath(root), "utf8"));
  assert.equal(stored.agents.length, 1);
  assert.ok(!JSON.stringify(stored).includes(created.token), "plaintext token must not be stored");
  assert.equal((await stat(agentsPath(root))).mode & 0o777, 0o600);

  assert.deepEqual(await store.list(), [created.agent]);
});

test("rejects duplicate or invalid agent names", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "anything-obsidian-agent-tokens-"));
  const store = createAgentTokenStore({ rootPath: root, randomToken: () => "fixed-token" });

  await store.create("work-agent");
  await assert.rejects(() => store.create("work-agent"), /Agent already exists/);
  await assert.rejects(() => store.create("Bad Name"), /lowercase dash-separated/);
  await assert.rejects(() => store.create(""), /lowercase dash-separated/);
});

test("removes an agent and reports unknown names", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "anything-obsidian-agent-tokens-"));
  const store = createAgentTokenStore({ rootPath: root, randomToken: () => "fixed-token" });

  await store.create("work-agent");
  assert.equal(await store.remove("work-agent"), true);
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.remove("work-agent"), false);
});

function randomTokenFactory() {
  let counter = 0;
  return {
    next: () => `test-token-${++counter}`,
  };
}
