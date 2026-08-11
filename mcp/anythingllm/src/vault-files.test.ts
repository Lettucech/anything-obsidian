import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createVaultFileService } from "./vault-files.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "anything-obsidian-vault-files-"));
  const vaultPath = path.join(root, "work");
  await mkdir(vaultPath);
  await writeFile(
    path.join(root, "vaults.json"),
    JSON.stringify({
      vaults: [{
        id: "work",
        name: "Work",
        directory: "work",
        workspaceSlug: "work",
        enabled: true,
        accessMode: "open",
        allowlist: [],
      }],
    }),
  );

  const reindexed: string[] = [];
  return {
    root,
    vaultPath,
    reindexed,
    service: createVaultFileService({
      vaultsRoot: root,
      registryPath: path.join(root, "vaults.json"),
      reindex: async (vaultId) => {
        reindexed.push(vaultId);
        return { status: "queued", jobId: "job-1" };
      },
    }),
  };
}

test("writes a vault-relative Markdown file atomically and queues an incremental reindex", async () => {
  const { service, vaultPath, reindexed } = await fixture();

  const result = await service.writeFile({
    vaultId: "work",
    path: "Projects/Plan.md",
    content: "# Plan\n",
  });

  assert.equal(await readFile(path.join(vaultPath, "Projects/Plan.md"), "utf8"), "# Plan\n");
  assert.equal(result.file.path, "Projects/Plan.md");
  assert.match(result.file.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.reindex, { status: "queued", jobId: "job-1" });
  assert.deepEqual(reindexed, ["work"]);
});

test("preserves the source write and reports an unqueued reindex", async () => {
  const { root } = await fixture();
  const service = createVaultFileService({
    vaultsRoot: root,
    registryPath: path.join(root, "vaults.json"),
    reindex: async () => { throw new Error("AnythingLLM is unavailable"); },
  });

  const result = await service.writeFile({ vaultId: "work", path: "Offline.md", content: "saved" });

  assert.deepEqual(result.reindex, { status: "not_queued", error: "AnythingLLM is unavailable" });
});

test("requires the current hash before replacing a file", async () => {
  const { service } = await fixture();
  const created = await service.writeFile({ vaultId: "work", path: "Plan.md", content: "first" });

  await assert.rejects(
    () => service.writeFile({ vaultId: "work", path: "Plan.md", content: "second" }),
    /expectedSha256 is required/,
  );
  await assert.rejects(
    () => service.writeFile({
      vaultId: "work",
      path: "Plan.md",
      content: "second",
      expectedSha256: "0".repeat(64),
    }),
    /changed since it was read/,
  );

  await service.writeFile({
    vaultId: "work",
    path: "Plan.md",
    content: "second",
    expectedSha256: created.file.sha256,
  });
});

test("rejects traversal, Git metadata, and unsupported file types", async () => {
  const { service } = await fixture();

  await assert.rejects(
    () => service.writeFile({ vaultId: "work", path: "../outside.md", content: "no" }),
    /relative vault path/,
  );
  await assert.rejects(
    () => service.writeFile({ vaultId: "work", path: ".git/config", content: "no" }),
    /Git metadata/,
  );
  await assert.rejects(
    () => service.writeFile({ vaultId: "work", path: "attachment.png", content: "no" }),
    /only supports/,
  );
});

test("reads bounded line ranges from a large Markdown file", async () => {
  const { service, vaultPath } = await fixture();
  await writeFile(path.join(vaultPath, "Long.md"), "one\ntwo\nthree\n");

  const result = await service.readFile({ vaultId: "work", path: "Long.md", startLine: 2, maxLines: 1 });

  assert.equal(result.content, "two\n");
  assert.equal(result.nextLine, 3);
});

test("patches one unique fragment without sending the whole source file back through MCP", async () => {
  const { service, vaultPath } = await fixture();
  const created = await service.writeFile({ vaultId: "work", path: "Plan.md", content: "# Plan\nstatus: draft\n" });

  await service.applyPatch({
    vaultId: "work",
    path: "Plan.md",
    expectedSha256: created.file.sha256,
    oldText: "status: draft",
    newText: "status: ready",
  });

  assert.equal(await readFile(path.join(vaultPath, "Plan.md"), "utf8"), "# Plan\nstatus: ready\n");
});

test("builds a large new Markdown file from bounded upload chunks and reindexes only once", async () => {
  const { service, vaultPath, reindexed } = await fixture();
  const upload = await service.beginUpload({ vaultId: "work", path: "Large.md" });

  await service.appendUpload({ uploadId: upload.uploadId, contentBase64: Buffer.from("# Large\n").toString("base64") });
  await service.appendUpload({ uploadId: upload.uploadId, contentBase64: Buffer.from("content\n").toString("base64") });
  const completed = await service.finishUpload({ uploadId: upload.uploadId });

  assert.equal(await readFile(path.join(vaultPath, "Large.md"), "utf8"), "# Large\ncontent\n");
  assert.equal(completed.reindex.status, "queued");
  assert.deepEqual(reindexed, ["work"]);
});
