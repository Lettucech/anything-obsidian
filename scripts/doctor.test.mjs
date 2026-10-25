import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { doctor } from "./doctor.mjs";

function passingFetch() {
  return async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        success: true,
        documents: [{ location: "anything-obsidian-vault-doctor/doctor-probe.json" }],
      }),
  });
}

function passingRunGit() {
  return async () => ({ ok: true, code: 0, stdout: "", stderr: "" });
}

function baseConfig(vaultPath, overrides = {}) {
  return {
    anythingllmBaseUrl: "http://anythingllm:3001",
    mcpBaseUrl: "http://mcp:3333",
    apiKey: "key",
    workspaceSlug: "obsidian",
    vaultPath,
    gitRemote: "origin",
    gitBranch: "main",
    ...overrides,
  };
}

function byName(result) {
  return new Map(result.checks.map((check) => [check.name, check]));
}

test("doctor git check reports failure and points to the vault credential form", async () => {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "doctor-"));
  try {
    const result = await doctor({
      config: baseConfig(vaultPath, { gitAuthToken: "" }),
      fetchImpl: passingFetch(),
      runGit: async () => ({ ok: false, code: 128, stdout: "", stderr: "Authentication failed" }),
      readManifest: async () => ({ files: {} }),
    });
    const git = byName(result).get("git remote");
    assert.equal(git.ok, false);
    assert.match(git.message, /exit 128/);
    assert.match(git.message, /credential in the dashboard/);
  } finally {
    await rm(vaultPath, { force: true, recursive: true });
  }
});

test("doctor git check invokes ls-remote with non-interactive env", async () => {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "doctor-"));
  try {
    const calls = [];
    const result = await doctor({
      config: baseConfig(vaultPath),
      fetchImpl: passingFetch(),
      runGit: async (options) => {
        calls.push(options);
        return { ok: true, code: 0, stdout: "", stderr: "" };
      },
      readManifest: async () => ({ files: {} }),
    });
    assert.equal(byName(result).get("git remote").ok, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ["ls-remote", "--heads", "origin", "main"]);
    assert.equal(calls[0].cwd, vaultPath);
    assert.equal(calls[0].env.GIT_TERMINAL_PROMPT, "0");
  } finally {
    await rm(vaultPath, { force: true, recursive: true });
  }
});

test("doctor mcp health fails on non-200", async () => {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "doctor-"));
  try {
    const result = await doctor({
      config: baseConfig(vaultPath),
      fetchImpl: async (url) => {
        if (String(url).endsWith("/health")) {
          return { ok: false, status: 503, text: async () => "" };
        }
        return { ok: true, status: 200, text: async () => "" };
      },
      runGit: passingRunGit(),
      readManifest: async () => ({ files: {} }),
    });
    const mcp = byName(result).get("mcp health");
    assert.equal(mcp.ok, false);
    assert.match(mcp.message, /503/);
  } finally {
    await rm(vaultPath, { force: true, recursive: true });
  }
});

test("doctor embedder probe fails on non-200 vector-search", async () => {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "doctor-"));
  try {
    const result = await doctor({
      config: baseConfig(vaultPath),
      fetchImpl: async (url) => {
        if (String(url).endsWith("/vector-search")) {
          return { ok: false, status: 500, text: async () => "No embedding engine configured" };
        }
        return { ok: true, status: 200, text: async () => "" };
      },
      runGit: passingRunGit(),
      readManifest: async () => ({ files: {} }),
    });
    const embedder = byName(result).get("embedder probe");
    assert.equal(embedder.ok, false);
    assert.match(embedder.message, /HTTP 500/);
    assert.match(embedder.message, /No embedding engine configured/);
  } finally {
    await rm(vaultPath, { force: true, recursive: true });
  }
});

test("doctor flags empty index when vault has files but manifest is empty", async () => {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "doctor-"));
  try {
    await writeFile(path.join(vaultPath, "note.md"), "hello");
    const result = await doctor({
      config: baseConfig(vaultPath),
      fetchImpl: passingFetch(),
      runGit: passingRunGit(),
      readManifest: async () => ({ files: {} }),
    });
    const drift = byName(result).get("index drift");
    assert.equal(drift.ok, false);
    assert.match(drift.message, /index empty/);
    assert.match(drift.message, /1 vault files/);
  } finally {
    await rm(vaultPath, { force: true, recursive: true });
  }
});

