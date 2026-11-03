import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const MCP_SERVER_KEY = "anything-obsidian";
export const DEFAULT_MCP_URL = "http://127.0.0.1:21503/mcp";

// Agent config files are foreign files this app only ever edits at one key:
// preserve their permissions, never land a partial write, and keep every
// other entry untouched.
async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function readAgentJson(filePath) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { existed: false, value: {} };
    throw error;
  }
  let value;
  try {
    value = text.trim() === "" ? {} : JSON.parse(text);
  } catch (error) {
    throw new Error(`${filePath} is not valid JSON (${error.message}); fix or remove it and retry.`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${filePath} does not hold a JSON object; refusing to rewrite it.`);
  return { existed: true, value };
}

async function atomicWriteText(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  let mode = 0o644;
  try {
    mode = (await stat(filePath)).mode & 0o777;
  } catch {
    // New file: plain 0644, like any other agent config it owns.
  }
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

// JSON-based agents all follow the same shape: one container key ("servers"
// for VS Code, "mcpServers" everywhere else) holding one entry per MCP
// server. We set exactly our key and leave the rest alone.
function jsonTarget({ id, label, configPath, markers, container = "mcpServers", entry }) {
  return {
    id,
    label,
    configPath,
    markers,
    async apply({ homeDir, url, remove }) {
      const filePath = configPath(homeDir);
      const { value } = await readAgentJson(filePath);
      const containerObj = value[container];
      if (containerObj === undefined) value[container] = {};
      else if (containerObj === null || typeof containerObj !== "object" || Array.isArray(containerObj))
        throw new Error(`"${container}" in ${filePath} is not an object; refusing to rewrite it.`);
      const servers = value[container];
      const current = servers[MCP_SERVER_KEY];
      if (remove) {
        if (current === undefined) return { id, status: "unchanged", configPath: filePath };
        delete servers[MCP_SERVER_KEY];
        await atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}\n`);
        return { id, status: "removed", configPath: filePath };
      }
      const desired = entry(url);
      if (JSON.stringify(current) === JSON.stringify(desired))
        return { id, status: "unchanged", configPath: filePath };
      servers[MCP_SERVER_KEY] = desired;
      await atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}\n`);
      return { id, status: "connected", configPath: filePath };
    },
  };
}

// Codex keeps its MCP servers as TOML tables. Without a TOML parser in the
// dependency set, the writer is a targeted block edit: find our table, cut to
// the next `[table]` header (blank lines excluded so the file keeps its
// shape), and replace or append — other tables are never re-serialized.
function codexTarget() {
  const header = `[mcp_servers.${MCP_SERVER_KEY}]`;
  const blockFor = (url) => `${header}\nurl = ${JSON.stringify(url)}\n`;
  const configPath = (homeDir) => path.join(homeDir, ".codex", "config.toml");
  return {
    id: "codex",
    label: "Codex CLI",
    configPath,
    markers: [(homeDir) => path.join(homeDir, ".codex")],
    async apply({ homeDir, url, remove }) {
      const filePath = configPath(homeDir);
      let text = "";
      try {
        text = await readFile(filePath, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const lines = text.split("\n");
      const start = lines.findIndex((line) => line.trim() === header);
      let end = -1;
      if (start !== -1) {
        end = lines.length;
        for (let i = start + 1; i < lines.length; i++)
          if (/^\s*\[/.test(lines[i])) {
            end = i;
            break;
          }
        while (end > start + 1 && lines[end - 1].trim() === "") end--;
      }
      if (remove) {
        if (start === -1) return { id: "codex", status: "unchanged", configPath: filePath };
        // When nothing non-blank follows our table it was appended here:
        // everything from the table header on is ours, so cutting there
        // restores the file byte for byte (the one separator newline the
        // append added merges into the original's trailing newline). Files
        // not ending in a newline normalize to ending in one.
        const wasLast = lines.slice(end).every((line) => line.trim() === "");
        if (wasLast) lines.length = start;
        else lines.splice(start, end - start);
        await atomicWriteText(filePath, lines.join("\n"));
        return { id: "codex", status: "removed", configPath: filePath };
      }
      const replacement = blockFor(url).replace(/\n$/, "").split("\n");
      let next;
      if (start === -1) {
        const base = text === "" ? "" : text.endsWith("\n") ? text : `${text}\n`;
        next = base === "" ? blockFor(url) : `${base}\n${blockFor(url)}`;
      } else {
        lines.splice(start, end - start, ...replacement);
        next = lines.join("\n");
      }
      if (next === text) return { id: "codex", status: "unchanged", configPath: filePath };
      await atomicWriteText(filePath, next);
      return { id: "codex", status: "connected", configPath: filePath };
    },
  };
}

// ZCode has no user-global MCP registration (its MCP servers come from
// plugins and project-level .mcp.json files), so connect only reports.
function zcodeTarget() {
  return {
    id: "zcode",
    label: "ZCode",
    configPath: (homeDir) => path.join(homeDir, ".zcode"),
    markers: [(homeDir) => path.join(homeDir, ".zcode")],
    async apply({ url, remove }) {
      return {
        id: "zcode",
        status: "skipped",
        configPath: null,
        note: remove
          ? "ZCode keeps no user-global MCP config; nothing recorded to remove."
          : `ZCode has no user-global MCP config; add {"mcpServers":{"${MCP_SERVER_KEY}":{"type":"http","url":"${url}"}}} to a project .mcp.json instead.`,
      };
    },
  };
}

export const AGENT_TARGETS = [
  jsonTarget({
    id: "claude-code",
    label: "Claude Code",
    configPath: (homeDir) => path.join(homeDir, ".claude.json"),
    markers: [
      (homeDir) => path.join(homeDir, ".claude.json"),
      (homeDir) => path.join(homeDir, ".claude"),
    ],
    // Claude Code http servers: { type: "http", url } (see ~/.claude.json).
    entry: (url) => ({ type: "http", url }),
  }),
  jsonTarget({
    id: "cursor",
    label: "Cursor",
    configPath: (homeDir) => path.join(homeDir, ".cursor", "mcp.json"),
    markers: [(homeDir) => path.join(homeDir, ".cursor")],
    // Cursor streamable-http servers take a bare url.
    entry: (url) => ({ url }),
  }),
  jsonTarget({
    id: "windsurf",
    label: "Windsurf",
    configPath: (homeDir) => path.join(homeDir, ".codeium", "windsurf", "mcp_config.json"),
    markers: [
      (homeDir) => path.join(homeDir, ".codeium", "windsurf"),
      (homeDir) => path.join(homeDir, ".codeium"),
    ],
    // Windsurf spells the endpoint serverUrl.
    entry: (url) => ({ serverUrl: url }),
  }),
  codexTarget(),
  jsonTarget({
    id: "gemini",
    label: "Gemini CLI",
    configPath: (homeDir) => path.join(homeDir, ".gemini", "settings.json"),
    markers: [(homeDir) => path.join(homeDir, ".gemini")],
    // Gemini CLI streamable-http servers use httpUrl inside settings.json.
    entry: (url) => ({ httpUrl: url }),
  }),
  jsonTarget({
    id: "vscode",
    label: "VS Code (Copilot)",
    configPath: (homeDir) => path.join(homeDir, ".vscode", "mcp.json"),
    markers: [(homeDir) => path.join(homeDir, ".vscode")],
    // VS Code nests under "servers", not "mcpServers".
    container: "servers",
    entry: (url) => ({ type: "http", url }),
  }),
  zcodeTarget(),
];

export function findAgentTarget(id) {
  const target = AGENT_TARGETS.find((candidate) => candidate.id === id);
  if (!target)
    throw new Error(
      `Unknown agent "${id}". Known agents: ${AGENT_TARGETS.map((t) => t.id).join(", ")}.`,
    );
  return target;
}

export async function detectAgents({ homeDir }) {
  const rows = [];
  for (const target of AGENT_TARGETS) {
    let detected = false;
    for (const marker of target.markers ?? []) {
      if (await pathExists(marker(homeDir))) {
        detected = true;
        break;
      }
    }
    rows.push({ id: target.id, label: target.label, detected });
  }
  return rows;
}

export async function applyConnection({ id, homeDir, url = DEFAULT_MCP_URL, remove = false }) {
  const target = findAgentTarget(id);
  for (const marker of target.markers ?? []) {
    if (await pathExists(marker(homeDir)))
      return target.apply({ homeDir, url, remove });
  }
  return {
    id,
    status: "not-installed",
    configPath: target.configPath(homeDir),
    note: `no ${target.label} configuration found on this machine`,
  };
}
