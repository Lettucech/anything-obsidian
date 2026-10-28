import assert from "node:assert/strict";
import test from "node:test";

import { attributeRagResults, parseVaultRef } from "./rag-attribution.mjs";

const VAULT_IDS = ["work", "personal"];

test("chunk sources resolve to a vault only when the prefix names a known vault", () => {
  assert.deepEqual(parseVaultRef("work/notes/a.md", new Set(VAULT_IDS)), { vaultId: "work", path: "notes/a.md" });
  assert.deepEqual(parseVaultRef("personal/deep/dir/b.md", new Set(VAULT_IDS)), { vaultId: "personal", path: "deep/dir/b.md" });
  assert.equal(parseVaultRef("unknown/a.md", new Set(VAULT_IDS)), null);
  assert.equal(parseVaultRef("nopath", new Set(VAULT_IDS)), null);
  assert.equal(parseVaultRef("", new Set(VAULT_IDS)), null);
});

test("search results gain vaultId and vaultPath across response shapes", () => {
  const data = {
    response: {
      results: [
        { score: 0.9, text: "chunk a", chunkSource: "work/notes/a.md" },
        { score: 0.8, text: "chunk b", metadata: { chunkSource: "personal/notes/b.md" } },
      ],
    },
  };
  const { data: enriched, summary } = attributeRagResults(data, { vaultIds: VAULT_IDS });

  assert.equal(summary.attributed, 2);
  assert.equal(summary.dropped, 0);
  const [a, b] = enriched.response.results;
  assert.deepEqual([a.vaultId, a.vaultPath], ["work", "notes/a.md"]);
  assert.deepEqual([b.vaultId, b.vaultPath], ["personal", "notes/b.md"]);
});

test("a vaultId filter drops other vaults and unattributed chunks", () => {
  const data = [
    { score: 0.9, chunkSource: "work/notes/a.md" },
    { score: 0.8, chunkSource: "personal/notes/b.md" },
    { score: 0.7, text: "no attribution" },
  ];
  const { data: enriched, summary } = attributeRagResults(data, {
    vaultIds: VAULT_IDS,
    filterVaultId: "work",
  });

  assert.equal(summary.attributed, 1);
  assert.equal(summary.dropped, 2);
  assert.deepEqual(enriched.map((chunk) => chunk.vaultId), ["work"]);
});

test("chunks from blocked vaults are dropped regardless of filtering", () => {
  const data = [
    { score: 0.9, chunkSource: "work/notes/a.md" },
    { score: 0.8, chunkSource: "personal/notes/b.md" },
  ];
  const { data: enriched, summary } = attributeRagResults(data, {
    vaultIds: VAULT_IDS,
    blockedVaultIds: ["personal"],
  });

  assert.equal(summary.attributed, 1);
  assert.equal(summary.dropped, 1);
  assert.deepEqual(enriched.map((chunk) => chunk.chunkSource), ["work/notes/a.md"]);
});

test("unattributed chunks survive when no filter is active", () => {
  const data = { sources: [{ text: "legacy chunk", source: "not-a-vault/x.md" }] };
  const { data: enriched, summary } = attributeRagResults(data, { vaultIds: VAULT_IDS });

  assert.equal(summary.attributed, 0);
  assert.equal(summary.dropped, 0);
  assert.equal(enriched.sources.length, 1);
  assert.equal(enriched.sources[0].vaultId, undefined);
});
