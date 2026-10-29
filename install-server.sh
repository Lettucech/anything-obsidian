#!/bin/sh
# Server install for Anything Obsidian — a thin alias over install.sh.
# Use this on the machine that runs the IAM gateway for a shared AnythingLLM
# deployment: it configures for the gateway, registers the gateway service,
# and leaves the client dashboard available-but-not-autostarted.
# Everything else (flags, data layout, uninstall) is identical.
REPO="${ANYTHING_OBSIDIAN_REPO:-Lettucech/anything-obsidian}"
BRANCH="${ANYTHING_OBSIDIAN_BRANCH:-main}"
exec sh -c "curl -fsSL https://raw.githubusercontent.com/$REPO/$BRANCH/install.sh" install-server.sh --server "$@"
