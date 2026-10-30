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

test("reconciliation deletes untracked folder documents after a manifest loss", async () => {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "anything-obsidian-vault-"));
  const stateDir = await mkdtemp(path.join(tmpdir(), "anything-obsidian-state-"));
  const originalFetch = globalThis.fetch;
  let embeddingsBody = null;

  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/v1/workspaces") {
      return response(200, { workspaces: [{ slug: "ws" }] });
    }
    if (path === "/api/v1/document/upload/anything-obsidian-vault-vault-1") {
      return response(200, {
        documents: [{ location: "anything-obsidian-vault-vault-1/note.md-new.json" }],
      });
    }
    // Direct instance: the synthesized documents route does not exist and the
    // SPA answers unknown GETs with HTML, so listing falls back to the
    // workspace detail response.
    if (path === "/api/v1/workspace/ws/documents") {
      return response(200, "<!DOCTYPE html>");
    }
    if (path === "/api/v1/workspace/ws") {
      return response(200, {
        workspace: [
          {
            documents: [
              { docpath: "anything-obsidian-vault/vault-1/note.md-old1.json" },
              { docpath: "anything-obsidian-vault/vault-1/note.md-old2.json" },
              { docpath: "anything-obsidian-vault/other-vault/secret.json" },
            ],
          },
        ],
      });
    }
    if (path === "/api/v1/workspace/ws/update-embeddings") {
      embeddingsBody = JSON.parse(init.body);
      return response(200, {});
    }
    throw new Error(`unexpected request: ${url}`);
  };

  try {
    await writeFile(path.join(vaultPath, "note.md"), "hello");

    // Empty stateDir stands in for the wiped manifest: the re-upload must
    // carry the stale legacy copies out with it instead of duplicating them.
    const result = await embedVault({
      config: {
        anythingllmBaseUrl: "http://anythingllm:3001",
        apiKey: "key",
        workspaceSlug: "ws",
        vaultId: "vault-1",
        documentFolder: "anything-obsidian-vault-vault-1",
        vaultPath,
        stateDir,
      },
      all: false,
    });

    // The sibling vault's documents are never ours to delete.
    assert.deepEqual([...embeddingsBody.adds], ["anything-obsidian-vault-vault-1/note.md-new.json"]);
    assert.deepEqual(
      [...embeddingsBody.deletes].sort(),
      [
        "anything-obsidian-vault/vault-1/note.md-old1.json",
        "anything-obsidian-vault/vault-1/note.md-old2.json",
      ],
    );
    assert.equal(result.reconciled, 2);
    assert.equal(result.removed, 2);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(vaultPath, { force: true, recursive: true });
    await rm(stateDir, { force: true, recursive: true });
  }
});

test("a healthy manifest re-embeds nothing and reconciles nothing", async () => {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "anything-obsidian-vault-"));
  const stateDir = await mkdtemp(path.join(tmpdir(), "anything-obsidian-state-"));
  const originalFetch = globalThis.fetch;
  const config = {
    anythingllmBaseUrl: "http://anythingllm:3001",
    apiKey: "key",
    workspaceSlug: "ws",
    vaultId: "vault-1",
    documentFolder: "anything-obsidian-vault-vault-1",
    vaultPath,
    stateDir,
  };

  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/v1/workspaces") {
      return response(200, { workspaces: [{ slug: "ws" }] });
    }
    if (path === "/api/v1/document/upload/anything-obsidian-vault-vault-1") {
      return response(200, {
        documents: [{ location: "anything-obsidian-vault-vault-1/note.md-new.json" }],
      });
    }
    if (path === "/api/v1/workspace/ws/documents") {
      return response(200, {
        documents: [
          { docpath: "anything-obsidian-vault-vault-1/note.md-new.json" },
          { docpath: "anything-obsidian-vault/other-vault/secret.json" },
        ],
      });
    }
    if (path === "/api/v1/workspace/ws/update-embeddings") {
      return response(200, {});
    }
    throw new Error(`unexpected request: ${url}`);
  };

  try {
    await writeFile(path.join(vaultPath, "note.md"), "hello");

    await embedVault({ config, all: false });
    const secondRunRequests = [];
    globalThis.fetch = async (url) => {
      secondRunRequests.push(new URL(String(url)).pathname);
      const path = secondRunRequests.at(-1);
      if (path === "/api/v1/workspaces") {
        return response(200, { workspaces: [{ slug: "ws" }] });
      }
      if (path === "/api/v1/workspace/ws/documents") {
        return response(200, {
          documents: [{ docpath: "anything-obsidian-vault-vault-1/note.md-new.json" }],
        });
      }
      throw new Error(`unexpected second-run request: ${url}`);
    };

    const result = await embedVault({ config, all: false });

    assert.deepEqual(secondRunRequests, ["/api/v1/workspaces", "/api/v1/workspace/ws/documents"]);
    assert.equal(result.uploaded, 0);
    assert.equal(result.reconciled, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(vaultPath, { force: true, recursive: true });
    await rm(stateDir, { force: true, recursive: true });
  }
});

test("legacy shared-folder layouts only claim this vault's subpath", async () => {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "anything-obsidian-vault-"));
  const stateDir = await mkdtemp(path.join(tmpdir(), "anything-obsidian-state-"));
  const originalFetch = globalThis.fetch;
  let embeddingsBody = null;

  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/v1/workspaces") {
      return response(200, { workspaces: [{ slug: "ws" }] });
    }
    if (path === "/api/v1/document/upload/anything-obsidian-vault") {
      return response(200, {
        documents: [{ location: "anything-obsidian-vault/vault-a/note.md-new.json" }],
      });
    }
    if (path === "/api/v1/workspace/ws/documents") {
      return response(200, {
        documents: [
          { docpath: "anything-obsidian-vault/vault-a/note.md-stale.json" },
          { docpath: "anything-obsidian-vault/vault-b/secret.md-stale.json" },
        ],
      });
    }
    if (path === "/api/v1/workspace/ws/update-embeddings") {
      embeddingsBody = JSON.parse(init.body);
      return response(200, {});
    }
    throw new Error(`unexpected request: ${url}`);
  };

  try {
    await writeFile(path.join(vaultPath, "note.md"), "hello");

    const result = await embedVault({
      config: {
        anythingllmBaseUrl: "http://anythingllm:3001",
        apiKey: "key",
        workspaceSlug: "ws",
        vaultId: "vault-a",
        documentFolder: "anything-obsidian-vault",
        vaultPath,
        stateDir,
      },
      all: false,
    });

    assert.deepEqual([...embeddingsBody.deletes], ["anything-obsidian-vault/vault-a/note.md-stale.json"]);
    assert.equal(result.reconciled, 1);
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
