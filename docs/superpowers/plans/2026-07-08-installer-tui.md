# Installer TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a user-friendly `curl | bash` installer that bootstraps Anything Obsidian, then launches a TUI to configure `.env`, start AnythingLLM, collect the user-created API key, verify it, and start MCP.

**Architecture:** Keep Bash as the remote bootstrap and low-level service wrapper. Add a small Go TUI as the guided first-run installer, using existing Docker Compose files and `scripts/kb` commands instead of duplicating service logic.

**Tech Stack:** Bash, Docker Compose, Go, Bubble Tea, Lip Gloss, Bubbles, existing `scripts/kb`, existing Docker Compose files.

## Global Constraints

- Do not auto-generate or scrape AnythingLLM API keys unless AnythingLLM exposes a stable official bootstrap API.
- Do not use `sudo`.
- Do not require Node.js for Docker-only setup.
- `install.sh` must be safe for `curl -fsSL ... | bash`.
- The TUI must support macOS and Linux terminals.
- Daily operations stay in `scripts/kb`.
- The installer may add Go dependencies because TUI support is an explicit product requirement.
- Keep a Bash fallback path that prints manual next steps if Go or TUI startup fails.

---

## File Structure

- Create `install.sh`: remote bootstrap entrypoint; clones or updates the repo and runs the repo-local installer.
- Modify `scripts/kb`: add small reusable commands that the TUI can call: `set-env`, `verify-key`, `url`, and `setup-fallback`.
- Create `installer/go.mod`: Go module for the installer TUI.
- Create `installer/main.go`: TUI entrypoint, state machine, command execution, `.env` update calls through `scripts/kb`.
- Create `installer/main_test.go`: unit tests for pure validation helpers and command construction.
- Modify `README.md`: replace the long first-run path with the new install command, keep manual path as fallback.
- Modify `docs/agent-mcp.md`: document that MCP starts through installer or `scripts/kb start-mcp`.

## Task 1: Add Script Primitives For Installer Reuse

**Files:**
- Modify: `scripts/kb`

**Interfaces:**
- Consumes: existing `compose`, `compose_mcp`, `load_env`, and `ensure_env`.
- Produces:
  - `./scripts/kb set-env KEY VALUE`
  - `./scripts/kb url anythingllm`
  - `./scripts/kb url mcp`
  - `./scripts/kb verify-key`
  - `./scripts/kb setup-fallback`

- [x] **Step 1: Add helpers to `scripts/kb` before the `case` block**

```bash
set_env_value() {
  key="$1"
  value="$2"
  tmp="$(mktemp)"

  if [[ ! "$key" =~ ^[A-Z0-9_]+$ ]]; then
    echo "Invalid env key: $key" >&2
    exit 2
  fi

  if [[ -f .env ]] && grep -q "^${key}=" .env; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      case "$line" in
        "${key}="*) printf '%s=%s\n' "$key" "$value" ;;
        *) printf '%s\n' "$line" ;;
      esac
    done < .env > "$tmp"
  else
    [[ -f .env ]] && cp .env "$tmp"
    printf '%s=%s\n' "$key" "$value" >> "$tmp"
  fi

  mv "$tmp" .env
}

anythingllm_url() {
  load_env
  printf 'http://localhost:%s\n' "${HOST_ANYTHINGLLM_PORT:-11301}"
}

mcp_url() {
  load_env
  printf 'http://localhost:%s/mcp\n' "${HOST_MCP_PORT:-11333}"
}

verify_api_key() {
  ensure_env
  load_env
  if [[ -z "${ANYTHINGLLM_API_KEY:-}" ]]; then
    echo "ANYTHINGLLM_API_KEY is empty." >&2
    exit 1
  fi

  anythingllm_base_url="${ANYTHINGLLM_BASE_URL:-http://localhost:${HOST_ANYTHINGLLM_PORT:-11301}}"
  curl --fail --silent --show-error \
    -H "Authorization: Bearer ${ANYTHINGLLM_API_KEY}" \
    "${anythingllm_base_url}${ANYTHINGLLM_WORKSPACES_PATH:-/api/v1/workspaces}" >/dev/null
}
```

- [x] **Step 2: Add usage text**

Add these lines under `Commands:`:

