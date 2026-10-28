import assert from "node:assert/strict";
import test from "node:test";

import { createAnythingllmClient } from "./anythingllm.mjs";

test("creates a workspace through the AnythingLLM developer API", async () => {
  const requests = [];
  const client = createAnythingllmClient({
    baseUrl: "http://anythingllm:3001",
    apiKey: "secret",
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return response(200, { workspace: { id: 1, name: "Work", slug: "work" } });
    },
  });

  assert.deepEqual(await client.createWorkspace({ name: "Work" }), { id: 1, name: "Work", slug: "work" });
  assert.equal(requests[0].url, "http://anythingllm:3001/api/v1/workspace/new");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers.Authorization, "Bearer secret");
  assert.ok(requests[0].init.signal, "every call carries a deadline signal");
});

test("a black-holed AnythingLLM URL rejects at the deadline instead of hanging", async () => {
  const client = createAnythingllmClient({
    baseUrl: "http://anythingllm.test",
    apiKey: "key",
    timeoutMs: 50,
    fetchImpl: (url, init = {}) => new Promise((_resolve, reject) => {
      // Hold the loop open so the deadline actually fires inside the test.
      const keepAlive = setTimeout(() => reject(new Error("deadline never fired")), 2000);
      init.signal?.addEventListener("abort", () => {
        clearTimeout(keepAlive);
        reject(new Error("aborted at deadline"));
      });
    }),
  });

  await assert.rejects(() => client.listWorkspaces(), /aborted at deadline/);
});

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}
