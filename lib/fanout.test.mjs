import assert from "node:assert/strict";
import test from "node:test";

import {
  extractChunks,
  fanoutVectorSearch,
  mergeChunksByScore,
  partialResultsNote,
  vectorSearchJson,
} from "./fanout.mjs";

test("extractChunks finds the first chunk-like array anywhere in the payload", () => {
  const payload = {
    metadata: { next: null },
    response: {
      results: [
        { text: "alpha", score: 0.9 },
        { text: "beta", score: 0.8 },
        "not-a-chunk",
      ],
    },
  };
  assert.deepEqual(extractChunks(payload), [
    { text: "alpha", score: 0.9 },
    { text: "beta", score: 0.8 },
  ]);
  assert.deepEqual(extractChunks(null), []);
  assert.deepEqual(extractChunks({ nothing: { here: true } }), []);
});

test("vectorSearchJson posts the query and throws on HTTP errors", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ results: [{ text: "hit", score: 1 }] }), { status: 200 });
  };
  const data = await vectorSearchJson({
    slug: "any-obs-host-work",
    query: "ports",
    topN: 4,
    scoreThreshold: 0.2,
    baseUrl: "http://upstream.test/",
    apiKey: "dev-key",
    fetchImpl,
  });
  assert.deepEqual(data, { results: [{ text: "hit", score: 1 }] });
  assert.equal(calls[0].url, "http://upstream.test/api/v1/workspace/any-obs-host-work/vector-search");
  assert.equal(calls[0].init.headers.Authorization, "Bearer dev-key");
  assert.deepEqual(JSON.parse(calls[0].init.body), { query: "ports", topN: 4, scoreThreshold: 0.2 });

  const failing = async () => new Response("nope", { status: 403 });
  await assert.rejects(
    vectorSearchJson({ slug: "w", query: "q", topN: 4, baseUrl: "http://upstream.test", apiKey: "k", fetchImpl: failing }),
    /AnythingLLM API 403/,
  );
  await assert.rejects(
    vectorSearchJson({ slug: "w", query: "q", topN: 4, baseUrl: "http://u", apiKey: "", fetchImpl }),
    /ANYTHINGLLM_API_KEY/,
  );
});

test("fanoutVectorSearch isolates failed legs and merge orders by score", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("/good-a/")) return new Response(JSON.stringify({ chunks: [{ text: "a1", score: 0.7 }, { text: "a2", score: 0.5 }] }));
    if (url.includes("/good-b/")) return new Response(JSON.stringify({ chunks: [{ text: "b1", score: 0.9 }] }));
    return new Response("boom", { status: 500 });
  };
  const { answered, failures } = await fanoutVectorSearch({
    query: "q",
    topN: 4,
    workspaces: ["good-a", "bad", "good-b"],
    baseUrl: "http://u",
    apiKey: "k",
    fetchImpl,
  });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].workspace, "bad");
  assert.match(failures[0].error, /AnythingLLM API 500/);
  assert.match(partialResultsNote(failures), /partial/);
  assert.equal(partialResultsNote([]), undefined);

  const merged = mergeChunksByScore({ answered, topN: 2 });
  assert.deepEqual(
    merged.map((chunk) => `${chunk.text}@${chunk.workspace}`),
    ["b1@good-b", "a1@good-a"],
  );
});
