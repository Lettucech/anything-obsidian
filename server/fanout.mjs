// One search across every workspace a caller may read: fan out, merge by
// score, tag every chunk with the workspace it came from. The caller never
// needs to know which workspace holds the answer — the same one-search
// philosophy as the client's RAG surface, one level up. The mechanics live
// in lib/fanout.mjs, shared with the client MCP.
import {
  fanoutVectorSearch,
  mergeChunksByScore,
  partialResultsNote,
  retrievalHint,
} from "../lib/fanout.mjs";
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
  const { answered, failures } = await fanoutVectorSearch({
    query,
    topN,
    scoreThreshold,
    workspaces,
    baseUrl: stripTrailingSlash(baseUrl),
    apiKey,
    fetchImpl,
  });
  const note = partialResultsNote(failures);
  const results = mergeChunksByScore({ answered, topN });

  return {
    query,
    results,
    ...retrievalHint(results, scoreThreshold),
    workspaces: {
      searched: workspaces,
      failed: failures,
    },
    ...(note ? { note } : {}),
  };
}

export { extractChunks } from "../lib/fanout.mjs";
