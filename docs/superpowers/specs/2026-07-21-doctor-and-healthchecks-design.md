# Doctor Hardening + Compose Healthchecks — Design

Date: 2026-07-21
Status: Approved (design), pending implementation

## Context

`doctor` is meant to be the trusted first-line health check for the private knowledge base stack, but today ([scripts/doctor.mjs](../../../scripts/doctor.mjs)) it only verifies three things: the vault mount is readable, the AnythingLLM `/api/docs` endpoint is reachable, and the API key can list workspaces.

That leaves the most common real-world failures undetected:

- The Git auth token is wrong or expired (the syncer then fails every interval).
- AnythingLLM is up but the embedder / LLM provider was never configured, so `embed` silently fails.
- The syncer's Git sync succeeds but embedding stopped working, so the index drifts behind the vault.
- MCP is unreachable, so coding agents cannot query the knowledge base.

Separately, `docker-compose.yml` defines no `healthcheck` on any service, and `mcp` / `syncer` use the list form of `depends_on`, which is start-order only. They boot before AnythingLLM can accept connections and error-loop until it comes up.

## Goal

Make `doctor` catch the failures above, and give Compose real readiness signals so dependents start only once their prerequisites are healthy.

## Non-goals

- AnythingLLM storage backup / restore (explicitly declined — the Obsidian vault in Git is the source of truth; AnythingLLM is a derived RAG layer).
- Disk-space checks (low value inside Docker; the runtime surfaces `no space` first).
- A healthcheck for the `syncer` service. It is an interval loop with no listening port; `restart: unless-stopped` already covers crashes, and detecting a wedged-but-alive loop is not worth the heartbeat plumbing.
- Any change to embedding behavior, manifest format, or the AnythingLLM/MCP API contracts.

## Design

### Doctor checks

Doctor keeps its existing `record()` / `checks[]` pattern and the `{ ok, checks: [{ name, ok, message }] }` return shape. The three current checks (vault mount, api docs, api key) stay unchanged. Four checks are added.

| Check | Method | Failure message (example) |
|---|---|---|
| `git remote` | `git ls-remote --heads <gitRemote> <gitBranch>` with `cwd = vaultPath` and the env produced by the existing `gitEnv(config)` (which sets `GIT_TERMINAL_PROMPT=0` so a missing credential fails fast instead of hanging). Runs even when no token is configured (public repos pass); on failure the message nudges toward `KB_GIT_AUTH_TOKEN`. | `git ls-remote failed (exit 128): Authentication failed for <remote>` |
| `mcp health` | `GET <mcpBaseUrl>/health`, pass on HTTP 200. | `MCP /health HTTP 503` |
| `embedder probe` | `POST /api/v1/workspace/<slug>/vector-search` with a trivial query (e.g. `"doctor"`). **Only the HTTP status is consulted**, never the payload — `vector-search` can legitimately return an empty array, so an empty result is not a failure signal. `200` ⇒ embedder is wired; non-`200` surfaces a real problem (most often a missing embedding engine). | `vector-search HTTP 500: No embedding engine configured` |
| `index drift` | Count entries in `<stateDir>/embed-manifest.json` versus the number of embeddable files found by scanning the vault. `0 embedded vs N>0 vault files` ⇒ "index empty"; `manifest < vault` ⇒ report the missing count plus up to 5 missing paths (sorted). An empty vault (0 files) reports healthy. | `index empty: 0 embedded vs 142 vault files (run: docker compose run --rm worker embed --all)` |

### Supporting changes

- **[scripts/lib/env.mjs](../../../scripts/lib/env.mjs)** — `resolveConfig` gains one field, `kbStateDir: env.KB_STATE_DIR ?? ""`. It stays a raw string so the file remains pure (no `path` import, no `repoRoot`).
- **[scripts/embed-vault.mjs](../../../scripts/embed-vault.mjs)** — export three symbols that doctor reuses: `listVaultFiles`, `DEFAULT_EMBED_EXTENSIONS`, `DEFAULT_EMBED_EXCLUDE_DIRS`. The recursive scan and the extension/exclude defaults become a single source of truth shared by `embed` and `doctor`, so the two can never drift on what counts as an embeddable file.

### Doctor interface

