# Anything Obsidian — coding-agent plugin

One plugin directory, two harness manifests: Claude Code
(`.claude-plugin/plugin.json`) and Codex CLI v0.117.0+ (`.codex-plugin/
plugin.json` + `.mcp.json`). Both point at an Anything Obsidian MCP
endpoint: one RAG search across every vault workspace, plus — on a local
install — raw vault discovery, bounded source reads and the `any_obs_*`
management tools. Nothing here writes vault content — the vault Git
repository stays the source of truth.

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

## Endpoint & token (Claude Code)

At install time Claude Code asks for two values:

- **MCP endpoint** — default `http://127.0.0.1:21503/mcp`, the local
  profile of an any-obs install on this machine. To go zero-install
  instead, enter a team server's endpoint:
  `http://<server-host>:21500/mcp`.
- **Bearer token** — empty for a local install (loopback is
  owner-trusted). For a direct server connection this is your server user
  token; it is stored masked, and the RAG-only server surface decides what
  the token can read.

The token rides along harmlessly on the local profile too: the loopback
listener treats any non-matching credential as the anonymous local caller.

## Endpoint (Codex CLI)

The Codex manifest keeps the fixed local endpoint (`127.0.0.1:21503`) —
it only exists where any-obs is installed, and the local listener accepts
loopback Host headers only. Codex agents joining a team server without an
any-obs install configure the server's MCP in `~/.codex/config.toml`
directly (`url` + `bearer_token_env_var`) — see `docs/agent-mcp.md`.

## Requirements

- A configured, running any-obs install on this machine for the default
  endpoint — verify with `anything-obsidian status --json` (exit 0 +
  `"ok": true`). If it is not running, `anything-obsidian start`.
- The local MCP server binds loopback 21503, the owner-trusted local
  profile. Alternatively, point the endpoint at a team server's
  `:21500/mcp` with a user token to skip the install entirely — see
  `docs/agent-mcp.md`.

## Skills

The retrieval/edit workflow skill (`anything-obsidian-vault-workflow`)
ships with the plugin — installing it above is all an agent needs. The
canonical copy lives in the repository's `skills/` directory; agents
without the plugin can install the skill on its own:

```bash
npx skills add Lettucech/anything-obsidian --skill anything-obsidian-vault-workflow
```

(Installing both the plugin and the skill is harmless but redundant.)

Agents without a plugin system: `anything-obsidian connect` writes the
matching MCP config for Claude Code, Cursor, Windsurf, Codex, Gemini CLI
and VS Code.
