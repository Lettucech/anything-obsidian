#!/bin/sh
# Anything Obsidian uninstaller.
#
#   curl -fsSL https://raw.githubusercontent.com/Lettucech/anything-obsidian/main/uninstall.sh | sh
#
# Stops the dashboard and scheduler, removes the app, the CLI launcher, and the
# PATH entry it added. Your data (config, secrets, vault registry) is KEPT by
# default; pass --purge-data to remove it too. Your vault folders (the actual
# notes, e.g. ~/ObsidianVaults) are never deleted — their location is printed
# at the end so you can remove them yourself.
#
# Flags:
#   --purge-data   also delete the data directory (config, secrets, registry, logs)
#   --yes          no prompts (agent mode); data is kept unless --purge-data is given
set -eu

APP_ROOT="${ANYTHING_OBSIDIAN_APP_HOME:-$HOME/.anything-obsidian}"
BIN_DIR="$HOME/.local/bin"
LAUNCHER="$BIN_DIR/anything-obsidian"
REPO="${ANYTHING_OBSIDIAN_REPO:-Lettucech/anything-obsidian}"
BRANCH="${ANYTHING_OBSIDIAN_BRANCH:-main}"

say() { printf '%s\n' "$*"; }

# ---------- when piped, re-exec from a real file (before flag parsing so "$@" stays intact) ----------
if [ ! -t 0 ] && [ -z "${AO_UNINSTALLER_EXECED:-}" ]; then
  if [ -r "$0" ] && [ -s "$0" ] && [ "$0" != "/dev/stdin" ]; then SCRIPT_FILE="$0";
  else
    SCRIPT_FILE="$APP_ROOT/uninstall.$$.sh"
    mkdir -p "$APP_ROOT" 2>/dev/null || mkdir -p "$HOME/.anything-obsidian"
    curl -fsSL "https://raw.githubusercontent.com/$REPO/$BRANCH/uninstall.sh" -o "$SCRIPT_FILE" \
      || { printf '!! Could not download the uninstaller.\n' >&2; exit 1; }
  fi
  if ( : </dev/tty ) 2>/dev/null; then STDIN_SRC="/dev/tty"; else STDIN_SRC="/dev/null"; fi
  AO_UNINSTALLER_EXECED=1
  export AO_UNINSTALLER_EXECED
  exec sh "$SCRIPT_FILE" "$@" <"$STDIN_SRC"
fi

PURGE_DATA=0; ASSUME_YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --purge-data) PURGE_DATA=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --help|-h)
      sed -n '2,17p' "$0" 2>/dev/null || echo "Usage: uninstall.sh [--purge-data] [--yes]"
      exit 0 ;;
    *) printf '!! Unknown option: %s\n' "$1" >&2; exit 1 ;;
  esac
done

# ---------- locate the data directory ----------
DATA_DIR="${ANYTHING_OBSIDIAN_HOME:-}"
if [ -z "$DATA_DIR" ]; then
  case "$(uname -s)" in
    Darwin) DATA_DIR="$HOME/Library/Application Support/anything-obsidian" ;;
    *) DATA_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/anything-obsidian" ;;
  esac
fi

VAULTS_ROOT=""
if [ -f "$DATA_DIR/config.json" ]; then
  VAULTS_ROOT="$(sed -n 's/.*"vaultsRoot"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$DATA_DIR/config.json" | head -1)"
fi

say "Anything Obsidian uninstaller"

# ---------- stop launchd services (they may own the processes) ----------
UID_NUM="$(id -u)"
for label in app.anything-obsidian.dashboard app.anything-obsidian.scheduler; do
  plist="$HOME/Library/LaunchAgents/$label.plist"
  if [ -f "$plist" ]; then
    launchctl bootout "gui/$UID_NUM/$label" >/dev/null 2>&1 || true
    rm -f "$plist"
    say "  removed LaunchAgent $label"
  fi
done

# ---------- stop processes ----------
stop_pid_file() {
  pid_file="$1"
  if [ -f "$pid_file" ]; then
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    case "$pid" in
      ''|*[!0-9]*) rm -f "$pid_file"; return 0 ;;
    esac
    if kill -0 "$pid" 2>/dev/null; then
      say "  stopping pid $pid ($(basename "$(dirname "$pid_file")"))"
      kill "$pid" 2>/dev/null || true
      waited=0
      while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 50 ]; do
        waited=$((waited + 1))
        sleep 0.1 2>/dev/null || sleep 1
      done
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$pid_file"
  fi
}

if [ -d "$DATA_DIR/run" ]; then
  stop_pid_file "$DATA_DIR/run/dashboard.pid"
  stop_pid_file "$DATA_DIR/run/scheduler.pid"
fi

# ---------- remove launcher + PATH ----------
if [ -L "$LAUNCHER" ] || [ -f "$LAUNCHER" ]; then
  rm -f "$LAUNCHER"
  say "  removed $LAUNCHER"
fi
for profile in "$HOME/.zshrc" "$HOME/.zprofile" "$HOME/.bashrc" "$HOME/.bash_profile"; do
  if [ -f "$profile" ] && grep -q '# >>> anything-obsidian >>>' "$profile"; then
    tmp="$profile.ao-uninstall.$$"
    sed '/# >>> anything-obsidian >>>/,/# <<< anything-obsidian <<</d' "$profile" > "$tmp" && mv "$tmp" "$profile"
    say "  removed PATH entry from $profile"
  fi
done

# ---------- remove app + runtime ----------
if [ -d "$APP_ROOT" ]; then
  rm -rf "$APP_ROOT"
  say "  removed $APP_ROOT"
fi

# ---------- data ----------
if [ "$PURGE_DATA" -ne 1 ] && [ "$ASSUME_YES" -ne 1 ]; then
  printf 'Keep your settings, secrets, and registry at %s? [Y/n] ' "$DATA_DIR"
  answer=""
  read answer < /dev/tty 2>/dev/null || answer=""
  case "$answer" in n|N|no|No|NO) PURGE_DATA=1 ;; esac
fi
if [ "$PURGE_DATA" -eq 1 ]; then
  if [ -d "$DATA_DIR" ]; then
    rm -rf "$DATA_DIR"
    say "  removed data: $DATA_DIR"
  fi
else
  say "  kept data: $DATA_DIR (remove it later with --purge-data)"
fi

say ""
say "Uninstalled."
for skills_dir in "$HOME/.zcode/skills" "$HOME/.agents/skills" "$HOME/.claude/skills"; do
  if [ -d "$skills_dir/anything-obsidian-setup" ] || [ -d "$skills_dir/anything-obsidian-vault-workflow" ]; then
    say "Agent skill copies were kept at $skills_dir — remove them with rm -rf if unwanted."
  fi
done
if [ -n "$VAULTS_ROOT" ] && [ -d "$VAULTS_ROOT" ]; then
  say ""
  say "Your vault folders were NOT touched. They live in:"
  say "  $VAULTS_ROOT"
  say "Delete them yourself if you no longer want the notes."
fi
