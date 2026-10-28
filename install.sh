#!/bin/sh
# Anything Obsidian one-command installer.
#
#   curl -fsSL https://raw.githubusercontent.com/Lettucech/anything-obsidian/main/install.sh | sh
#
# Non-interactive (agent) mode — provide all three and nothing is prompted:
#   install.sh --vaults-root <path> --url <anythingllm-url> --api-key <key> [--port <n>] [--no-browser]
#
# Layout it creates:
#   ~/.anything-obsidian/app       the application (downloaded from GitHub)
#   ~/.anything-obsidian/runtime   a portable Node.js, only if the system has no node >= 22
#   ~/.local/bin/anything-obsidian CLI launcher
#
# Data (config, secrets, registry) lives separately under the OS app-support
# directory and is never removed by this script. See uninstall.sh.
set -eu

REPO="${ANYTHING_OBSIDIAN_REPO:-Lettucech/anything-obsidian}"
BRANCH="${ANYTHING_OBSIDIAN_BRANCH:-main}"
APP_ROOT="${ANYTHING_OBSIDIAN_APP_HOME:-$HOME/.anything-obsidian}"
APP_DIR="$APP_ROOT/app"
RUNTIME_DIR="$APP_ROOT/runtime"
BIN_DIR="$HOME/.local/bin"
NODE_VERSION="${ANYTHING_OBSIDIAN_NODE_VERSION:-22.14.0}"
SELF_URL="https://raw.githubusercontent.com/$REPO/$BRANCH/install.sh"

say() { printf '%s\n' "$*"; }
warn() { printf '!! %s\n' "$*" >&2; }
die() { warn "$*"; exit 1; }

usage() {
  cat << 'USAGE_EOF'
Anything Obsidian installer

Interactive (default):
  install.sh

Non-interactive (agent) mode — provide all three, nothing is prompted:
  install.sh --vaults-root <path> --url <anythingllm-url> --api-key <key> [--port <n>]

Options:
  --no-browser    do not open the browser when done
  --no-skills     skip installing agent skills into detected skill directories
  --no-autostart  do not register login auto-start / crash auto-restart
                  (macOS: LaunchAgents; Linux: systemd user units)

Environment overrides:
  ANYTHING_OBSIDIAN_APP_HOME     where the app lives (default ~/.anything-obsidian)
  ANYTHING_OBSIDIAN_HOME         where data/config lives (default OS app-support dir)
  ANYTHING_OBSIDIAN_NODE_VERSION portable node version (default 22.14.0)
  ANYTHING_OBSIDIAN_REPO         GitHub repo slug (default Lettucech/anything-obsidian)
  ANYTHING_OBSIDIAN_BRANCH       branch/tag to install (default main)
USAGE_EOF
}

# ---------- when piped, re-exec from a real file so prompts work ----------
# Runs before flag parsing so "$@" is still intact. The env guard prevents
# the re-executed instance from re-execing again.
if [ ! -t 0 ] && [ -z "${AO_INSTALLER_EXECED:-}" ]; then
  if [ -r "$0" ] && [ -s "$0" ] && [ "$0" != "/dev/stdin" ]; then SCRIPT_FILE="$0";
  else
    SCRIPT_FILE="$APP_ROOT/install.$$.sh"
    mkdir -p "$APP_ROOT"
    curl -fsSL "$SELF_URL" -o "$SCRIPT_FILE" || die "Could not download the installer. Check your network and try again."
  fi
  if ( : </dev/tty ) 2>/dev/null; then STDIN_SRC="/dev/tty"; else STDIN_SRC="/dev/null"; fi
  AO_INSTALLER_EXECED=1
  export AO_INSTALLER_EXECED
  exec sh "$SCRIPT_FILE" "$@" <"$STDIN_SRC"
fi

# ---------- flags ----------
VAULTS_ROOT=""; URL=""; API_KEY=""; PORT=""; NO_BROWSER=0; NO_SKILLS=0; NO_AUTOSTART=0; WANT_HELP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --vaults-root) VAULTS_ROOT="${2:?}"; shift 2 ;;
    --url) URL="${2:?}"; shift 2 ;;
    --api-key) API_KEY="${2:?}"; shift 2 ;;
    --port) PORT="${2:?}"; shift 2 ;;
    --no-browser) NO_BROWSER=1; shift ;;
    --no-skills) NO_SKILLS=1; shift ;;
    --no-autostart) NO_AUTOSTART=1; shift ;;
    --help|-h) WANT_HELP=1; shift ;;
    *) die "Unknown option: $1" ;;
  esac
done

if [ "$WANT_HELP" -eq 1 ]; then usage; exit 0; fi

NON_INTERACTIVE=0
if [ -n "$VAULTS_ROOT" ] && [ -n "$URL" ] && [ -n "$API_KEY" ]; then NON_INTERACTIVE=1; fi

# ---------- platform ----------
OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS-$ARCH" in
  Darwin-arm64) NODE_TARGET="darwin-arm64" ;;
  Darwin-x86_64) NODE_TARGET="darwin-x64" ;;
  Linux-x86_64) NODE_TARGET="linux-x64" ;;
  Linux-aarch64|Linux-arm64) NODE_TARGET="linux-arm64" ;;
  *) die "Unsupported platform: $OS $ARCH — Anything Obsidian needs macOS or Linux (on Windows, use WSL)." ;;
