# Per-Vault Workspaces, RAG Façade, Search-First

Date: 2026-11-02
Status: implemented (v1) — commits 7ffb107 (façade), 31076b7 (per-vault +
search-first), plus the retrieval hint
Depends on: 2026-11-02-client-server-simplification.md (uses "server" naming)

## Goal

Make cross-vault divergence **deterministically visible** and make
AnythingLLM a pure RAG index engine (ingestion + retrieval; no LLM path).
Three coupled changes deliver that:

1. **Per-vault workspaces** — one AnythingLLM workspace per managed vault,
   replacing the single unified workspace. Fan-out over per-vault legs
   guarantees both versions of a divergent fact co-retrieve; the merge
   policy guarantees no vault's result is crowded out.
2. **One RAG façade** — a single `lib/` implementation of fan-out → merge
   → tag/attribution, imported by both the local MCP and the server. Today
   the same logic lives twice (`server/fanout.mjs`, inline in
   `mcp/index.mjs`) and must drift.
3. **Search-first** — `any_obs_rag_answer` (single-workspace `/chat`, the
   only LLM-touching call) is retired. Agents retrieve attributed chunks
   and synthesize themselves, where the conversation context lives.

Design decisions settled in discussion (2026-11-02):

- Divergent duplicate content across vaults is a **feature** (a clarify
  signal), not a bug to dedup. This spec makes the signal reliable.
- Synthesis is the agent's job. AnythingLLM's chat/LLM is not on any-obs
  code path after this change.
- AnythingLLM stays the sole retrieval engine for now (it does the dirty
  work: chunking, embedding provider abstraction, doc lifecycle). The
  façade defines a `RagIndex` seam so an embedded store can be added as a
  second adapter later without touching façade semantics.
- Chunk source stays `<vaultId>/<rel>`; workspace slug becomes per-vault,
  making the workspace tag redundant but harmless (kept for response
  compatibility).

## 1. Per-vault workspaces

- Slug convention: `any-obs-<host>-<vaultId>` (host prefix preserved so
  instances sharing one AnythingLLM never collide). Registry records each
  vault's workspace slug; the top-level `workspace` entry is removed.
- Document folders stay `anything-obsidian-vault-<vaultId>` (unchanged).
- Embed pipeline targets the vault's own workspace; manifest purge is
  already per-vault, now scoped to the per-vault workspace.
- Removal of a vault removes its workspace's documents (manifest purge)
  and optionally the empty workspace itself; never other vaults' data.
- **Migration** (first embed/scheduler start after upgrade): detect the
  legacy top-level `workspace` → create per-vault workspaces → purge the
  unified workspace's documents → delete the unified workspace → re-embed
  every vault from source. Full re-embed cost is accepted (bounded by
  vault size); progress visible as ordinary embed jobs; `status --json`
  reports migration state. Never delete vault files or repos.
- Gateway/server shared (non-vault) workspaces are unaffected: they keep
  their own slugs and grants; fan-out covers them alongside vault legs.

## 2. RAG façade (`lib/fanout.mjs`)

- One implementation: fan-out over N workspaces (Promise.all, per-leg
  error capture), defensive chunk extraction (AnythingLLM's response
  shape is uncommitted), merge with **per-vault guaranteed slots**,
  tagging (workspace, vaultId, vault-relative path), vaultId filtering.
- Merge policy: every workspace with at least one chunk above threshold
  gets its best chunk into the result set first; remaining slots filled
  by global score order; `topN` remains the total cap. This is what makes
  divergence visibility deterministic.
- Client MCP (`any_obs_rag_search`) and server (`fanoutSearch`) both call
  it with their own credentials and their own allowed-workspace list —
  trust models unchanged, code shared.
- `server/fanout.mjs` and the inline logic in `mcp/index.mjs` are deleted.

## 3. Search-first tool surface

- `any_obs_rag_answer` is removed. `any_obs_rag_search` becomes the
  primary agent RAG tool (description already says "Prefer this").
- Weak-retrieval refusal moves from behavior to **data**: search results
  carry a hint (e.g. `belowCutoff: true` / per-chunk flag) when scores
  sit under the workspace cutoff, so the agent can tell the user "nothing
  solid found" instead of the old refusal path inside `/chat`.
  *Implemented as* `retrievalHint()` in `lib/fanout.mjs`: every search
  payload carries `maxScore` and `weakRetrieval` (raised when the top
  score sits under AnythingLLM's default 0.25 cutoff, or when nothing was
  retrieved; a caller-supplied `scoreThreshold` is respected as their own
  judgment). Both planes (client MCP and server `fanoutSearch`) emit it.
- `docs/agent-mcp.md` and tool descriptions updated: synthesis guidance
  (read chunks, compare versions across vaults, ask the user to clarify
  contradictions, use `any_obs_file_read` for full sources).

## 4. `RagIndex` seam (internal)

- *Implemented structurally, not as a formal interface module.* All
  AnythingLLM HTTP knowledge is confined to four modules —
  `dashboard/anythingllm.mjs` (workspace CRUD),
  `lib/fanout.mjs` (vector search + merge),
  `scripts/embed-vault.mjs` (upload/update-embeddings/documents/pins),
  `lib/unified-workspace.mjs` (purge + per-vault ensure) — and no caller
  outside them builds an upstream URL. That confinement **is** the seam:
  an embedded-store adapter #2 replaces or wraps those four modules
  without touching façade semantics, tool surfaces, or the migration.
  A literal `lib/rag-index/` interface with exactly one implementation
  would be a dead abstraction until adapter #2 work starts; it becomes a
  30-minute mechanical job on that day. Decision recorded 2026-11-02 at
  implementation time.
- No behavior change; this exists so a future embedded store
  (LanceDB/sqlite-vec) is a bounded project, per the keep-AnythingLLM
  decision of 2026-11-02.

## 5. Verification items

- **AnythingLLM without a chat LLM** (needs a live instance — run at
  deploy): `/vector-search` and `/update-embeddings` must work on an
  instance with no LLM provider attached (expectation: these paths only
  need the embedding provider). If disproven, revisit search-first with
  the owner.
- Divergence guarantee: covered in `lib/fanout.test.mjs` (guaranteed-slot
  crowding test). A live two-vault check (same note, edited in one → one
  `any_obs_rag_search` returns both versions) runs at deploy alongside
  the no-LLM check above.
- Migration rehearsal on a copy of a real data root; machine 2 (tester)
  deploy after merge, watch embed jobs reconcile — both still to do at
  deploy time. The migration itself is unit-covered in
  `lib/unified-workspace.test.mjs`.

## Out of scope

- Content dedup / refcounting (rejected 2026-11-02).
- Embedded vector store adapter #2 (future spec).
- Docker flavor.
