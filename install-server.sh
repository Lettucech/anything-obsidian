#!/bin/sh
# Server install for Anything Obsidian — a thin alias over install.sh.
# Use this on the machine that runs the IAM gateway for a shared AnythingLLM
# deployment: it configures for the gateway (--server), registers the
# gateway service, and leaves the client dashboard available but not
# auto-started. Everything else (flags, data layout, uninstall) is
# identical to install.sh.
set -eu

# From a checkout: run the sibling installer directly.
case "$0" in
  */*)
    DIR=$(dirname "$0")
    if [ -f "$DIR/install.sh" ]; then
      exec sh "$DIR/install.sh" --server "$@"
    fi
    ;;
esac

# Curl-piped (or standalone): fetch the installer and run it with --server.
REPO="${ANYTHING_OBSIDIAN_REPO:-Lettucech/anything-obsidian}"
BRANCH="${ANYTHING_OBSIDIAN_BRANCH:-main}"
curl -fsSL "https://raw.githubusercontent.com/$REPO/$BRANCH/install.sh" | sh -s -- --server "$@"
