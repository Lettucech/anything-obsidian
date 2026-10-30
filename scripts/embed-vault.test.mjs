import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { embedVault, embeddableVaultFiles } from "./embed-vault.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "any-obs-embed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root + "/vault");
  await writeFile(root + "/vault/note.md", "hello");
  const config = {
    anythingllmBaseUrl: "http://upstream.test",
    apiKey: "secret",
    workspaceSlug: "shared",
    vaultId: "work",
    vaultPath: root + "/vault",
    stateDir: root + "/state",
    documentFolder: "anything-obsidian-vault-work",
  };
  const remote = new Set();
  const calls = [];
  let counter = 0;
  const state = {
    failEmbedding: false,
    badUpload: false,
    unavailable: false,
    workspaces: ["shared", "other"],
    deferEmbeddingResponse: false,
  };
  let releaseEmbeddingResponse = () => {};
  state.embeddingGate = new Promise((resolve) => {
    releaseEmbeddingResponse = resolve;
  });
  state.releaseEmbeddingResponse = () => releaseEmbeddingResponse();
  const fetchImpl = async (url, init = {}) => {
    assert.ok(init.signal, "every request has a deadline");
    calls.push({ path: new URL(url).pathname, init });
    const pathname = new URL(url).pathname;
    let body;
    if (pathname.endsWith("/workspaces"))
      body = { workspaces: state.workspaces.map((slug) => ({ slug })) };
    else if (pathname.includes("/upload/"))
      body = state.badUpload
        ? { success: false, error: "collector failed" }
        : { documents: [{ location: `${config.documentFolder}/note-${++counter}.json` }] };
    else if (pathname.endsWith("/update-embeddings")) {
      const { adds, deletes } = JSON.parse(init.body);
      if (!state.failEmbedding) {
        adds.forEach((location) => remote.add(location));
        deletes.forEach((location) => remote.delete(location));
      }
      if (state.deferEmbeddingResponse) await state.embeddingGate;
      body = { workspace: { slug: "shared" } }; // Upstream can return 200 even when a vectorizer failed.
    } else if (pathname.endsWith("/documents")) {
      if (state.unavailable) return new Response("unavailable", { status: 503 });
      body = { documents: [...remote].map((docpath) => ({ docpath })) };
    } else return new Response("missing", { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const run = (options) => embedVault({ config, fetchImpl, pollIntervalMs: 5, ...options });
  const manifest = () => readFile(root + "/state/embed-manifest.json", "utf8").then(JSON.parse);
  return { root, config, remote, calls, state, run, manifest };
}

test("validates the workspace before uploading", async (t) => {
  const f = await fixture(t);
  f.state.workspaces = [];
  await assert.rejects(f.run(), /not found/);
  assert.equal(f.calls.filter((call) => call.path.includes("upload")).length, 0);
});

test("incremental indexing is verified, vault-attributed and idempotent", async (t) => {
  const f = await fixture(t);
  const progress = [];
  const first = await f.run({ onProgress: async (event) => progress.push(event.phase) });
  assert.equal(first.uploaded, 1);
  assert.equal(first.verified, true);
  const upload = f.calls.find((call) => call.path.includes("/upload/"));
  assert.equal(JSON.parse(upload.init.body.get("metadata")).chunkSource, "work/note.md");
  assert.ok(progress.includes("embedding"));
  assert.equal(progress.at(-1), "completed");
  const second = await f.run();
  assert.equal(second.uploaded, 0);
  assert.equal(second.removed, 0);
  assert.equal((await f.manifest()).target.workspaceSlug, "shared");
});

test("missing remote documents are repaired even when source files have not changed", async (t) => {
  const f = await fixture(t);
  await f.run();
  f.remote.clear();
  const repaired = await f.run();
  assert.equal(repaired.uploaded, 1);
  assert.equal(repaired.repaired, 1);
  assert.equal(f.remote.size, 1);
});

test("forced rebuild uploads every file and removes old copies only after replacement verification", async (t) => {
  const f = await fixture(t);
  await f.run();
  const old = [...f.remote][0];
  f.calls.length = 0;
  const result = await f.run({ all: true });
  assert.equal(result.uploaded, 1);
  assert.equal(result.removed, 1);
  assert.equal(f.remote.size, 1);
  assert.ok(!f.remote.has(old));
  const updates = f.calls
    .filter((call) => call.path.endsWith("/update-embeddings"))
    .map((call) => JSON.parse(call.init.body));
  assert.equal(updates.length, 2);
  assert.deepEqual(updates[0].deletes, []);
  assert.deepEqual(updates[1].adds, []);
});

test("HTTP success without embedded documents fails, retaining the last good manifest and index", async (t) => {
  const f = await fixture(t);
  await f.run();
  const before = await f.manifest();
  const old = [...f.remote];
  await writeFile(f.root + "/vault/note.md", "new content");
  f.state.failEmbedding = true;
  await assert.rejects(f.run(), /verification failed/);
  assert.deepEqual(await f.manifest(), before);
  assert.deepEqual([...f.remote], old);
});

test("a slow upstream response never blocks a verified embed", async (t) => {
  const f = await fixture(t);
  // Upstream pins the documents right away but only answers the request much
  // later — the old blocking wait sat on this response until the client
  // deadline killed the job.
  f.state.deferEmbeddingResponse = true;
  const progress = [];
  const result = await f.run({
    onProgress: async (event) => progress.push(`${event.phase}:${event.completed ?? 0}/${event.total ?? 0}`),
  });
  assert.equal(result.verified, true);
  assert.ok(progress.includes("embedding:1/1"));
  f.state.releaseEmbeddingResponse(); // let the dangling request settle
});

test("upload failures and unverifiable remote state never report successful indexing", async (t) => {
  const f = await fixture(t);
  f.state.badUpload = true;
  await assert.rejects(f.run(), /collector failed/);
  await assert.rejects(f.manifest(), { code: "ENOENT" });
  f.state.badUpload = false;
  f.state.unavailable = true;
  await assert.rejects(f.run(), /Cannot verify/);
});

test("deleted and untracked owned documents are removed without touching sibling vaults", async (t) => {
  const f = await fixture(t);
  await f.run();
  f.remote.add("anything-obsidian-vault-other/sibling.json");
  f.remote.add(`${f.config.documentFolder}/stale.json`);
  await rm(f.root + "/vault/note.md");
  const result = await f.run();
  assert.equal(result.removed, 2);
  assert.deepEqual([...f.remote], ["anything-obsidian-vault-other/sibling.json"]);
  assert.deepEqual((await f.manifest()).files, {});
});

test("a different target workspace cannot reuse an old manifest", async (t) => {
  const f = await fixture(t);
  await f.run();
  f.remote.clear();
  f.config.workspaceSlug = "other";
  assert.equal((await f.run()).uploaded, 1);
});

test("concurrent indexing of the same vault serializes and leaves one verified copy", async (t) => {
  const f = await fixture(t);
  const results = await Promise.all([f.run(), f.run()]);
  assert.equal(
    results.reduce((sum, item) => sum + item.uploaded, 0),
    1,
  );
  assert.equal(f.remote.size, 1);
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