esac

say "Anything Obsidian installer"
say "  platform: $OS $ARCH"
say ""

# ---------- node ----------
find_node() {
  if command -v node >/dev/null 2>&1; then
    major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
    if [ "$major" -ge 22 ]; then command -v node; return 0; fi
  fi
  for candidate in "$RUNTIME_DIR"/node-v*/bin/node; do
    if [ -x "$candidate" ]; then echo "$candidate"; return 0; fi
  done
  return 1
}

NODE_BIN="$(find_node || true)"
if [ -z "$NODE_BIN" ]; then
  TARBALL="node-v$NODE_VERSION-$NODE_TARGET.tar.gz"
  NODE_URL="https://nodejs.org/dist/v$NODE_VERSION/$TARBALL"
  say "  system node is missing or older than 22 (unsupported/EOL); downloading portable Node.js v$NODE_VERSION ($NODE_TARGET)…"
  mkdir -p "$RUNTIME_DIR"
  curl -fsSL "$NODE_URL" | tar -xz -C "$RUNTIME_DIR" || die "Could not download Node.js from $NODE_URL"
  NODE_BIN="$RUNTIME_DIR/node-v$NODE_VERSION-$NODE_TARGET/bin/node"
  [ -x "$NODE_BIN" ] || die "Downloaded Node.js is not runnable at $NODE_BIN"
  say "  ✓ portable node ready"
else
  say "  ✓ node: $("$NODE_BIN" --version)"
fi

# ---------- git ----------
if ! command -v git >/dev/null 2>&1; then
  if [ "$OS" = "Darwin" ]; then
    die "git was not found. Run: xcode-select --install   then re-run this installer."
  else
    die "git was not found. Install git with your package manager (e.g. apt install git) and re-run."
  fi
fi
say "  ✓ git: $(git --version | sed 's/^git version /git /')"

# ---------- app ----------
say "  downloading the app from github.com/$REPO ($BRANCH)…"
STAGING="$APP_ROOT/download.$$"
mkdir -p "$STAGING"
curl -fsSL "https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz" | tar -xz -C "$STAGING" \
  || die "Could not download the repository. Check github.com/$REPO is reachable."
SOURCE_DIR="$(find "$STAGING" -maxdepth 1 -mindepth 1 -type d | head -1)"
if [ -z "$SOURCE_DIR" ]; then die "Downloaded archive was empty."; fi
rm -rf "$APP_DIR"
mv "$SOURCE_DIR" "$APP_DIR"
rm -rf "$STAGING"
say "  ✓ app installed: $APP_DIR"

# ---------- dependencies (MCP server runtime) ----------
if (cd "$APP_DIR" && "$NODE_BIN" "$APP_DIR/node_modules/../package.json" >/dev/null 2>&1); then :; fi
NPM_CLI=""
for candidate in "$(dirname "$NODE_BIN")/npm" "$(dirname "$NODE_BIN")/../lib/node_modules/npm/bin/npm-cli.js"; do
  if [ -f "$candidate" ]; then NPM_CLI="$candidate"; break; fi
done
if [ -n "$NPM_CLI" ] && [ ! -d "$APP_DIR/node_modules" ]; then
  say "  installing dependencies (MCP server)…"
  if (cd "$APP_DIR" && "$NODE_BIN" "$NPM_CLI" ci --omit=dev --no-audit --no-fund >/dev/null 2>&1); then
    say "  ✓ dependencies installed"
  else
    warn "Dependency install failed — the dashboard and sync still work, but MCP endpoints will not."
    warn "Retry any time: cd $APP_DIR && npm ci --omit=dev"
  fi
fi

# ---------- CLI launcher ----------
LAUNCHER="$BIN_DIR/anything-obsidian"
mkdir -p "$BIN_DIR"
cat > "$LAUNCHER" << LAUNCHER_EOF
#!/bin/sh
# Anything Obsidian CLI launcher (managed by install.sh / uninstall.sh)
AO_APP="$APP_DIR"
AO_RUNTIME="$RUNTIME_DIR"
if command -v node >/dev/null 2>&1; then
  exec "\$(command -v node)" "\$AO_APP/bin/anything-obsidian.mjs" "\$@"
fi
for candidate in "\$AO_RUNTIME"/node-v*/bin/node; do
  if [ -x "\$candidate" ]; then exec "\$candidate" "\$AO_APP/bin/anything-obsidian.mjs" "\$@"; fi
done
echo "anything-obsidian: no node found; re-run the installer." >&2
exit 1
LAUNCHER_EOF
chmod +x "$LAUNCHER"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    PROFILE="$HOME/.zshrc"
    if [ -n "${SHELL:-}" ]; then
      case "$SHELL" in
        *bash) PROFILE="$HOME/.bashrc" ;;
      esac
    fi
    {
      printf '\n# >>> anything-obsidian >>>\n'
      printf 'export PATH="$HOME/.local/bin:$PATH"\n'
      printf '# <<< anything-obsidian <<<\n'
    } >> "$PROFILE"
    say "  ✓ added $BIN_DIR to PATH in $PROFILE (new terminals pick this up)"
    ;;
