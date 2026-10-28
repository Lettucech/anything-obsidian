// One search across every workspace a caller may read: fan out, merge by
// score, tag every chunk with the workspace it came from. The caller never
// needs to know which workspace holds the answer — the same one-search
// philosophy as the client's unified workspace, one level up.
import { stripTrailingSlash } from "./http-utils.mjs";

export async function fanoutSearch({
  query,
  topN = 4,
  scoreThreshold,
  workspaces,
  baseUrl,
  apiKey,
  fetchImpl = fetch,
}) {
  const responses = await Promise.all(workspaces.map((slug) =>
    vectorSearch({ slug, query, topN, scoreThreshold, baseUrl, apiKey, fetchImpl })
      .then((chunks) => ({ slug, chunks }))
      .catch((error) => ({ slug, error: error instanceof Error ? error.message : String(error) })),
  ));

  const merged = [];
  const failures = [];
  for (const response of responses) {
    if (response.error) {
      failures.push({ workspace: response.slug, error: response.error });
      continue;
    }
    for (const chunk of response.chunks) merged.push({ ...chunk, workspace: response.slug });
  }
  merged.sort((a, b) => (typeof b.score === "number" ? b.score : 0) - (typeof a.score === "number" ? a.score : 0));

  return {
    query,
    results: merged.slice(0, topN),
    workspaces: {
      searched: workspaces,
      failed: failures,
    },
    ...(failures.length ? { note: "Results are partial: some workspaces failed to answer" } : {}),
  };
}

async function vectorSearch({ slug, query, topN, scoreThreshold, baseUrl, apiKey, fetchImpl }) {
  const response = await fetchImpl(
    `${stripTrailingSlash(baseUrl)}/api/v1/workspace/${encodeURIComponent(slug)}/vector-search`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        topN,
        ...(scoreThreshold !== undefined ? { scoreThreshold } : {}),
      }),
    },
  );
  const text = await response.text();
  const data = text ? safeJson(text) : null;
  if (!response.ok) {
    throw new Error(`AnythingLLM API ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  return extractChunks(data);
}

// AnythingLLM has never committed to one vector-search response shape, so
// find the first array of chunk-looking objects (objects with a text or
// score field) anywhere in the payload.
export function extractChunks(data) {
  const chunks = [];
  walk(data);
  return chunks;

  function walk(value) {
    if (Array.isArray(value)) {
      if (value.some(looksLikeChunk)) {
        chunks.push(...value.filter(looksLikeChunk));
        return;
      }
      for (const item of value) walk(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const inner of Object.values(value)) {
        if (Array.isArray(inner) || (inner && typeof inner === "object")) walk(inner);
      }
    }
  }

  function looksLikeChunk(item) {
    return Boolean(item) && typeof item === "object" && !Array.isArray(item) &&
      (typeof item.text === "string" || typeof item.score === "number");
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
