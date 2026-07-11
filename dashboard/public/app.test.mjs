import assert from "node:assert/strict";
import test from "node:test";

import { actionDisabledReason, serviceTone, systemPowerLabel } from "./app.js";

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
