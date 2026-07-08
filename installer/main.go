package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
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
	step      step
	input     textinput.Model
	spinner   spinner.Model
	vaultPath string
	anyPort   string
	mcpPort   string
	apiKey    string
	startSync bool
	running   bool
	runLabel  string
	message   string
	err       error
}

// stepDoneMsg is emitted when an async kb command chain finishes.
type stepDoneMsg struct{ err error }

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
		spinner: spinner.New(),
		anyPort: "11301",
		mcpPort: "11333",
	}
}

func (m model) Init() tea.Cmd {
	return nil
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case stepDoneMsg:
		// An async kb chain finished. Stop the spinner and either surface the
		// error (user can press enter to retry) or advance the flow.
		m.running = false
		if msg.err != nil {
			m.err = msg.err
			return m, nil
		}
		m.err = nil
		return m.onActionDone()
	case spinner.TickMsg:
		if !m.running {
			return m, nil
		}
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd
	case tea.KeyMsg:
		// While a command runs, only abort is honored; everything else is
		// ignored so input never fights the subprocess.
		if m.running {
			if msg.String() == "ctrl+c" || msg.String() == "esc" {
				return m, tea.Quit
			}
			return m, nil
		}
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

	if m.running {
		b.WriteString(m.spinner.View() + " " + m.runLabel + "\n\n")
		b.WriteString("Press ctrl+c to abort.")
		return b.String()
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
	case stepStartAnythingLLM, stepStartMCP, stepStartSync:
		return m.startAction()
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
	case stepDone:
		return m, tea.Quit
	}
	return m, nil
}

// startAction runs the current step's kb commands asynchronously so the UI
// keeps redrawing (spinner) instead of freezing, and captures combined output
// so the subprocess never writes raw bytes into the TUI's render area.
func (m model) startAction() (tea.Model, tea.Cmd) {
	cmds := m.actionCommands()
	if len(cmds) == 0 {
		// Nothing to run (e.g. sync declined): advance immediately.
		return m.onActionDone()
	}
	m.running = true
	m.err = nil
	m.runLabel = m.stepLabel()
	startSpinner := func() tea.Msg { return m.spinner.Tick() }
	return m, tea.Batch(startSpinner, runCommands(cmds))
}

// onActionDone advances the flow after an action step succeeds.
func (m model) onActionDone() (tea.Model, tea.Cmd) {
	switch m.step {
	case stepStartAnythingLLM:
		in := textinput.New()
		in.Focus()
		in.Placeholder = "AnythingLLM API key"
		m.input = in
		m.step = stepAPIKey
	case stepStartMCP:
		m.step = stepStartSync
	case stepStartSync:
		m.step = stepDone
	}
	return m, nil
}

func (m model) stepLabel() string {
	switch m.step {
	case stepStartAnythingLLM:
		return "Creating .env and starting AnythingLLM (first run may take a few minutes)…"
	case stepStartMCP:
		return "Verifying API key and building MCP…"
	case stepStartSync:
		return "Starting auto sync watcher…"
	}
	return "Working…"
}

// actionCommands returns the kb command chain for the current action step.
func (m model) actionCommands() [][]string {
	switch m.step {
	case stepStartAnythingLLM:
		return [][]string{
			{"./scripts/kb", "init"},
			{"./scripts/kb", "set-env", "HOST_VAULT_PATH", m.vaultPath},
			{"./scripts/kb", "set-env", "HOST_ANYTHINGLLM_PORT", m.anyPort},
			{"./scripts/kb", "set-env", "HOST_MCP_PORT", m.mcpPort},
			{"./scripts/kb", "start"},
		}
	case stepStartMCP:
		return [][]string{
			{"./scripts/kb", "set-env", "ANYTHINGLLM_API_KEY", m.apiKey},
			{"./scripts/kb", "verify-key"},
			{"./scripts/kb", "start-mcp"},
		}
	case stepStartSync:
		if m.startSync {
			return [][]string{{"./scripts/kb", "start-sync"}}
		}
	}
	return nil
}

// runCommands runs each command sequentially in a goroutine, returning a
// stepDoneMsg carrying the first error (with captured output) or nil.
//
// ponytail: rely on CWD being the repo root — install.sh cd's there before
// `go run ./installer`. Resolving the repo root from a `go run` temp binary
// isn't worth the complexity; upgrade to an explicit root if run-from-anywhere
// becomes a real use case.
func runCommands(cmds [][]string) tea.Cmd {
	return func() tea.Msg {
		for _, c := range cmds {
			out, err := exec.Command(c[0], c[1:]...).CombinedOutput()
			if err != nil {
				return stepDoneMsg{err: fmt.Errorf("%s: %w\n%s", strings.Join(c, " "), err, out)}
			}
		}
		return stepDoneMsg{}
	}
}

func defaultVaultPath() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return "../vault"
	}
	return filepath.Join(home, "Documents", "vault")
}
