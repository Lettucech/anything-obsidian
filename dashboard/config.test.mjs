import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKER_ACTIONS,
  classifySystemState,
  publicConfig,
} from "./config.mjs";

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
    { id: "scheduler", found: true, running: true },
    { id: "git", found: true, running: true },
  ];
  const allStopped = [
    { id: "anythingllm", found: true, running: false },
    { id: "scheduler", found: true, running: false },
    { id: "git", found: false, running: false },
  ];
  const mixed = [
    { id: "anythingllm", found: true, running: true },
    { id: "scheduler", found: true, running: false },
    { id: "git", found: true, running: true },
  ];

  assert.equal(classifySystemState(allRunning), "on");
  assert.equal(classifySystemState(allStopped), "off");
  assert.equal(classifySystemState(mixed), "partial");
});

test("public config exposes only non-secret operational values", () => {
  const config = publicConfig({
    DASHBOARD_PORT: "21502",
    MCP_PORT: "21503",
    ANYTHINGLLM_BASE_URL: "http://localhost:11301/",
    VAULTS_ROOT: "/Users/x/ObsidianVaults",
    ANYTHINGLLM_API_KEY: "sk-secret",
    GIT_PASSWORD: "token-secret",
  });

  assert.deepEqual(config, {
    dashboardUrl: "http://localhost:21502",
    anythingllmUrl: "http://localhost:11301",
    mcpUrl: "http://localhost:21503/mcp",
    vaultsRoot: "/Users/x/ObsidianVaults",
  });
});

test("public config tolerates a missing MCP port", () => {
  const config = publicConfig({ DASHBOARD_PORT: "21502" });
  assert.equal(config.mcpUrl, null);
});
