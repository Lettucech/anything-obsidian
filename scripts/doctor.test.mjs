import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { doctor } from "./doctor.mjs";

function passingFetch() {
  return async () => ({ ok: true, status: 200, text: async () => "" });
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

test("doctor git check reports failure and hints at KB_GIT_AUTH_TOKEN", async () => {
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
    assert.match(git.message, /KB_GIT_AUTH_TOKEN/);
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