```js
doctor({
  config,
  fetchImpl = fetch,            // existing — covers mcp health + embedder probe
  runGit = runGitDefault,       // new — runs `git ls-remote`, injectable for tests
  readManifest = readManifestDefault,  // new — reads embed-manifest.json, injectable
})
```

`runGit` and `readManifest` have real default implementations and are injectable, mirroring the existing `fetchImpl` injection style so tests never touch real `git` or the disk unless they choose to (e.g. via a temp vault dir).

`stateDir` is resolved inside `doctor.mjs` (which already knows `repoRoot`): `config.kbStateDir ? path.resolve(repoRoot, config.kbStateDir) : path.resolve(repoRoot, ".anything-obsidian-state")` — identical to `extendConfig` in `embed-vault.mjs`, so a `KB_STATE_DIR` override is respected consistently by both.

### Compose healthchecks

Each uses `node`'s built-in `http` module so no `curl`/`wget` dependency is assumed (the MCP image is `node:22-alpine`; the AnythingLLM image is a node app). All share `interval: 30s`, `timeout: 5s`, `start_period: 60s`.

```yaml
anythingllm:
  healthcheck:
    test: ["CMD", "node", "-e", "require('http').get('http://localhost:3001/api/docs',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]

mcp:
  healthcheck:
    test: ["CMD", "node", "-e", "require('http').get('http://localhost:3333/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]

dashboard:
  healthcheck:
    test: ["CMD", "node", "-e", "require('http').get('http://localhost:3000/',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
```

The dashboard probes `/` (static `index.html`) rather than `/api/status`, because `/api/status` fans out to Docker socket calls that are needlessly heavy for a liveness probe.

The `syncer` gets no healthcheck (see Non-goals).

### Readiness ordering

`mcp` and `syncer` change from the list form of `depends_on` to the conditional form, so they wait for AnythingLLM to be healthy rather than merely started:

```yaml
depends_on:
  anythingllm:
    condition: service_healthy
```

This removes the startup error-loop where MCP and the syncer hammer AnythingLLM before it can serve.

## Files touched

- `scripts/doctor.mjs` — add four checks, `runGit` / `readManifest` defaults, `repoRoot`-based `stateDir` resolution.
- `scripts/lib/env.mjs` — add `kbStateDir` to `resolveConfig`.
- `scripts/embed-vault.mjs` — export `listVaultFiles`, `DEFAULT_EMBED_EXTENSIONS`, `DEFAULT_EMBED_EXCLUDE_DIRS` (no behavior change).
- `scripts/doctor.test.mjs` — new file; covers each new check with injected `fetchImpl` / `runGit` / `readManifest`.
- `docker-compose.yml` — add three healthchecks; switch `mcp` and `syncer` to `condition: service_healthy`.

Optional doc follow-up (not required for this change): mention `ANYTHINGLLM_MCP_BASE_URL` override and the new doctor checks in README / `docs/agent-mcp.md`.

## Testing

- New `scripts/doctor.test.mjs` uses `node --test`, injecting `fetchImpl` (MCP + embedder probes), `runGit` (git check), and `readManifest` (drift check) so no external process or real vault is required. Cases: each check passing, each check failing, drift empty-index, drift up-to-date, git check with no token configured.
- Existing suite (`scripts/*.test.mjs`, `dashboard/*.test.mjs`) must remain green — `embed-vault.mjs` only gains exports, no behavior change.
- Healthchecks are exercised manually via `docker compose up -d` + `docker compose ps` (status moves to `healthy`).

## Risks / rollout

- **AnythingLLM `/api/docs` as the health target** returns 200 once the HTTP server is up, which is exactly the readiness signal dependents need. It does not guarantee the DB / vector store is fully ready, but `start_period: 60s` plus the embedder-probe check in `doctor` cover the gap.
- **`depends_on: service_healthy`** means MCP and syncer will not start until AnythingLLM reports healthy. If AnythingLLM's healthcheck fails permanently, dependents stay down — which is the desired failure mode (surface it rather than error-loop).
- **Embedder probe issues one real vector-search per doctor run.** Doctor is invoked on demand (CLI / dashboard), not on the syncer's hot path, so the cost is negligible.
- Rollback is trivial: revert the compose changes to restore current boot behavior; doctor's new checks are additive and default-injected, so they cannot break existing callers.
