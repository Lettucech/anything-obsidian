# Git-Aware Auto Pull (dirs can be checkouts)

Date: 2026-11-05
Status: implemented (uncommitted at time of writing)
Depends on: 2026-11-02-client-server-simplification.md (server sources live
in the merged app process)

## Problem

any-obs tied "where the folder lives" to "whether it syncs with git", but
the two are independent facts. Most real vaults are git checkouts.

- **Server shared sources**: a `kind: "dir"` source (an absolute directory
  the operator owns) was never pulled — only `kind: "git"` sources (clones
  any-obs itself manages under `gateway/sources/`) were refreshed. A dir
  source pointing at a checkout went stale forever: teammates push, the
  index never sees it.
- **Client vaults**: `imported` vaults defaulted `gitAutoPull: false`
  (`syncByDefault = location === "managed"`). The MCP/API import path omits
  the field, so agent-registered imports never pulled. The dashboard form
  sent `gitAutoPull: true` (the checkbox is pre-ticked) — so the UI, the
  stored default, and the on-screen copy ("auto-sync stays off") all told
  different stories.
- **No `.git` guard**: `syncVaultOnce` pulled whenever `gitAutoPull` was
  set, even for plain folders, failing every sync tick with a git error.

Reported live on the 227 serving instance (team-kb dir source): "auto git
pull 唔 work，冇叫我入 credentials" — the credentials question is the tell:
a dir source is *the user's* checkout; it already has its own origin URL
and the host already has its credential helpers. any-obs only needs to
run the pull.

## Rule

**Sync ticks check whether the target directory is a git repo and pull if
it is — client vaults and server dir sources alike.** Location flavour and
git-ness are independent.

- Pull strategy: `git pull --rebase --autostash` everywhere the checkout
  belongs to the user (client vaults, server dir sources) — tolerates
  uncommitted edits in a working copy someone else owns. `kind: "git"`
  server-managed clones keep `--ff-only` (any-obs owns them; no local
  edits expected).
- Detection: `.git` exists (file or directory — worktrees) via `access`.
- Credentials: never injected. The repo's own `.git/config` origin plus
  the host's ambient git credential resolution (keychain, store, SSH keys)
  decides. `GIT_TERMINAL_PROMPT=0` means an unanswerable auth fails fast
  and surfaces as the job's `lastError`.

## Behavior change

- Client `syncVaultOnce`: pulls only when `gitAutoPull` **and** a `.git`
  entry exists. A plain imported folder with the box ticked now syncs
  (commit/embed) instead of failing on the pull.
- Client import (dashboard POST /api/vaults — the single path shared by
  the web form and MCP `any_obs_vault_add`): when `import()` discovers the
  directory is a checkout, `gitAutoPull` defaults **on**. An explicit
  value in the request still wins. Managed vaults are unchanged (always
  sync). No migration: no existing record carries the old imported default
  `false` unintentionally (both live vaults already had `true`).
- Server `refreshWorkingCopy`: a `dir` source with `.git` is pulled before
  embedding; without `.git`, files are read as before. Pull failure fails
  the refresh job with the git stderr (visible in the console row).
- No opt-out flag was added for dir sources; add one only if a real case
  appears.

## Files

- `server/sources.mjs` — dir-source pull + `isGitRepository` helper
- `scripts/watch-vault.mjs` — `.git` gate (`deps.hasGit` injectable)
- `dashboard/vault-storage.mjs` — `import()` reports `hasGit`
- `dashboard/server.mjs` — default flip on import
- `dashboard/public/{app.js,index.html}`, `server/dashboard/app.js` —
  copy now matches behavior
- Tests: `scripts/watch-vault.test.mjs`, `dashboard/vault-storage.test.mjs`,
  `dashboard/server.test.mjs`, `server/sources.test.mjs`
