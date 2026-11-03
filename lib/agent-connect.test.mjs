import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AGENT_TARGETS,
  DEFAULT_MCP_URL,
  applyConnection,
  detectAgents,
  findAgentTarget,
} from "./agent-connect.mjs";

async function fakeHome(t) {
  const home = await mkdtemp(path.join(tmpdir(), "any-obs-agents-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

const readJson = async (filePath) => JSON.parse(await readFile(filePath, "utf8"));

test("connect writes the native entry shape per JSON agent and is idempotent", async (t) => {
  const cases = [
    {
      id: "claude-code",
      file: ".claude.json",
      expected: { type: "http", url: DEFAULT_MCP_URL },
      markers: [".claude.json", ".claude"],
    },
    { id: "cursor", file: ".cursor/mcp.json", expected: { url: DEFAULT_MCP_URL }, markers: [".cursor"] },
    {
      id: "windsurf",
      file: ".codeium/windsurf/mcp_config.json",
      expected: { serverUrl: DEFAULT_MCP_URL },
      markers: [".codeium/windsurf"],
    },
    {
      id: "gemini",
      file: ".gemini/settings.json",
      expected: { httpUrl: DEFAULT_MCP_URL },
      markers: [".gemini"],
    },
    {
      id: "vscode",
      file: ".vscode/mcp.json",
      container: "servers",
      expected: { type: "http", url: DEFAULT_MCP_URL },
      markers: [".vscode"],
    },
  ];
  for (const { id, file, container = "mcpServers", expected, markers } of cases) {
    const home = await fakeHome(t);
    // The last marker is always a directory marker (claude-code's first
    // marker is the ~/.claude.json file itself, which the writer creates).
    await mkdir(path.join(home, markers[markers.length - 1]), { recursive: true });
    const filePath = path.join(home, file);
    const first = await applyConnection({ id, homeDir: home });
    assert.equal(first.status, "connected", id);
    const config = await readJson(filePath);
    assert.deepEqual(config[container]["anything-obsidian"], expected, id);
    const second = await applyConnection({ id, homeDir: home });
    assert.equal(second.status, "unchanged", id);
    assert.deepEqual(await readJson(filePath), config, `${id} rewire must not change the file`);
  }
});

test("connect merges into existing configs and preserves foreign entries", async (t) => {
  const home = await fakeHome(t);
  await writeFile(
    path.join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: { "other-tool": { command: "other" } },
      projects: { "/tmp/x": { history: ["hi"] } },
      theme: "dark",
    }),
  );
  const result = await applyConnection({ id: "claude-code", homeDir: home });
  assert.equal(result.status, "connected");
  const config = await readJson(path.join(home, ".claude.json"));
  assert.deepEqual(config.mcpServers["other-tool"], { command: "other" });
  assert.deepEqual(config.mcpServers["anything-obsidian"], { type: "http", url: DEFAULT_MCP_URL });
  assert.deepEqual(config.projects, { "/tmp/x": { history: ["hi"] } });
  assert.equal(config.theme, "dark");
  const remove = await applyConnection({ id: "claude-code", homeDir: home, remove: true });
  assert.equal(remove.status, "removed");
  const after = await readJson(path.join(home, ".claude.json"));
  assert.equal(after.mcpServers["anything-obsidian"], undefined);
  assert.deepEqual(after.mcpServers["other-tool"], { command: "other" });
  assert.equal(after.theme, "dark");
  const again = await applyConnection({ id: "claude-code", homeDir: home, remove: true });
  assert.equal(again.status, "unchanged");
});

test("remove never creates a config file for an agent that was never connected", async (t) => {
  const home = await fakeHome(t);
  await mkdir(path.join(home, ".cursor"), { recursive: true });
  const result = await applyConnection({ id: "cursor", homeDir: home, remove: true });
  assert.equal(result.status, "unchanged");
  await assert.rejects(readJson(path.join(home, ".cursor", "mcp.json")));
});

test("an empty config file is treated as an empty object, not an error", async (t) => {
  const home = await fakeHome(t);
  await mkdir(path.join(home, ".vscode"), { recursive: true });
  await writeFile(path.join(home, ".vscode", "mcp.json"), "");
  const result = await applyConnection({ id: "vscode", homeDir: home });
  assert.equal(result.status, "connected");
  const config = await readJson(path.join(home, ".vscode", "mcp.json"));
  assert.deepEqual(config.servers["anything-obsidian"], { type: "http", url: DEFAULT_MCP_URL });
});

test("a malformed config file is refused, not overwritten", async (t) => {
  const home = await fakeHome(t);
  await mkdir(path.join(home, ".cursor"), { recursive: true });
  await writeFile(path.join(home, ".cursor", "mcp.json"), "{ not json");
  await assert.rejects(
    applyConnection({ id: "cursor", homeDir: home }),
    /not valid JSON/,
  );
  assert.equal(await readFile(path.join(home, ".cursor", "mcp.json"), "utf8"), "{ not json");
});

test("writing preserves the permissions of an existing config file", async (t) => {
  const home = await fakeHome(t);
  await mkdir(path.join(home, ".cursor"), { recursive: true });
  const filePath = path.join(home, ".cursor", "mcp.json");
  await writeFile(filePath, "{}\n");
  await chmod(filePath, 0o600);
  await applyConnection({ id: "cursor", homeDir: home });
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
});

test("codex: our TOML table is appended, replaced and removed without touching other tables", async (t) => {
  const home = await fakeHome(t);
  await mkdir(path.join(home, ".codex"), { recursive: true });
  const filePath = path.join(home, ".codex", "config.toml");
  const original = [
    'model = "gpt-5"',
    "",
    "[mcp_servers.other]",
    'command = "npx"',
    "",
    "[mcp_servers.other.env]",
    'TOKEN = "secret"',
    "",
  ].join("\n");
  await writeFile(filePath, original);

  const first = await applyConnection({ id: "codex", homeDir: home });
  assert.equal(first.status, "connected");
  let text = await readFile(filePath, "utf8");
  assert.match(text, /\[mcp_servers\.anything-obsidian\]\nurl = "http:\/\/127\.0\.0\.1:21503\/mcp"\n$/);
  assert.match(text, /\[mcp_servers\.other\]\ncommand = "npx"/);
  assert.match(text, /\[mcp_servers\.other\.env\]\nTOKEN = "secret"/);
  assert.match(text, /^model = "gpt-5"/);

  const second = await applyConnection({ id: "codex", homeDir: home });
  assert.equal(second.status, "unchanged");
  assert.equal(await readFile(filePath, "utf8"), text);

  const changed = await applyConnection({
    id: "codex",
    homeDir: home,
    url: "http://127.0.0.1:29999/mcp",
  });
  assert.equal(changed.status, "connected");
  text = await readFile(filePath, "utf8");
  assert.match(text, /url = "http:\/\/127\.0\.0\.1:29999\/mcp"/);
  assert.match(text, /\[mcp_servers\.other\.env\]\nTOKEN = "secret"/);

  const removed = await applyConnection({ id: "codex", homeDir: home, remove: true });
  assert.equal(removed.status, "removed");
  text = await readFile(filePath, "utf8");
  assert.doesNotMatch(text, /anything-obsidian/);
  assert.match(text, /\[mcp_servers\.other\]\ncommand = "npx"/);
  assert.match(text, /TOKEN = "secret"/);
  assert.match(text, /^model = "gpt-5"/);

  const again = await applyConnection({ id: "codex", homeDir: home, remove: true });
  assert.equal(again.status, "unchanged");

  // An append + remove cycle must restore the file byte for byte.
  await applyConnection({ id: "codex", homeDir: home });
  await applyConnection({ id: "codex", homeDir: home, remove: true });
  assert.equal(await readFile(filePath, "utf8"), original);
});

test("codex: an empty config file gets just our table", async (t) => {
  const home = await fakeHome(t);
  await mkdir(path.join(home, ".codex"), { recursive: true });
  const result = await applyConnection({ id: "codex", homeDir: home });
  assert.equal(result.status, "connected");
  const text = await readFile(path.join(home, ".codex", "config.toml"), "utf8");
  assert.equal(
    text,
    '[mcp_servers.anything-obsidian]\nurl = "http://127.0.0.1:21503/mcp"\n',
  );
});

test("zcode reports skipped with guidance instead of writing a config", async (t) => {
  const home = await fakeHome(t);
  await mkdir(path.join(home, ".zcode"), { recursive: true });
  const connect = await applyConnection({ id: "zcode", homeDir: home });
  assert.equal(connect.status, "skipped");
  assert.match(connect.note, /\.mcp\.json/);
  const remove = await applyConnection({ id: "zcode", homeDir: home, remove: true });
  assert.equal(remove.status, "skipped");
  assert.equal(remove.configPath, null);
});

test("unknown agents are rejected and every target id is unique", async (t) => {
  const home = await fakeHome(t);
  assert.throws(() => findAgentTarget("nope"), /Unknown agent "nope"/);
  const ids = AGENT_TARGETS.map((target) => target.id);
  assert.equal(new Set(ids).size, ids.length);
  const result = await applyConnection({ id: "claude-code", homeDir: home });
  assert.equal(result.status, "not-installed");
  assert.match(result.note, /no Claude Code configuration found/);
  await assert.rejects(stat(path.join(home, ".claude.json")));
});

test("detectAgents flags exactly the agents whose markers exist", async (t) => {
  const home = await fakeHome(t);
  await mkdir(path.join(home, ".cursor"), { recursive: true });
  await writeFile(path.join(home, ".claude.json"), "{}\n");
  const rows = await detectAgents({ homeDir: home });
  const byId = Object.fromEntries(rows.map((row) => [row.id, row.detected]));
  assert.equal(byId["claude-code"], true);
  assert.equal(byId.cursor, true);
  assert.equal(byId.codex, false);
  assert.equal(byId.windsurf, false);
  assert.equal(byId.gemini, false);
  assert.equal(byId.vscode, false);
  assert.equal(byId.zcode, false);
});
