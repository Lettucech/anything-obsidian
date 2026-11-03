import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The plugin bundles the vault-workflow skill so a plugin install carries
// the workflow without `npx skills add`. The repository's skills/ directory
// stays the canonical source (the npx CLI reads it); the bundled copy is a
// build-free mirror that must never drift.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const canonical = path.join(repoRoot, "skills", "anything-obsidian-vault-workflow", "SKILL.md");
const bundled = path.join(
  repoRoot,
  "plugins",
  "anything-obsidian",
  "skills",
  "anything-obsidian-vault-workflow",
  "SKILL.md",
);

test("the bundled vault-workflow skill matches the canonical skills/ copy byte for byte", async () => {
  const [canonicalText, bundledText] = await Promise.all([
    readFile(canonical, "utf8"),
    readFile(bundled, "utf8"),
  ]);
  assert.equal(canonicalText, bundledText);
});

test("both plugin manifests declare the bundled skills directory at version parity", async () => {
  const claude = JSON.parse(
    await readFile(path.join(repoRoot, "plugins", "anything-obsidian", ".claude-plugin", "plugin.json"), "utf8"),
  );
  const codex = JSON.parse(
    await readFile(path.join(repoRoot, "plugins", "anything-obsidian", ".codex-plugin", "plugin.json"), "utf8"),
  );
  assert.equal(claude.skills, "./skills/");
  assert.equal(codex.skills, "./skills/");
  assert.equal(claude.version, codex.version);
  const marketplace = JSON.parse(
    await readFile(path.join(repoRoot, ".claude-plugin", "marketplace.json"), "utf8"),
  );
  assert.equal(marketplace.plugins[0].version, claude.version);
});

test("the Claude manifest stays configurable (endpoint + optional Bearer token); Codex stays fixed to loopback", async () => {
  const claude = JSON.parse(
    await readFile(path.join(repoRoot, "plugins", "anything-obsidian", ".claude-plugin", "plugin.json"), "utf8"),
  );
  const server = claude.mcpServers["anything-obsidian"];
  assert.equal(server.type, "http");
  assert.equal(server.url, "${user_config.mcp_url}");
  assert.equal(server.headers.Authorization, "Bearer ${user_config.mcp_token}");
  assert.equal(claude.userConfig.mcp_url.default, "http://127.0.0.1:21503/mcp");
  assert.equal(claude.userConfig.mcp_token.sensitive, true);
  assert.equal(claude.userConfig.mcp_token.default, "");

  // Codex has no confirmed interpolation for headers in its plugin config,
  // so its .mcp.json stays on the fixed local endpoint; direct-server Codex
  // agents go through ~/.codex/config.toml instead (docs/agent-mcp.md).
  const codexMcp = JSON.parse(
    await readFile(path.join(repoRoot, "plugins", "anything-obsidian", ".mcp.json"), "utf8"),
  );
  assert.equal(codexMcp.mcpServers["anything-obsidian"].url, "http://127.0.0.1:21503/mcp");
});
