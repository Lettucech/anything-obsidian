import assert from "node:assert/strict";
import test from "node:test";

import { mcpHttpOptions } from "./http-config.mjs";

test("defaults to loopback with localhost clients allowed", () => {
  assert.deepEqual(mcpHttpOptions(), {
    host: "127.0.0.1",
    allowedHosts: ["localhost", "127.0.0.1"],
  });
});

test("uses an explicit allowlist for LAN hostnames and can bind all interfaces", () => {
  assert.deepEqual(mcpHttpOptions("obsidian-host.local,192.168.1.10", { host: "0.0.0.0" }), {
    host: "0.0.0.0",
    allowedHosts: ["localhost", "127.0.0.1", "obsidian-host.local", "192.168.1.10"],
  });
});