```text
  set-env KEY VALUE Set or append a value in .env
  url TARGET        Print service URL: anythingllm or mcp
  verify-key        Check AnythingLLM API key access
  setup-fallback    Print manual first-run steps
```

- [x] **Step 3: Add `case` commands**

```bash
  set-env)
    ensure_env
    if [[ "$#" -ne 3 ]]; then
      echo "Usage: ./scripts/kb set-env KEY VALUE" >&2
      exit 2
    fi
    set_env_value "$2" "$3"
    ;;
  url)
    case "${2:-}" in
      anythingllm) anythingllm_url ;;
      mcp) mcp_url ;;
      *)
        echo "Usage: ./scripts/kb url anythingllm|mcp" >&2
        exit 2
        ;;
    esac
    ;;
  verify-key)
    verify_api_key
    echo "AnythingLLM API key is valid."
    ;;
  setup-fallback)
    ensure_env
    echo "1. Run: ./scripts/kb start"
    echo "2. Open: $(anythingllm_url)"
    echo "3. Finish AnythingLLM setup and create an API key."
    echo "4. Run: ./scripts/kb set-env ANYTHINGLLM_API_KEY <key>"
    echo "5. Run: ./scripts/kb start-mcp"
    echo "6. Run: ./scripts/kb verify"
    ;;
```

- [x] **Step 4: Run the smallest checks**

Run:

```bash
bash -n scripts/kb
```

Expected: exit code `0`.

Run in a temporary copy:

```bash
tmp="$(mktemp -d)"
cp scripts/kb .env.example "$tmp/"
cd "$tmp"
cp .env.example .env
./kb set-env ANYTHINGLLM_API_KEY test-key
grep '^ANYTHINGLLM_API_KEY=test-key$' .env
```

Expected: grep prints `ANYTHINGLLM_API_KEY=test-key`.

## Task 2: Add Remote Bootstrap Script

**Files:**
- Create: `install.sh`

**Interfaces:**
- Consumes: public GitHub repo URL, optional `ANYTHING_OBSIDIAN_DIR`, optional `ANYTHING_OBSIDIAN_BRANCH`.
- Produces: `./install.sh [--dir PATH] [--branch NAME] [--no-tui]`.

- [x] **Step 1: Create `install.sh`**

```bash
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
```

- [x] **Step 2: Make it executable**

Run:

```bash
chmod +x install.sh
```

- [x] **Step 3: Run syntax and help checks**

Run:

```bash
bash -n install.sh
./install.sh --help
```

Expected: syntax check passes; help prints usage without cloning or starting services.

## Task 3: Add Go TUI Installer

**Files:**
- Create: `installer/go.mod`
- Create: `installer/main.go`
- Create: `installer/main_test.go`

**Interfaces:**
- Consumes: `./scripts/kb init`, `start`, `set-env`, `verify-key`, `start-mcp`, `start-sync`, `url`.
- Produces: guided installer TUI run with `go run ./installer`.

- [x] **Step 1: Create Go module**

Run:

```bash
cd installer
go mod init github.com/pingkiuho/anything-obsidian/installer
go get github.com/charmbracelet/bubbles github.com/charmbracelet/bubbletea github.com/charmbracelet/lipgloss
```

- [x] **Step 2: Implement the TUI state machine**

Create `installer/main.go` with:

