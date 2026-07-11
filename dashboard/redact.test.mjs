import assert from "node:assert/strict";
import test from "node:test";

import { redactSecretsObject, redactSecretsText } from "./redact.mjs";

test("redacts known secret env assignments in text", () => {
  const text = [
    "ANYTHINGLLM_API_KEY=sk-secret",
    "KB_GIT_AUTH_TOKEN=ghp-secret",
    "GIT_PASSWORD=token-secret",
    "KB_GIT_BRANCH=main",
  ].join("\n");

  assert.equal(
    redactSecretsText(text),
    [
      "ANYTHINGLLM_API_KEY=[redacted]",
      "KB_GIT_AUTH_TOKEN=[redacted]",
      "GIT_PASSWORD=[redacted]",
      "KB_GIT_BRANCH=main",
    ].join("\n"),
  );
});

test("redacts nested secret object keys", () => {
  assert.deepEqual(
    redactSecretsObject({
      config: {
        ANYTHINGLLM_API_KEY: "sk-secret",
        KB_GIT_AUTH_TOKEN: "ghp-secret",
        KB_GIT_BRANCH: "main",
      },
      logs: ["GIT_PASSWORD=token-secret"],
    }),
    {
      config: {
        ANYTHINGLLM_API_KEY: "[redacted]",
        KB_GIT_AUTH_TOKEN: "[redacted]",
        KB_GIT_BRANCH: "main",
      },
      logs: ["GIT_PASSWORD=[redacted]"],
    },
  );
});
