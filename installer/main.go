package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

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
	vaultPath string
	anyPort   string
	mcpPort   string
	apiKey    string
	startSync bool
	message   string
	err       error
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
