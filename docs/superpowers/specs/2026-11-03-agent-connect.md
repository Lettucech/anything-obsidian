# Agent Connect + Claude Code Plugin

Date: 2026-11-03
Status: implemented (v1)

## Goal

`npx skills add` already distributes the repository skills, but every coding
agent still needed hand-edited MCP registration — each agent keeps a
different config file and a different spelling of the same streamable-HTTP
endpoint. This change closes that gap:

1. **`anything-obsidian connect`** — one CLI command that detects installed
   coding agents and writes the matching MCP registration into each agent's
   own config, idempotently, with `--remove` to unregister.
2. **A Claude Code plugin package** — `.claude-plugin/marketplace.json` at
   the repository root plus `plugins/claude-code/` carrying the same MCP
   registration, so Claude Code users can
   `/plugin install anything-obsidian@anything-obsidian` in one step.

## Decisions

- **Local profile only (v1).** The command wires `http://127.0.0.1:21503/mcp`
  (loopback, owner-trusted, no headers). Remote agents keep joining through
  the server feature with Bearer tokens; writing tokens into agent configs is
  a separate, later decision.
- **One key, foreign files untouched.** Each writer sets exactly one key
  (`anything-obsidian`) in the agent's config and preserves every other
  entry, file permissions included; malformed configs are refused, not
  overwritten. Codex TOML is a targeted block edit (no TOML dependency).
- **Skills stay with `npx skills`.** connect only advertises the install
  command; it never shells out to it and never hand-copies skills (per the
   setup skill's own rule). The Claude Code plugin is likewise MCP-only —
  skill content stays canonical under `skills/`.
- **ZCode reports, not writes.** ZCode has no user-global MCP registration
  (MCP arrives via plugins and project `.mcp.json`), so its target prints
  the project-level snippet instead of inventing a config location.

## Surface

- `lib/agent-connect.mjs`: `AGENT_TARGETS` (claude-code, cursor, windsurf,
  codex, gemini, vscode, zcode), `detectAgents`, `applyConnection`,
  `DEFAULT_MCP_URL`.
- CLI: `connect [agent...] | --list | --remove | --url <url> [--json]`;
  no-arg selects every detected agent; a `/health` probe after connecting
  points at `anything-obsidian start` when the app is down; explicit
  targets that are not installed exit 1.
- Docs: `docs/agent-mcp.md` carries the per-agent config table and the
  plugin install one-liner.
