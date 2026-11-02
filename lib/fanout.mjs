// The one fan-out implementation for multi-workspace retrieval. Both the
// local MCP client and the server plane import this file with their own
// credentials and their own allowed-workspace list — the trust model stays
// at the call sites, the mechanics live here once.
import { fetchWithTimeout } from "./http.mjs";

export const VECTOR_SEARCH_PATH = "/api/v1/workspace/{slug}/vector-search";

// One workspace's vector-search, as the raw parsed response. Throws on HTTP
// errors so a failed leg can be reported per-workspace by the fan-out.
export async function vectorSearchJson({
  slug,
  query,
  topN,
  scoreThreshold,
  baseUrl,
  apiKey,
  fetchImpl = fetch,
  signal,
  pathTemplate = VECTOR_SEARCH_PATH,
}) {
  if (!apiKey)
    throw new Error("Missing ANYTHINGLLM_API_KEY. Finish AnythingLLM setup and re-run: anything-obsidian setup");
  if (!baseUrl) throw new Error("Missing ANYTHINGLLM_BASE_URL. Re-run: anything-obsidian setup");
  const url = `${stripTrailingSlash(baseUrl)}${pathTemplate.replace("{slug}", encodeURIComponent(slug))}`;
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: "POST",
      signal,
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
  if (!response.ok)
    throw new Error(`AnythingLLM API ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  return text ? safeJson(text) : null;
}

// Fan out one query over N workspaces, never letting a single failed leg
// sink the rest. `parse` turns a leg's response into chunks (default: the
// defensive AnythingLLM shape hunter below); consumers that enrich the
// response first (the client's vault attribution) pass their own.
export async function fanoutVectorSearch({
  query,
  topN,
  scoreThreshold,
  workspaces,
  baseUrl,
  apiKey,
  fetchImpl = fetch,
  signal,
  pathTemplate,
  parse = extractChunks,
}) {
  const responses = await Promise.all(workspaces.map((slug) =>
    vectorSearchJson({ slug, query, topN, scoreThreshold, baseUrl, apiKey, fetchImpl, signal, pathTemplate })
      .then((data) => ({ slug, chunks: parse(data) }))
      .catch((error) => ({
        slug,
        error: error instanceof Error ? error.message : String(error),
      })),
  ));
  const answered = responses.filter((response) => !response.error);
  const failures = responses
    .filter((response) => response.error)
    .map((response) => ({ workspace: response.slug, error: response.error }));
  return { answered, failures };
}

// Merge every answered leg's chunks into one score-ordered list, each chunk
// tagged with the workspace it came from, capped at topN.
export function mergeChunksByScore({ answered, topN }) {
  const merged = [];
  for (const response of answered)
    for (const chunk of response.chunks) merged.push({ ...chunk, workspace: response.slug });
  merged.sort((a, b) => (typeof b.score === "number" ? b.score : 0) - (typeof a.score === "number" ? a.score : 0));
  return merged.slice(0, topN);
}

export function partialResultsNote(failures) {
  return failures.length ? "Results are partial: some workspaces failed to answer" : undefined;
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

function stripTrailingSlash(value) {
  return String(value ?? "").replace(/\/+$/, "");
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
