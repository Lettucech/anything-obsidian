import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { embedVault } from "./embed-vault.mjs";

test("validates workspace slug before uploading vault files", async () => {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "anything-obsidian-vault-"));
  const stateDir = await mkdtemp(path.join(tmpdir(), "anything-obsidian-state-"));
  const requests = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url) => {
    requests.push(String(url));
    if (String(url).endsWith("/api/v1/workspaces")) {
      return response(200, {
        workspaces: [{ slug: "my-workspace" }, { slug: "project-notes" }],
      });
    }
    throw new Error(`unexpected request before workspace validation: ${url}`);
  };

  try {
    await writeFile(path.join(vaultPath, "RAG Smoke Test.md"), "hello");

    await assert.rejects(
      embedVault({
        config: {
          anythingllmBaseUrl: "http://anythingllm:3001",
          apiKey: "key",
          workspaceSlug: "obsidian",
          vaultPath,
          stateDir,
        },
        all: true,
      }),
      /AnythingLLM workspace 'obsidian' was not found. Available workspaces: my-workspace, project-notes/,
    );

    assert.deepEqual(requests, ["http://anythingllm:3001/api/v1/workspaces"]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(vaultPath, { force: true, recursive: true });
    await rm(stateDir, { force: true, recursive: true });
  }
});

function response(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data),
  };
}