test("doctor reports drift when a vault file is missing from the manifest", async () => {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "doctor-"));
  try {
    await writeFile(path.join(vaultPath, "a.md"), "a");
    await writeFile(path.join(vaultPath, "b.md"), "b");
    const result = await doctor({
      config: baseConfig(vaultPath),
      fetchImpl: passingFetch(),
      runGit: passingRunGit(),
      readManifest: async () => ({ files: { "a.md": { hash: "x" } } }),
    });
    const drift = byName(result).get("index drift");
    assert.equal(drift.ok, false);
    assert.match(drift.message, /index drift/);
    assert.match(drift.message, /b\.md/);
  } finally {
    await rm(vaultPath, { force: true, recursive: true });
  }
});

test("doctor drift is healthy when index matches vault", async () => {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "doctor-"));
  try {
    await writeFile(path.join(vaultPath, "a.md"), "a");
    const result = await doctor({
      config: baseConfig(vaultPath),
      fetchImpl: passingFetch(),
      runGit: passingRunGit(),
      readManifest: async () => ({ files: { "a.md": { hash: "x" } } }),
    });
    assert.equal(result.ok, true);
    assert.match(byName(result).get("index drift").message, /up to date/i);
  } finally {
    await rm(vaultPath, { force: true, recursive: true });
  }
});

test("doctor drift honors custom embed extensions from config", async () => {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "doctor-"));
  try {
    await writeFile(path.join(vaultPath, "note.md"), "n");
    await writeFile(path.join(vaultPath, "draw.canvas"), "d");
    const result = await doctor({
      config: baseConfig(vaultPath, { embedExtensions: ".md,.canvas" }),
      fetchImpl: passingFetch(),
      runGit: passingRunGit(),
      readManifest: async () => ({ files: { "note.md": { hash: "x" } } }),
    });
    const drift = byName(result).get("index drift");
    assert.equal(drift.ok, false);
    assert.match(drift.message, /draw\.canvas/);
  } finally {
    await rm(vaultPath, { force: true, recursive: true });
  }
});

test("doctor upload probe surfaces the AnythingLLM error detail", async () => {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "doctor-"));
  try {
    const result = await doctor({
      config: baseConfig(vaultPath, { documentFolder: "anything-obsidian-vault-test" }),
      fetchImpl: async (url, options = {}) => {
        if (options.method === "POST" && String(url).includes("/api/v1/document/upload/")) {
          return {
            ok: false,
            status: 500,
            text: async () =>
              JSON.stringify({ error: "Folder name cannot contain path separators." }),
          };
        }
        return { ok: true, status: 200, text: async () => "" };
      },
      runGit: passingRunGit(),
      readManifest: async () => ({ files: {} }),
    });
    const probe = byName(result).get("anythingllm upload probe");
    assert.equal(probe.ok, false);
    assert.match(probe.message, /HTTP 500/);
    assert.match(probe.message, /path separators/);
  } finally {
    await rm(vaultPath, { force: true, recursive: true });
  }
});

test("doctor upload probe targets the vault folder and purges its probe folder", async () => {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "doctor-"));
  try {
    const calls = [];
    const result = await doctor({
      config: baseConfig(vaultPath, { documentFolder: "anything-obsidian-vault-test" }),
      fetchImpl: async (url, options = {}) => {
        const target = String(url);
        calls.push({ url: target, method: options.method ?? "GET" });
        if (options.method === "POST" && target.includes("/api/v1/document/upload/")) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                success: true,
                documents: [
                  { location: "anything-obsidian-vault-test-doctor/doctor-probe.json" },
                ],
              }),
          };
        }
        if (options.method === "DELETE" && target.includes("/api/v1/document/remove-folder")) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ success: true }) };
        }
        return { ok: true, status: 200, text: async () => "" };
      },
      runGit: passingRunGit(),
      readManifest: async () => ({ files: {} }),
    });
    const probe = byName(result).get("anythingllm upload probe");
    assert.equal(probe.ok, true, probe.message);
    const upload = calls.find(
      (call) => call.method === "POST" && call.url.includes("/api/v1/document/upload/"),
    );
    assert.ok(upload, "expected a document upload probe");
    assert.ok(
      upload.url.endsWith("/anything-obsidian-vault-test-doctor"),
      `unexpected upload URL: ${upload.url}`,
    );
    const cleanup = calls.find(
      (call) => call.method === "DELETE" && call.url.includes("/api/v1/document/remove-folder"),
    );
    assert.ok(cleanup, "expected the probe folder to be purged");
  } finally {
    await rm(vaultPath, { force: true, recursive: true });
  }
});
