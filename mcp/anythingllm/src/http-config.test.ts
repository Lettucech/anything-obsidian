import assert from "node:assert/strict";
import test from "node:test";

import { mcpHttpOptions } from "./http-config.js";

test("allows localhost clients and the Compose MCP hostname", () => {
  assert.deepEqual(mcpHttpOptions(), {
    host: "0.0.0.0",
    allowedHosts: ["localhost", "127.0.0.1", "mcp", "anything-obsidian-mcp"],
  });
});

test("uses an explicit allowlist for the LAN MCP hostname", () => {
  assert.deepEqual(mcpHttpOptions("obsidian-host.local,192.168.1.10"), {
    host: "0.0.0.0",
    allowedHosts: ["localhost", "127.0.0.1", "mcp", "anything-obsidian-mcp", "obsidian-host.local", "192.168.1.10"],
  });
});