esac
say "  ✓ CLI ready: $LAUNCHER"

# ---------- agent skills ----------
SKILL_TARGETS=""
for skills_dir in "$HOME/.zcode/skills" "$HOME/.agents/skills" "$HOME/.claude/skills"; do
  if [ -d "$skills_dir" ]; then SKILL_TARGETS="$SKILL_TARGETS $skills_dir"; fi
done
if [ "$NO_SKILLS" -eq 0 ] && [ -n "$SKILL_TARGETS" ]; then
  INSTALL_SKILLS=1
  if [ "$NON_INTERACTIVE" -ne 1 ]; then
    printf 'Install the agent skills (setup + vault workflow) into:%s? [Y/n] ' "$SKILL_TARGETS"
    answer=""
    read answer < /dev/tty 2>/dev/null || answer=""
    case "$answer" in n|N|no|No|NO) INSTALL_SKILLS=0 ;; esac
  fi
  if [ "$INSTALL_SKILLS" -eq 1 ]; then
    for skills_dir in $SKILL_TARGETS; do
      for skill in anything-obsidian-setup anything-obsidian-vault-workflow; do
        rm -rf "$skills_dir/$skill"
        cp -R "$APP_DIR/skills/$skill" "$skills_dir/$skill"
      done
    done
    say "  ✓ agent skills installed into:$SKILL_TARGETS"
  fi
fi

# ---------- init ----------
if [ "$NON_INTERACTIVE" -eq 1 ]; then
  INIT_ARGS="--vaults-root $VAULTS_ROOT --url $URL --api-key $API_KEY"
  if [ -n "$PORT" ]; then INIT_ARGS="$INIT_ARGS --port $PORT"; fi
  say ""
  say "Configuring (non-interactive)…"
  "$LAUNCHER" init $INIT_ARGS || die "Setup failed. Fix the problem above and re-run: $LAUNCHER init"
else
  say ""
  say "Now a few questions to finish setup (AnythingLLM URL and API key; see the README):"
  "$LAUNCHER" init || die "Setup failed. Re-run it any time with: $LAUNCHER init"
fi

# ---------- start ----------
say ""
DASH_PORT="$PORT"
if [ -z "$DASH_PORT" ]; then DASH_PORT=21502; fi
open_dashboard_in_browser() {
  if [ "$NO_BROWSER" -eq 1 ]; then return 0; fi
  if command -v open >/dev/null 2>&1; then open "http://localhost:$DASH_PORT" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "http://localhost:$DASH_PORT" >/dev/null 2>&1 || true
  fi
}

AUTOSTART=1
if [ "$NO_AUTOSTART" -eq 1 ]; then AUTOSTART=0; fi
if [ "$AUTOSTART" -eq 1 ] && [ "$NON_INTERACTIVE" -ne 1 ]; then
  printf 'Keep the dashboard and sync running at login (auto-restart on crash)? [Y/n] '
  answer=""
  read answer < /dev/tty 2>/dev/null || answer=""
  case "$answer" in n|N|no|No|NO) AUTOSTART=0 ;; esac
fi

if [ "$AUTOSTART" -eq 1 ]; then
  if "$LAUNCHER" autostart on; then
    open_dashboard_in_browser
    say ""
    say "Installed. The dashboard is at http://localhost:$DASH_PORT and stays running:"
    say "it starts at every login and restarts automatically if it crashes."
    say "Useful commands:"
    say "  anything-obsidian status        health + setup check"
    say "  anything-obsidian stop          stop now (comes back at next login)"
    say "  anything-obsidian autostart off stop permanently"
    say "Uninstall any time:"
    say "  curl -fsSL https://raw.githubusercontent.com/$REPO/$BRANCH/uninstall.sh | sh"
  else
    warn "Autostart failed; falling back to a plain background start."
    "$LAUNCHER" start --bg || { warn "The dashboard did not start. Re-run: anything-obsidian start"; exit 1; }
    open_dashboard_in_browser
    say "Installed. The dashboard is at http://localhost:$DASH_PORT"
  fi
else
  if "$LAUNCHER" start --bg; then
    open_dashboard_in_browser
    say ""
    say "Installed. The dashboard is at http://localhost:$DASH_PORT"
    say "Keep vault sync running in the background with: anything-obsidian start-bg"
    say "Turn on auto-restart any time with: anything-obsidian autostart on"
  else
    CONFIG_HINT="${ANYTHING_OBSIDIAN_HOME:-$HOME/Library/Application Support/anything-obsidian}"
    if [ "$OS" != "Darwin" ]; then CONFIG_HINT="${ANYTHING_OBSIDIAN_HOME:-$HOME/.config/anything-obsidian}"; fi
    warn "The dashboard did not start. Check: $CONFIG_HINT/logs/dashboard.log"
    warn "Re-run: anything-obsidian start"
    exit 1
  fi
fi
