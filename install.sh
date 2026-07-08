#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${ANYTHING_OBSIDIAN_REPO:-https://github.com/pingkiuho/anything-obsidian.git}"
INSTALL_DIR="${ANYTHING_OBSIDIAN_DIR:-$HOME/anything-obsidian}"
BRANCH="${ANYTHING_OBSIDIAN_BRANCH:-main}"
USE_TUI=1

usage() {
  cat <<'USAGE'
Usage: install.sh [--dir PATH] [--branch NAME] [--no-tui]

Installs or updates Anything Obsidian, then launches the guided setup.
USAGE
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --dir)
      INSTALL_DIR="${2:?Missing path after --dir}"
      shift 2
      ;;
    --branch)
      BRANCH="${2:?Missing branch after --branch}"
      shift 2
      ;;
    --no-tui)
      USE_TUI=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

need git
need docker

if ! docker info >/dev/null 2>&1; then
  echo "Docker is installed but not running. Start Docker Desktop, then rerun this installer." >&2
  exit 1
fi

if [[ -d "$INSTALL_DIR/.git" ]]; then
  git -C "$INSTALL_DIR" fetch origin "$BRANCH"
  git -C "$INSTALL_DIR" checkout "$BRANCH"
  git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
else
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

if [[ "$USE_TUI" -eq 0 ]]; then
  ./scripts/kb init
  ./scripts/kb setup-fallback
  exit 0
fi

if command -v go >/dev/null 2>&1; then
  ./scripts/kb init
  go run ./installer || ./scripts/kb setup-fallback
else
  echo "Go is not installed; falling back to manual setup steps."
  ./scripts/kb init
  ./scripts/kb setup-fallback
fi
