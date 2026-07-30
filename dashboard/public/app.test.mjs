import assert from "node:assert/strict";
import test from "node:test";

import { actionDisabledReason, activeTheme, dashboardMetrics, gitAuthForRepository, nextTheme, serviceTone, systemPowerLabel, vaultActionUrl } from "./app.js";

test("system power label follows state", () => {
  assert.equal(systemPowerLabel("on"), "Turn Off");
  assert.equal(systemPowerLabel("off"), "Turn On");
  assert.equal(systemPowerLabel("partial"), "Repair");
});

test("service tone maps service running and health", () => {
  assert.equal(serviceTone({ running: true, health: { ok: true } }), "ok");
  assert.equal(serviceTone({ running: true, health: { ok: false } }), "warn");
  assert.equal(serviceTone({ running: false, health: { ok: false } }), "off");
});

test("action disabled reason blocks embed when AnythingLLM is off", () => {
  const status = {
    services: [{ id: "anythingllm", running: false }],
    latestJob: null,
  };

  assert.equal(actionDisabledReason("embed", status), "Turn system on first");
  assert.equal(actionDisabledReason("doctor", status), "");
});

test("action disabled reason blocks while a job is running", () => {
  const status = {
    services: [{ id: "anythingllm", running: true }],
    latestJob: { status: "running" },
  };

  assert.equal(actionDisabledReason("doctor", status), "Worker job running");
});

test("vault action URLs are scoped by stable vault id", () => {
  assert.equal(vaultActionUrl("work", "embed-all"), "/api/vaults/work/actions/embed-all");
});

test("repository visibility controls the credential payload", () => {
  assert.deepEqual(gitAuthForRepository("public", "ignored", "ignored"), { mode: "none" });
  assert.deepEqual(gitAuthForRepository("private", "oauth2", "secret"), {
    mode: "https-token", username: "oauth2", token: "secret",
  });
});

test("dashboard metrics summarize vault schedules and healthy services", () => {
  assert.deepEqual(dashboardMetrics({
    services: [
      { running: true, health: { ok: true } },
      { running: true, health: { ok: false } },
      { running: false, health: { ok: false } },
    ],
  }, [{ enabled: true }, { enabled: false }]), [
    { label: "Managed vaults", value: 2 },
    { label: "Scheduled sync", value: 1 },
    { label: "Healthy services", value: "1/3" },
  ]);
});

test("theme resolves a saved preference before the system preference", () => {
  assert.equal(activeTheme("light", true), "light");
  assert.equal(activeTheme("dark", false), "dark");
  assert.equal(activeTheme(null, true), "dark");
  assert.equal(activeTheme(null, false), "light");
  assert.equal(nextTheme("dark"), "light");
  assert.equal(nextTheme("light"), "dark");
});
