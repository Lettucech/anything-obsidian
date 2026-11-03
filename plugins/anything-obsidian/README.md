# Anything Obsidian — coding-agent plugin

One plugin directory, two harness manifests: Claude Code
(`.claude-plugin/plugin.json`) and Codex CLI v0.117.0+ (`.codex-plugin/
plugin.json` + `.mcp.json`). Both register the local Anything Obsidian MCP
endpoint (`http://127.0.0.1:21503/mcp`): one RAG search across every vault
workspace, raw vault discovery and bounded source reads, plus the
`any_obs_*` management tools. Nothing here writes vault content — the vault
Git repository stays the source of truth.

## Install

Claude Code:

```text
/plugin marketplace add Lettucech/anything-obsidian
/plugin install anything-obsidian@anything-obsidian
```

Codex CLI:

```bash
codex plugin marketplace add Lettucech/anything-obsidian
codex plugin add anything-obsidian@anything-obsidian
```

(For a checkout of this repository, pass the local path to
`marketplace add` instead of the GitHub slug.)

## Configuring the endpoint

Claude Code asks for the endpoint when the plugin is enabled
(`mcp_url`, default `http://127.0.0.1:21503/mcp` — this machine's local
install). Change it later in the plugin's settings
(`pluginConfigs` in `settings.json`).

Codex CLI plugins take a fixed `.mcp.json`; to point the plugin at another
endpoint, override the server by name in `~/.codex/config.toml`:

```toml
[mcp_servers."anything-obsidian"]
url = "http://<host>:21503/mcp"
```

A non-loopback endpoint should be the any-obs **server plane**
(`anything-obsidian server on`, port 21500, RAG-only), which expects an
`Authorization: Bearer <user-token>` header — see `docs/agent-mcp.md` for
the boundary between the local and server profiles.

## Requirements

- A configured, running any-obs install on this machine — verify with
  `anything-obsidian status --json` (exit 0 + `"ok": true`). If it is not
  running, `anything-obsidian start`.
- The MCP server binds loopback 21503, the owner-trusted local profile.
  Remote machines join through the server feature
  (`anything-obsidian server on`) with a user token instead — see
  `docs/agent-mcp.md`.

## Skills (optional)

The retrieval/edit workflow skill is installed separately and stays
canonical in the repository's `skills/` directory:

```bash
npx skills add Lettucech/anything-obsidian --skill anything-obsidian-vault-workflow
```

Agents without a plugin system: `anything-obsidian connect` writes the
matching MCP config for Claude Code, Cursor, Windsurf, Codex, Gemini CLI
and VS Code.
