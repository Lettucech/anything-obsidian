package main

import (
	"slices"
	"strings"
	"testing"
)

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

func TestActionCommands(t *testing.T) {
	m := initialModel()
	m.vaultPath = "/home/u/vault"
	m.apiKey = "KEY"

	// AnythingLLM start: init, three set-env, then start.
	m.step = stepStartAnythingLLM
	cmds := m.actionCommands()
	if len(cmds) != 5 {
		t.Fatalf("anythingllm step: got %d commands, want 5", len(cmds))
	}
	if !slices.Equal(cmds[0], []string{"./scripts/kb", "init"}) {
		t.Fatalf("anythingllm step[0] = %v", cmds[0])
	}
	if !slices.Equal(cmds[len(cmds)-1], []string{"./scripts/kb", "start"}) {
		t.Fatalf("anythingllm step last = %v", cmds[len(cmds)-1])
	}
	wantVault := []string{"./scripts/kb", "set-env", "HOST_VAULT_PATH", "/home/u/vault"}
	if !slices.ContainsFunc(cmds, func(c []string) bool { return slices.Equal(c, wantVault) }) {
		t.Fatalf("anythingllm step missing %v", wantVault)
	}

	// MCP: set key, verify, then build/start mcp.
	m.step = stepStartMCP
	cmds = m.actionCommands()
	if len(cmds) != 3 {
		t.Fatalf("mcp step: got %d commands, want 3", len(cmds))
	}
	if !slices.Equal(cmds[1], []string{"./scripts/kb", "verify-key"}) {
		t.Fatalf("mcp step[1] = %v, want verify-key", cmds[1])
	}
	if !slices.Equal(cmds[2], []string{"./scripts/kb", "start-mcp"}) {
		t.Fatalf("mcp step[2] = %v, want start-mcp", cmds[2])
	}

	// Sync runs only when opted in.
	m.step = stepStartSync
	m.startSync = false
	if got := m.actionCommands(); len(got) != 0 {
		t.Fatalf("sync opted-out: got %v, want empty", got)
	}
	m.startSync = true
	if got := m.actionCommands(); len(got) != 1 || !slices.Equal(got[0], []string{"./scripts/kb", "start-sync"}) {
		t.Fatalf("sync opted-in: got %v, want single start-sync", got)
	}
}

func TestRunCommands(t *testing.T) {
	// Success: no error, stepDoneMsg returned. (/bin/sh exists on macOS + Linux.)
	if done := runCommands([][]string{{"/bin/sh", "-c", "exit 0"}})().(stepDoneMsg); done.err != nil {
		t.Fatalf("unexpected error: %v", done.err)
	}

	// Failure: error carries the captured output.
	done := runCommands([][]string{{"/bin/sh", "-c", "echo boom; exit 7"}})().(stepDoneMsg)
	if done.err == nil {
		t.Fatal("want error for failing command, got nil")
	}
	if !strings.Contains(done.err.Error(), "boom") {
		t.Fatalf("error should contain captured output, got %q", done.err.Error())
	}

	// Chain stops at the first failing command.
	done = runCommands([][]string{{"/bin/sh", "-c", "exit 1"}, {"/bin/sh", "-c", "exit 0"}})().(stepDoneMsg)
	if done.err == nil {
		t.Fatal("want error when first command fails, got nil")
	}
}

func TestOnActionDoneAdvances(t *testing.T) {
	cases := []struct{ from, want step }{
		{stepStartAnythingLLM, stepAPIKey},
		{stepStartMCP, stepStartSync},
		{stepStartSync, stepDone},
	}
	for _, c := range cases {
		m := initialModel()
		m.step = c.from
		got, _ := m.onActionDone()
		if got.(model).step != c.want {
			t.Fatalf("onActionDone from %v: step=%v, want %v", c.from, got.(model).step, c.want)
		}
	}
}

func TestNextValidations(t *testing.T) {
	// Empty vault path is rejected.
	m := initialModel()
	m.input.SetValue("   ")
	if got, _ := m.next(); got.(model).err == nil {
		t.Fatal("want error for empty vault path")
	}

	// Valid vault path advances and is stored.
	m = initialModel()
	m.input.SetValue("/home/u/vault")
	got, _ := m.next()
	mm := got.(model)
	if mm.err != nil || mm.step != stepPorts || mm.vaultPath != "/home/u/vault" {
		t.Fatalf("vault ok: step=%v vault=%q err=%v", mm.step, mm.vaultPath, mm.err)
	}

	// stepPorts advances without running anything.
	m = initialModel()
	m.step = stepPorts
	if got, _ := m.next(); got.(model).step != stepStartAnythingLLM {
		t.Fatalf("ports -> %v, want stepStartAnythingLLM", got.(model).step)
	}

	// Empty API key is rejected.
	m = initialModel()
	m.step = stepAPIKey
	m.input.SetValue("")
	if got, _ := m.next(); got.(model).err == nil {
		t.Fatal("want error for empty API key")
	}

	// Valid API key advances to the MCP step.
	m = initialModel()
	m.step = stepAPIKey
	m.input.SetValue("secret")
	got, _ = m.next()
	mm = got.(model)
	if mm.err != nil || mm.step != stepStartMCP || mm.apiKey != "secret" {
		t.Fatalf("apikey ok: step=%v key=%q err=%v", mm.step, mm.apiKey, mm.err)
	}
}
