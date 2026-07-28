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
});

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}
