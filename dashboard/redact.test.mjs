import assert from "node:assert/strict";
import test from "node:test";

import { redactSecretsObject, redactSecretsText } from "./redact.mjs";

test("redacts known secret env assignments in text", () => {
  const text = [
    "ANYTHINGLLM_API_KEY=sk-secret",
    "GIT_PASSWORD=token-secret",
    "VAULT_STATE_ROOT=/workspace/.anything-obsidian-state",
  ].join("\n");

  assert.equal(
    redactSecretsText(text),
    [
      "ANYTHINGLLM_API_KEY=[redacted]",
      "GIT_PASSWORD=[redacted]",
      "VAULT_STATE_ROOT=/workspace/.anything-obsidian-state",
    ].join("\n"),
  );
});

test("redacts JSON-style quoted secret key/value pairs", () => {
  assert.equal(
    redactSecretsText('{"ANYTHINGLLM_API_KEY":"sk-secret","name":"dashboard"}'),
    '{"ANYTHINGLLM_API_KEY":"[redacted]","name":"dashboard"}',
  );
});

test("redacts colon-delimited secret key/value pairs", () => {
  assert.equal(
    redactSecretsText("ANYTHINGLLM_API_KEY: sk-secret\nGIT_PASSWORD: token-secret\nstatus: ready"),
    "ANYTHINGLLM_API_KEY: [redacted]\nGIT_PASSWORD: [redacted]\nstatus: ready",
  );
});

test("redacts secret assignments with whitespace around equals", () => {
  assert.equal(
    redactSecretsText("ANYTHINGLLM_API_KEY = sk-secret\nGIT_PASSWORD\t=\ttoken-secret"),
    "ANYTHINGLLM_API_KEY = [redacted]\nGIT_PASSWORD\t=\t[redacted]",
  );
});

test("redacts nested secret object keys", () => {
  assert.deepEqual(
    redactSecretsObject({
      config: {
        ANYTHINGLLM_API_KEY: "sk-secret",
        VAULT_STATE_ROOT: "/workspace/.anything-obsidian-state",
      },
      logs: ["GIT_PASSWORD=token-secret"],
    }),
    {
      config: {
        ANYTHINGLLM_API_KEY: "[redacted]",
        VAULT_STATE_ROOT: "/workspace/.anything-obsidian-state",
      },
      logs: ["GIT_PASSWORD=[redacted]"],
    },
  );
});
