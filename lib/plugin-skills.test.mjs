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
