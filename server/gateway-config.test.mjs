import assert from "node:assert/strict";
import { chmod, mkdtemp } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createGatewayConfig } from "./gateway-config.mjs";

test("gateway config persists only the api key, 0600, in the data dir", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "any-obs-gateway-config-"));
  const config = createGatewayConfig({ dataDir });

  assert.deepEqual(await config.load(), { apiKey: "" });
  assert.equal(await config.configured(), false);

  await config.save({ apiKey: "key-1" });
  assert.deepEqual(await config.load(), { apiKey: "key-1" });
  assert.equal(await config.configured(), true);

  const state = await stat(path.join(dataDir, "gateway.json"));
  assert.equal(state.mode & 0o777, 0o600);
});

test("chmod 0600 is enforced even when the file pre-exists with looser mode", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "any-obs-gateway-config-"));
  const config = createGatewayConfig({ dataDir });
  await config.save({ apiKey: "a" });
  await chmod(path.join(dataDir, "gateway.json"), 0o644);
  await config.save({ apiKey: "b" });
  const state = await stat(path.join(dataDir, "gateway.json"));
  assert.equal(state.mode & 0o777, 0o600);
});

test("a legacy data volume with an adminToken field loads cleanly without it", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "any-obs-gateway-config-"));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(dataDir, "gateway.json"), JSON.stringify({ adminToken: "legacy", apiKey: "k" }));
  const config = createGatewayConfig({ dataDir });
  assert.deepEqual(await config.load(), { apiKey: "k" });
});
