// Unified-workspace RAG results carry vault attribution in each chunk's
// source string (`<vaultId>/<vault-relative path>`, set at upload time).
// AnythingLLM has never committed to one response shape for vector-search,
// so attribution walks whatever structure comes back: any object that looks
// like a chunk (a chunkSource/source/title text field, possibly nested in
// metadata) gets vaultId/vaultPath annotations; filtering and access drops
// happen on the same parse.

const CHUNK_SOURCE_FIELDS = ["chunkSource", "source", "title"];

export function attributeRagResults(data, { vaultIds, filterVaultId = "", blockedVaultIds = [] }) {
  // Sources parse against both sets: a chunk from a blocked vault must be
  // recognised (and dropped), not mistaken for an unattributed leftover.
  const known = new Set([...vaultIds, ...blockedVaultIds]);
  const blocked = new Set(blockedVaultIds);
  const filtering = Boolean(filterVaultId);
  const summary = { attributed: 0, dropped: 0 };
  walk(data);
  return { data, summary };

  function walk(value) {
    if (Array.isArray(value)) {
      // An array that holds one recognisable chunk is a chunk list: every
      // member is a result row, so unattributed members follow chunk rules
      // (kept as-is normally, dropped while filtering) instead of being
      // walked as opaque objects.
      if (value.some(looksLikeChunk)) {
        processChunkArray(value);
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

  function processChunkArray(value) {
    const kept = [];
    for (const item of value) {
      const ref = vaultRef(item) ?? null;
      if (!ref) {
        if (filtering) summary.dropped += 1;
        else kept.push(item);
        continue;
      }
      if (blocked.has(ref.vaultId)) {
        summary.dropped += 1;
        continue;
      }
      if (filtering && ref.vaultId !== filterVaultId) {
        summary.dropped += 1;
        continue;
      }
      item.vaultId = ref.vaultId;
      item.vaultPath = ref.path;
      summary.attributed += 1;
      kept.push(item);
    }
    value.length = 0;
    value.push(...kept);
  }

  function looksLikeChunk(item) {
    return Boolean(item) && typeof item === "object" && !Array.isArray(item) && vaultRef(item) !== null;
  }

  function vaultRef(item) {
    const candidates = [];
    const metadata = item.metadata;
    if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
      for (const field of CHUNK_SOURCE_FIELDS) {
        if (typeof metadata[field] === "string") candidates.push(metadata[field]);
      }
    }
    for (const field of CHUNK_SOURCE_FIELDS) {
      if (typeof item[field] === "string") candidates.push(item[field]);
    }
    for (const candidate of candidates) {
      const ref = parseVaultRef(candidate, known);
      if (ref) return ref;
    }
    return null;
  }
}

export function parseVaultRef(value, known) {
  if (typeof value !== "string") return null;
  const match = value.match(/^([a-z0-9]+(?:-[a-z0-9]+)*)\/(.+)$/);
  if (!match) return null;
  const [, vaultId, rest] = match;
  return known.has(vaultId) ? { vaultId, path: rest } : null;
}
