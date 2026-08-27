import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
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
  return {
    vaultPath,
    service: createVaultFileService({
      vaultsRoot: root,
      registryPath: path.join(root, "vaults.json"),
      hostVaultsRoot: root,
    }),
  };
}

test("lists only supported source files without Git metadata", async () => {
  const { service, vaultPath } = await fixture();
  await mkdir(path.join(vaultPath, ".git"));
  await mkdir(path.join(vaultPath, "Projects"));
  await writeFile(path.join(vaultPath, "Projects", "Plan.md"), "# Plan\n");
  await writeFile(path.join(vaultPath, "drawing.canvas"), "{}");
  await writeFile(path.join(vaultPath, "attachment.png"), "binary");

  const result = await service.listFiles({ vaultId: "work" });

  assert.deepEqual(result.files.map((file) => file.path).sort(), ["Projects/Plan.md", "drawing.canvas"]);
});

test("reads bounded line ranges from a Markdown source file", async () => {
  const { service, vaultPath } = await fixture();
  await writeFile(path.join(vaultPath, "Long.md"), "one\ntwo\nthree\n");

  const result = await service.readFile({ vaultId: "work", path: "Long.md", startLine: 2, maxLines: 1 });

  assert.equal(result.content, "two\n");
  assert.equal(result.nextLine, 3);
  assert.match(result.file.sha256, /^[a-f0-9]{64}$/);
});

test("rejects a source file reached through an intermediate symlink", async () => {
  const { service, vaultPath } = await fixture();
  const outside = path.join(path.dirname(vaultPath), "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "Secret.md"), "not in the vault\n");
  await symlink(outside, path.join(vaultPath, "Linked"));

  await assert.rejects(() => service.readFile({ vaultId: "work", path: "Linked/Secret.md" }), /escaped vault root/);
});

test("returns the configured host directory for a selected local vault", async () => {
  const { service, vaultPath } = await fixture();
  assert.deepEqual(await service.directory({ vaultId: "work" }), { vaultId: "work", directory: vaultPath });
});

test("does not provide direct vault-write operations", async () => {
  const { service } = await fixture();
  assert.equal("writeFile" in service, false);
  assert.equal("applyPatch" in service, false);
  assert.equal("beginUpload" in service, false);
  assert.equal("appendUpload" in service, false);
  assert.equal("finishUpload" in service, false);
});
