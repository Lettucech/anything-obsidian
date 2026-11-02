import assert from "node:assert/strict";
import test from "node:test";

import {
  extractChunks,
  fanoutVectorSearch,
  mergeChunksByScore,
  partialResultsNote,
  retrievalHint,
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

test("retrievalHint turns weak retrieval into data, respecting a deliberate low threshold", () => {
  // Under the platform default cutoff → flagged weak.
  assert.deepEqual(retrievalHint([{ score: 0.2 }, { score: 0.1 }]), {
    maxScore: 0.2,
    weakRetrieval: true,
  });
  // Strong scores are not flagged.
  assert.deepEqual(retrievalHint([{ score: 0.8 }]), { maxScore: 0.8, weakRetrieval: false });
  // A caller-chosen threshold is the caller's judgment call, not ours.
  assert.deepEqual(retrievalHint([{ score: 0.2 }], 0.1), { maxScore: 0.2, weakRetrieval: false });
  // Nothing retrieved is the weakest retrieval there is.
  assert.deepEqual(retrievalHint([]), { maxScore: null, weakRetrieval: true });
});

test("guaranteed slots: one vault's high-scoring pile cannot crowd out another's best chunk", () => {
  // vault-a owns five near-identical high scorers; vault-b holds the other
  // version of the same information at a slightly lower score. Without the
  // guarantee, topN=3 would be all vault-a and the divergence would vanish.
  const answered = [
    {
      slug: "any-obs-h-vault-a",
      chunks: [0.91, 0.9, 0.89, 0.88, 0.87].map((score, i) => ({ text: `a${i}`, score })),
    },
    { slug: "any-obs-h-vault-b", chunks: [{ text: "b0", score: 0.86 }] },
  ];
  const merged = mergeChunksByScore({ answered, topN: 3 });
  assert.deepEqual(
    merged.map((chunk) => `${chunk.text}@${chunk.workspace}`),
    ["a0@any-obs-h-vault-a", "a1@any-obs-h-vault-a", "b0@any-obs-h-vault-b"],
  );
});
