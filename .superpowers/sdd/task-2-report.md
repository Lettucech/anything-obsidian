# Task 2 Report: Add Remote Bootstrap Script

## Status

Implemented.

## Changes

- Added root `install.sh`.
- The installer consumes `ANYTHING_OBSIDIAN_REPO`, `ANYTHING_OBSIDIAN_DIR`, and `ANYTHING_OBSIDIAN_BRANCH`.
- The installer supports `--dir PATH`, `--branch NAME`, `--no-tui`, `-h`, and `--help`.
- The installer requires `git` and `docker`, checks that Docker is running, then clones or updates the repo.
- The default setup path runs `./scripts/kb init`, then tries `go run ./installer` when Go is available.
- The fallback path runs `./scripts/kb init` and `./scripts/kb setup-fallback` when `--no-tui` is used, Go is missing, or TUI startup fails.

## Checks

```bash
bash -n install.sh
```

Result: exit code `0`.

```bash
./install.sh --help
```

Result: exit code `0`; printed:

```text
Usage: install.sh [--dir PATH] [--branch NAME] [--no-tui]

Installs or updates Anything Obsidian, then launches the guided setup.
```

## Notes

- No AnythingLLM API keys were generated or scraped.
- No `sudo` was used.
- No Node.js requirement was added for Docker-only setup.
- Daily operations remain in `scripts/kb`.
- `installer/` does not exist yet, so the Go TUI branch currently falls back to `./scripts/kb setup-fallback` if reached.
- Unrelated `.codex/` and `docs/superpowers/` worktree changes were left untouched.
