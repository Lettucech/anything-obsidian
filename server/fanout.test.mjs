import assert from "node:assert/strict";
import test from "node:test";

import { extractChunks, fanoutSearch } from "./fanout.mjs";

test("extractChunks finds chunk arrays across response shapes", () => {
  assert.deepEqual(
    extractChunks({ response: { results: [{ text: "a", score: 1 }, { text: "b" }] } }),
    [{ text: "a", score: 1 }, { text: "b" }],
  );
  assert.deepEqual(extractChunks([{ text: "a" }]), [{ text: "a" }]);
  assert.deepEqual(extractChunks({ data: { sources: [{ score: 0.4 }] } }), [{ score: 0.4 }]);
  assert.deepEqual(extractChunks({ irrelevant: { nested: [{ id: 1 }] } }), []);
});

test("fanoutSearch merges workspaces by score and tags each chunk", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    const slug = new URL(String(url)).pathname.split("/")[4];
    const chunks = {
      shared: [{ text: "shared hit", score: 0.55 }, { text: "shared low", score: 0.2 }],
      "any-obs-brian-01": [{ text: "personal hit", score: 0.9 }],
    }[decodeURIComponent(slug)] ?? [];
    return jsonResponse(200, { results: chunks });
  };

  const result = await fanoutSearch({
    query: "anything",
    topN: 2,
    workspaces: ["shared", "any-obs-brian-01"],
    baseUrl: "http://anythingllm:3001",
    apiKey: "key",
    fetchImpl,
  });

  assert.deepEqual(calls.map((call) => call.body.topN), [2, 2]);
  assert.deepEqual(result.results, [
    { text: "personal hit", score: 0.9, workspace: "any-obs-brian-01" },
    { text: "shared hit", score: 0.55, workspace: "shared" },
  ]);
  assert.deepEqual(result.workspaces, { searched: ["shared", "any-obs-brian-01"], failed: [] });
});

test("fanoutSearch reports partial results when a workspace fails", async () => {
  const fetchImpl = async (url) => {
    const slug = new URL(String(url)).pathname.split("/")[4];
    if (slug === "broken") return jsonResponse(500, "boom");
    return jsonResponse(200, { results: [{ text: "ok", score: 0.7 }] });
  };

  const result = await fanoutSearch({
    query: "anything",
    topN: 4,
    workspaces: ["shared", "broken"],
    baseUrl: "http://anythingllm:3001",
    apiKey: "key",
    fetchImpl,
  });

  assert.deepEqual(result.results, [{ text: "ok", score: 0.7, workspace: "shared" }]);
  assert.deepEqual(result.workspaces.failed, [{ workspace: "broken", error: "AnythingLLM API 500: boom" }]);
  assert.match(result.note, /partial/);
});

function jsonResponse(status, data) {
  const body = typeof data === "string" ? data : JSON.stringify(data);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => body,
    arrayBuffer: async () => Buffer.from(body),
  };
}
