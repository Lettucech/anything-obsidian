---
name: anything-obsidian-vault-workflow
description: Search, verify, assess, or edit a managed Obsidian vault through Anything Obsidian while preserving vault-local rules and the read-only MCP boundary.
---

# Anything Obsidian Vault Workflow

## When to Use

Use this skill when an agent must:

- find or answer from knowledge in an Anything Obsidian managed vault;
- inspect source Markdown or Canvas files behind the derived RAG index;
- assess a managed vault before proposing a knowledge change; or
- edit a managed vault from a local agent with filesystem authority.

## Do Not Use When

Do not use this skill to administer the Anything Obsidian services, debug its
deployment, register a vault, or change Git sync and embedding configuration.
Use the dashboard and project operations guidance for those tasks.

Do not use the LAN MCP profile to edit a vault. It is intentionally RAG-only.

## Source and authority boundaries

The vault files and their Git repository are the source of truth. AnythingLLM
is a derived index that may lag behind the files. Use RAG to discover likely
sources, then verify consequential claims against the source note before
answering or editing.

The MCP interface is read-only. Never call obsolete MCP write, patch, upload,
sync, or reindex tools even if a stale deployment advertises them. If the live
tool surface contradicts this contract, fail closed for mutations and report
the deployment drift.

This skill grants no write, commit, sync, or push authority. The target vault's
applicable `AGENTS.md`, other local instructions, and the user's approval define
what is allowed. More specific vault instructions take precedence over this
portable workflow.

## Establish the vault context

1. Call `obsidian_vault_list`. When more than one vault is available, select an
   explicit `vaultId`; never search across vaults implicitly.
2. On the local profile, call `obsidian_vault_context` before substantial
   retrieval or any proposed edit. Inspect its policy files, source directory,
   edit boundary, sync settings, and RAG freshness warning.
3. Read every returned policy file before deciding placement, language,
   frontmatter, sensitive-data handling, Git actions, or write authority. Also
   read any more specific instructions that apply to the target path.
4. Treat a restricted or inaccessible vault as blocked. Do not infer access
   from its name or from a RAG result.

If `obsidian_vault_context` is unavailable, ordinary read-only retrieval may
continue with the current read tools when access is otherwise clear. Do not
edit until the local source directory, applicable policy, and sync side effects
have been established through an authorized path.

## Retrieve and verify knowledge

- Prefer `anythingllm_search_chunks` to discover candidate notes and source
  passages. Use `anythingllm_answer` only when a synthesized answer is useful.
- Use `obsidian_file_list` to inspect the actual vault structure and
  `obsidian_file_read` to verify the current source text.
- Preserve the source path and any relevant date, revision, decision state, or
  uncertainty. Do not turn an index answer into project truth without checking
  the source note.
- Find the existing canonical note before proposing a new one. Follow any
  vault-local routing to another skill for project knowledge, PARA management,
  digest processing, or other specialized work.

## Edit from a local agent

Before changing a file:

1. Use the directory returned by `obsidian_vault_context` and confirm it is the
   selected vault's Git working tree.
2. Inspect `git status` and preserve unrelated user changes.
3. Identify the canonical target note and the rules applying to its path.
4. Surface automatic pull, commit, push, or embedding behavior from the
   context. A background sync can externalize a local edit even when the agent
   does not run Git itself.
5. State the intended paths, change, non-goals, and verification. Wait for
   scoped approval unless a vault-local standing authorization clearly covers
   the operation.

Make the smallest source-file change through the local filesystem. Preserve
frontmatter, links, provenance, voice, and language required by the target
vault. Do not modify Obsidian configuration or restructure notes as a side
effect. Commit only when the vault rules and approved scope require it; never
push unless explicitly authorized.

## Completion evidence

Read back every changed note, inspect the relevant Git diff, and validate any
affected links, frontmatter, placement, or source references. Report:

- changed paths and the evidence supporting each material change;
- skipped, conflicting, or unresolved information;
- whether Git commit or background sync may still occur; and
- that the RAG index remains derived and may be stale unless an authorized
  indexing operation has completed.