```go
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/bubbles/textinput"
	"github.com/charmbracelet/lipgloss"
)

type step int

const (
	stepVaultPath step = iota
	stepPorts
	stepStartAnythingLLM
	stepAPIKey
	stepStartMCP
	stepStartSync
	stepDone
)

type model struct {
	step       step
	input      textinput.Model
	vaultPath  string
	anyPort    string
	mcpPort    string
	apiKey     string
	startSync  bool
	message    string
	err        error
}

var titleStyle = lipgloss.NewStyle().Bold(true)

func main() {
	m := initialModel()
	if _, err := tea.NewProgram(m).Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func initialModel() model {
	input := textinput.New()
	input.Focus()
	input.Placeholder = defaultVaultPath()
	input.SetValue(defaultVaultPath())
	return model{
		step:    stepVaultPath,
		input:   input,
		anyPort: "11301",
		mcpPort: "11333",
	}
}

func (m model) Init() tea.Cmd {
	return nil
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c", "esc":
			return m, tea.Quit
		case "enter":
			return m.next()
		case "y":
			if m.step == stepStartSync {
				m.startSync = true
				return m.next()
			}
		case "n":
			if m.step == stepStartSync {
				m.startSync = false
				return m.next()
			}
		}
	}

	var cmd tea.Cmd
	m.input, cmd = m.input.Update(msg)
	return m, cmd
}

func (m model) View() string {
	var b strings.Builder
	b.WriteString(titleStyle.Render("Anything Obsidian setup"))
	b.WriteString("\n\n")
	if m.message != "" {
		b.WriteString(m.message)
		b.WriteString("\n\n")
	}
	if m.err != nil {
		b.WriteString("Error: " + m.err.Error() + "\n\n")
	}

	switch m.step {
	case stepVaultPath:
		b.WriteString("Vault path:\n")
		b.WriteString(m.input.View())
		b.WriteString("\n\nPress enter to continue.")
	case stepPorts:
		b.WriteString("Ports use defaults: AnythingLLM 11301, MCP 11333.\n")
		b.WriteString("Press enter to accept.")
	case stepStartAnythingLLM:
		b.WriteString("Press enter to create .env and start AnythingLLM.")
	case stepAPIKey:
		b.WriteString("Open AnythingLLM, finish setup, create an API key, then paste it here.\n")
		b.WriteString("URL: http://localhost:" + m.anyPort + "\n\n")
		b.WriteString(m.input.View())
	case stepStartMCP:
		b.WriteString("Press enter to verify the API key and start MCP.")
	case stepStartSync:
		b.WriteString("Start auto sync watcher now? y/n")
	case stepDone:
		b.WriteString("Setup complete.\n")
		b.WriteString("AnythingLLM: http://localhost:" + m.anyPort + "\n")
		b.WriteString("MCP: http://localhost:" + m.mcpPort + "/mcp\n")
		b.WriteString("\nPress enter to exit.")
	}

	return b.String()
}

func (m model) next() (tea.Model, tea.Cmd) {
	switch m.step {
	case stepVaultPath:
		path := strings.TrimSpace(m.input.Value())
		if path == "" {
			m.err = fmt.Errorf("vault path is required")
			return m, nil
		}
		m.vaultPath = path
		m.err = nil
		m.step = stepPorts
		return m, nil
	case stepPorts:
		m.step = stepStartAnythingLLM
		return m, nil
	case stepStartAnythingLLM:
		if err := run("./scripts/kb", "init"); err != nil {
			m.err = err
			return m, nil
		}
		for _, kv := range [][]string{
			{"HOST_VAULT_PATH", m.vaultPath},
			{"HOST_ANYTHINGLLM_PORT", m.anyPort},
			{"HOST_MCP_PORT", m.mcpPort},
		} {
			if err := run("./scripts/kb", "set-env", kv[0], kv[1]); err != nil {
				m.err = err
				return m, nil
			}
		}
		if err := run("./scripts/kb", "start"); err != nil {
			m.err = err
			return m, nil
		}
		m.input = textinput.New()
		m.input.Focus()
		m.input.Placeholder = "AnythingLLM API key"
		m.step = stepAPIKey
		return m, nil
	case stepAPIKey:
		key := strings.TrimSpace(m.input.Value())
		if key == "" {
			m.err = fmt.Errorf("API key is required")
			return m, nil
		}
		m.apiKey = key
		m.err = nil
		m.step = stepStartMCP
		return m, nil
	case stepStartMCP:
		if err := run("./scripts/kb", "set-env", "ANYTHINGLLM_API_KEY", m.apiKey); err != nil {
			m.err = err
			return m, nil
		}
		if err := run("./scripts/kb", "verify-key"); err != nil {
			m.err = err
			return m, nil
		}
		if err := run("./scripts/kb", "start-mcp"); err != nil {
			m.err = err
			return m, nil
		}
		m.step = stepStartSync
		return m, nil
	case stepStartSync:
		if m.startSync {
			if err := run("./scripts/kb", "start-sync"); err != nil {
				m.err = err
				return m, nil
			}
		}
		m.step = stepDone
		return m, nil
	case stepDone:
		return m, tea.Quit
	}
	return m, nil
}

func defaultVaultPath() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return "../vault"
	}
	return filepath.Join(home, "Documents", "vault")
}

func run(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	return cmd.Run()
}
```

