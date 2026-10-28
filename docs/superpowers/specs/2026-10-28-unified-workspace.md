# Unified Workspace (one instance, one RAG index)

Date: 2026-10-28
Status: implemented

## Goal

Replace the per-vault AnythingLLM workspace model (1 vault = 1 workspace)
with one unified workspace per any-obs instance. All vaults embed into the
same index; RAG search and answer run across every managed vault at once;
results carry vault attribution; the agent never has to know which vault
holds information before it can search (the old model's catch-22:
`resolveVault` threw when more than one vault was accessible and no
`vaultId` was given).

`vaultId` on the RAG tools stops being a workspace selector and becomes an
optional client-side result filter.

This is the foundation for the shared-instance deployment model: the
unified workspace becomes the user's personal workspace behind the IAM
middleware, with no further redesign.

## Design

### Instance workspace identity

The registry (`registry/vaults.json`) grows a top-level object next to
`vaults`:

```json
{ "version": 1, "workspace": { "slug": "...", "name": "..." }, "vaults": [] }
```

- `workspace` is instance state, created once, shared by every vault.
- Default name is namespaced to this machine (`any-obs-<host>-<suffix>`) so
  multiple any-obs instances pointing at one shared AnythingLLM never
  collide. An existing workspace can be attached instead.
- Vault records lose their `workspaceSlug` field entirely.

### Document folders stay per vault

Uploads keep going to `anything-obsidian-vault-<vaultId>` (single-segment
folder). A folder is document organisation inside AnythingLLM, orthogonal to
the workspace; keeping one folder per vault makes a vault's documents
identifiable and removable from the shared index.

### Chunk metadata carries vault attribution

Upload metadata becomes `title`/`chunkSource` = `<vaultId>/<vault-relative
path>`. Search results are enriched with the parsed `vaultId` so an agent
can go straight from a RAG hit to `any_obs_file_read` in the owning vault.
Chunks whose source does not map to an accessible vault keep their original
fields without attribution.

### RAG tools

- `any_obs_rag_search` queries the unified workspace. `vaultId` is an
  optional filter applied to enriched results; restricted vaults a caller
  cannot access are dropped from results regardless.
- `any_obs_rag_answer` chats against the unified workspace with no vault
  selection. Cross-vault synthesis is the point; in the per-agent
  deployment model the whole instance belongs to one caller.

### Removal purges derived data

Removing a vault still never touches its repository or the user's files,
and still never deletes an AnythingLLM workspace — but the workspace is
instance-level now. The vault's chunks and documents are derived data and
are removed from the unified index (manifest-driven `deletes` via
update-embeddings, then the document folder is removed), so stale content
does not pollute shared searches.

### Migration from per-vault workspaces

When `ensureUnifiedWorkspace` first runs against a registry that still has
legacy per-vault `workspaceSlug` fields, it creates (or attaches) the
unified workspace, drops the legacy fields, and wipes every vault's embed
manifest. The next embed re-uploads all files into the unified workspace
(full re-embed; RAG is rebuildable by design). Old per-vault workspaces are
left in place, never deleted.

## Touch points

- `lib/vault-registry.mjs` — top-level `workspace` get/set; vault records
  without `workspaceSlug`.
- `lib/unified-workspace.mjs` (new) — ensure/attach/migrate + vault
  embedding purge used by dashboard removal.
- `scripts/vault-config.mjs` — worker config takes the unified slug.
- `scripts/embed-vault.mjs` — `vaultId`-prefixed metadata.
- `scripts/doctor.mjs` — probes the unified workspace.
- `dashboard/server.mjs` — vault add no longer creates a workspace;
  `GET /api/workspace`, `POST /api/workspace/attach`; DELETE purges.
- `mcp/index.mjs`, `mcp/vault-registry.mjs`, `mcp/manage.mjs` — RAG tools on
  the unified workspace; `vault_add` without workspace fields.
- `dashboard/public/*` — add-vault dialog loses the workspace picker; the
  vault list shows the shared workspace once.

## Known limitation

`any_obs_rag_answer` synthesises over the whole unified workspace, so a
restricted caller using answer (rather than search) can surface restricted
vault content in prose. Per-agent deployment makes this moot in practice;
revisit only if the central multi-agent model returns.
