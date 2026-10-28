import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createGatewayConfig } from "./gateway-config.mjs";

test("gateway config persists admin token and api key with 0600 in the data dir", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "any-obs-gateway-config-"));
  const config = createGatewayConfig({ dataDir });

  assert.deepEqual(await config.load(), { adminToken: "", apiKey: "" });
  assert.equal(await config.configured(), false);

  await config.save({ adminToken: "tok-1" });
  assert.deepEqual(await config.load(), { adminToken: "tok-1", apiKey: "" });
  assert.equal(await config.configured(), false);

  await config.save({ apiKey: "key-1" });
  assert.deepEqual(await config.load(), { adminToken: "tok-1", apiKey: "key-1" });
  assert.equal(await config.configured(), true);

  const stat = await (await import("node:fs/promises")).stat(path.join(dataDir, "gateway.json"));
  assert.equal(stat.mode & 0o777, 0o600);
});

test("chmod 0600 is enforced even when the file pre-exists with looser mode", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "any-obs-gateway-config-"));
  const config = createGatewayConfig({ dataDir });
  await config.save({ adminToken: "a" });
  await chmod(path.join(dataDir, "gateway.json"), 0o644);
  await config.save({ apiKey: "b" });
  const stat = await (await import("node:fs/promises")).stat(path.join(dataDir, "gateway.json"));
  assert.equal(stat.mode & 0o777, 0o600);
});