- [x] **Step 3: Add pure helper tests**

Create `installer/main_test.go` with:

```go
package main

import "testing"

func TestInitialModelDefaults(t *testing.T) {
	m := initialModel()
	if m.anyPort != "11301" {
		t.Fatalf("anyPort = %q", m.anyPort)
	}
	if m.mcpPort != "11333" {
		t.Fatalf("mcpPort = %q", m.mcpPort)
	}
	if m.input.Value() == "" {
		t.Fatal("default vault path should not be empty")
	}
}
```

- [x] **Step 4: Run Go checks**

> **Hardening applied (beyond the plan's literal Step 2 code):** the original
> `main.go` ran `kb` commands synchronously inside `Update`, freezing the TUI
> and corrupting its display during Docker builds. It now runs them async via
> `tea.Cmd` + `bubbles/spinner`, with output captured by `CombinedOutput`.
> `main_test.go` was expanded (action commands, async runner, transitions,
> validations) test-first. No new Go deps. Run-time smoke test still pending
> under Task 5 Step 4.

Run:

```bash
cd installer
go test ./...
go build ./...
```

Expected: tests and build pass.

## Task 4: Wire Documentation To The New First-Run Path

**Files:**
- Modify: `README.md`
- Modify: `docs/agent-mcp.md`

**Interfaces:**
- Consumes: `install.sh`, `scripts/kb setup-fallback`, `scripts/kb start-mcp`.
- Produces: one primary install command and a manual fallback section.

- [x] **Step 1: Update README primary setup**

Replace the current long first-run command path with this primary command:

```bash
curl -fsSL https://raw.githubusercontent.com/pingkiuho/anything-obsidian/main/install.sh | bash
```

Keep the manual Docker path below it under `Manual setup`.

- [x] **Step 2: Document local clone setup**

Add:

```bash
git clone https://github.com/pingkiuho/anything-obsidian.git anything-obsidian
cd anything-obsidian
./install.sh
```

- [x] **Step 3: Update MCP doc**

In `docs/agent-mcp.md`, add:

```text
The recommended first-run path is the installer TUI. It starts MCP after you paste and verify the AnythingLLM API key. Manual MCP startup remains available with `./scripts/kb start-mcp`.
```

- [x] **Step 4: Run docs whitespace check**

Run:

```bash
git diff --check
```

Expected: no whitespace errors.

## Task 5: End-To-End Smoke Checks

**Files:**
- Modify only if earlier tasks missed docs or scripts.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: confidence that installer entrypoints do not break without running real user setup.

- [x] **Step 1: Run static checks**

```bash
bash -n install.sh
bash -n scripts/kb
cd installer
go test ./...
go build ./...
```

Expected: all pass.

- [x] **Step 2: Check fallback path without TUI**

Run:

```bash
./install.sh --help
```

Expected: help text prints and exits `0`.

- [x] **Step 3: Check repo-local fallback**

Run:

```bash
./scripts/kb init
./scripts/kb setup-fallback
```

Expected: `.env` exists and fallback steps print.

- [x] **Step 4: Manual smoke path**

> Verified the Docker half autonomously: `./scripts/kb start` brought up
> AnythingLLM and `http://localhost:11301` answered HTTP 200 with a healthy
> container. The `go run ./installer` interactive flow is inherently manual —
> it needs a real TTY and a browser-side AnythingLLM API-key creation, which
> the Global Constraint against scraping/auto-generating keys rules out for
> automation. The async hardening (tea.Cmd + spinner + CombinedOutput) means
> the TUI will not freeze or corrupt during these Docker steps.

Run only when Docker is available:

```bash
./scripts/kb start
```

Expected: AnythingLLM container starts and `http://localhost:11301` is reachable.

Then use the TUI:

```bash
go run ./installer
```

Expected: TUI can accept vault path, start AnythingLLM, accept an API key, verify it, start MCP, and optionally start sync.

## Self-Review

- Spec coverage: `curl | bash`, TUI setup, API key handoff, MCP startup, fallback path, and docs are covered.
- Placeholder scan: no deferred implementation placeholders.
- Type consistency: Go state names and script command names are consistent across tasks.
- Scope check: this is one coherent installer revamp; release binaries and GitHub Actions packaging are intentionally out of scope until the Go TUI works locally.
