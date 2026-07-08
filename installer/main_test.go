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
