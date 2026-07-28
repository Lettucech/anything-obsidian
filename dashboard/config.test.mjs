import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROLLED_SERVICES,
  LOG_SERVICES,
  WORKER_ACTIONS,
  classifySystemState,
  publicConfig,
} from "./config.mjs";

test("controlled service allowlist contains only project services", () => {
  assert.deepEqual(Object.keys(CONTROLLED_SERVICES).sort(), ["anythingllm", "mcp", "syncer"]);
  assert.equal(CONTROLLED_SERVICES.anythingllm.name, "anything-obsidian-anythingllm");
  assert.equal(CONTROLLED_SERVICES.mcp.name, "anything-obsidian-mcp");
  assert.equal(CONTROLLED_SERVICES.syncer.name, "anything-obsidian-syncer");
});

test("log service allowlist does not accept arbitrary names", () => {
  assert.deepEqual(Object.keys(LOG_SERVICES).sort(), ["anythingllm", "mcp", "syncer"]);
  assert.equal(LOG_SERVICES.syncer.name, "anything-obsidian-syncer");
  assert.equal(LOG_SERVICES["/var/run/docker.sock"], undefined);
});

test("worker action allowlist maps to exact worker commands", () => {
  assert.deepEqual(Object.keys(WORKER_ACTIONS).sort(), ["doctor", "embed", "embed-all", "sync"]);
  assert.deepEqual(WORKER_ACTIONS.sync.command, ["sync"]);
  assert.deepEqual(WORKER_ACTIONS.embed.command, ["embed"]);
  assert.deepEqual(WORKER_ACTIONS["embed-all"].command, ["embed", "--all"]);
  assert.deepEqual(WORKER_ACTIONS.doctor.command, ["doctor"]);
  assert.equal(WORKER_ACTIONS.doctor.requiresAnythingLLM, false);
  assert.equal(WORKER_ACTIONS.sync.requiresAnythingLLM, true);
});

test("classifies on off and partial states", () => {
  const allRunning = [
    { id: "anythingllm", found: true, running: true },
    { id: "mcp", found: true, running: true },
    { id: "syncer", found: true, running: true },
  ];
  const allStopped = [
    { id: "anythingllm", found: true, running: false },
    { id: "mcp", found: true, running: false },
    { id: "syncer", found: false, running: false },
  ];
  const mixed = [
    { id: "anythingllm", found: true, running: true },
    { id: "mcp", found: true, running: false },
    { id: "syncer", found: true, running: true },
  ];

  assert.equal(classifySystemState(allRunning), "on");
  assert.equal(classifySystemState(allStopped), "off");
  assert.equal(classifySystemState(mixed), "partial");
});

test("public config exposes only non-secret operational values", () => {
  const config = publicConfig({
    HOST_DASHBOARD_PORT: "11300",
    HOST_ANYTHINGLLM_PORT: "11301",
    HOST_MCP_PORT: "11333",
    VAULT_STATE_ROOT: "/workspace/.anything-obsidian-state",
    ANYTHINGLLM_API_KEY: "sk-secret",
    GIT_PASSWORD: "token-secret",
  });

  assert.deepEqual(config, {
    dashboardUrl: "http://localhost:11300",
    anythingllmUrl: "http://localhost:11301",
    mcpUrl: "http://localhost:11333/mcp",
    vaultsRoot: "/vaults",
  });
});
