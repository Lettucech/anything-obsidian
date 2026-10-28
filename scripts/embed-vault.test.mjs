import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { embedVault, embeddableVaultFiles } from "./embed-vault.mjs";

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

test("uploads carry vault-attributed chunk sources into the unified workspace", async () => {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "anything-obsidian-vault-"));
  const stateDir = await mkdtemp(path.join(tmpdir(), "anything-obsidian-state-"));
  const requests = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/api/v1/workspaces")) {
      return response(200, { workspaces: [{ slug: "any-obs-test-01" }] });
    }
    if (String(url).endsWith("/api/v1/document/upload/anything-obsidian-vault-work")) {
      return response(200, { documents: [{ location: "custom-documents/work/note.md" }] });
    }
    if (String(url).endsWith("/api/v1/workspace/any-obs-test-01/update-embeddings")) {
      return response(200, {});
    }
    throw new Error(`unexpected request: ${url}`);
  };

  try {
    await mkdir(path.join(vaultPath, "notes"), { recursive: true });
    await writeFile(path.join(vaultPath, "notes", "deep.md"), "hello");

    const result = await embedVault({
      config: {
        anythingllmBaseUrl: "http://anythingllm:3001",
        apiKey: "key",
        workspaceSlug: "any-obs-test-01",
        vaultId: "work",
        documentFolder: "anything-obsidian-vault-work",
        vaultPath,
        stateDir,
      },
      all: true,
    });

    assert.deepEqual(result.workspaceSlug, "any-obs-test-01");
    const upload = requests.find(({ url }) => url.includes("/document/upload/"));
    const blob = upload.init.body.get("metadata");
    const parsed = JSON.parse(await new Response(blob).text());
    // The vaultId prefix is what unified search results map back to.
    assert.equal(parsed.title, "work/notes/deep.md");
    assert.equal(parsed.chunkSource, "work/notes/deep.md");
    const embeddings = requests.find(({ url }) => url.endsWith("/update-embeddings"));
    assert.deepEqual(JSON.parse(embeddings.init.body), {
      adds: ["custom-documents/work/note.md"],
      deletes: [],
    });
  } finally {
    globalThis.fetch = originalFetch;
    await rm(vaultPath, { force: true, recursive: true });
    await rm(stateDir, { force: true, recursive: true });
  }
});

test("embeddableVaultFiles lists markdown and skips excluded dirs and other extensions", async () => {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "embed-vault-"));
  try {
    await writeFile(path.join(vaultPath, "note.md"), "x");
    await mkdir(path.join(vaultPath, ".git"), { recursive: true });
    await writeFile(path.join(vaultPath, ".git", "config"), "x");
    await writeFile(path.join(vaultPath, "image.png"), "x");

    const files = await embeddableVaultFiles(vaultPath);
    assert.deepEqual(
      files.map((file) => path.relative(vaultPath, file)),
      ["note.md"],
    );
  } finally {
    await rm(vaultPath, { force: true, recursive: true });
  }
});

function response(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data),
  };
}
