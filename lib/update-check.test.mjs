import assert from "node:assert/strict";
import test from "node:test";

import { compareVersions, currentVersionValue, fetchLatestVersion } from "./update-check.mjs";

test("current version comes from package.json", async () => {
  const version = await currentVersionValue();
  assert.match(version, /^\d+\.\d+\.\d+/);
});

test("compareVersions orders semver triples", () => {
  assert.equal(compareVersions("0.1.0", "0.2.0"), -1);
  assert.equal(compareVersions("0.2.0", "0.1.0"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("0.2.9", "0.10.0"), -1);
  assert.equal(compareVersions("", "0.2.0"), -1);
});

test("fetchLatestVersion parses the remote package version and caches it", async () => {
  const calls = [];
  const latest = await fetchLatestVersion({
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: true, json: async () => ({ version: "9.9.9" }) };
    },
    now: () => 1_000,
  });
  assert.equal(latest, "9.9.9");

  const again = await fetchLatestVersion({
    fetchImpl: async () => { throw new Error("should not refetch within ttl"); },
    now: () => 2_000,
  });
  assert.equal(again, "9.9.9");
  assert.equal(calls.length, 1);
});

test("a failing fetch returns null instead of throwing", async () => {
  assert.equal(await fetchLatestVersion({ fetchImpl: async () => { throw new Error("offline"); }, now: () => 5_000_000_000_000, url: "x" }), null);
  assert.equal(await fetchLatestVersion({ fetchImpl: async () => ({ ok: true, json: async () => ({}) }), now: () => 9_000_000_000_000 }), null);
});
