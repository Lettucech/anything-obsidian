import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createVaultRegistry } from "../lib/vault-registry.mjs";
import { createVaultStorage } from "./vault-storage.mjs";

test("imports a directory anywhere on disk and records its git origin when it has one", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "anything-obsidian-vaults-"));
  const imported = await mkdtemp(path.join(tmpdir(), "My Notes_2026-"));
  const registry = createVaultRegistry({ rootPath: root, registryPath: path.join(root, "registry.json") });
  const storage = createVaultStorage({
    registry,
    runGit: async (args) => {
      if (args[0] === "remote") return "https://github.com/acme/my-notes.git";
      if (args[0] === "branch") return "main";
      return "";
    },
  });

  const discovered = await storage.import({ importPath: imported, name: "My Notes" });

  assert.equal(discovered.location, "imported");
  assert.equal(discovered.importPath, imported);
  assert.equal(discovered.name, "My Notes");
  assert.match(discovered.directory, /^my-notes-[a-z0-9-]+$/);
  assert.equal(discovered.repositoryUrl, "https://github.com/acme/my-notes.git");
  assert.equal(discovered.gitBranch, "main");
});

test("imports a plain directory with no git repository and records no remote", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "anything-obsidian-vaults-"));
  const imported = await mkdtemp(path.join(tmpdir(), "Plain Notes-"));
  const registry = createVaultRegistry({ rootPath: root, registryPath: path.join(root, "registry.json") });
  const storage = createVaultStorage({
    registry,
    runGit: async () => { throw new Error("not a git repository"); },
  });

  const discovered = await storage.import({ importPath: imported });

  assert.equal(discovered.location, "imported");
  assert.equal(discovered.repositoryUrl, undefined);
  assert.equal(discovered.gitBranch, undefined);
});

test("rejects an import path that does not exist or is not a directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "anything-obsidian-vaults-"));
  const registry = createVaultRegistry({ rootPath: root, registryPath: path.join(root, "registry.json") });
  const storage = createVaultStorage({ registry, runGit: async () => "" });
  const file = path.join(root, "a-file.md");
  writeFileSync(file, "# not a directory\n");

  await assert.rejects(() => storage.import({ importPath: path.join(root, "missing") }), /does not exist/);
  await assert.rejects(() => storage.import({ importPath: file }), /not a directory/);
});

test("clones an HTTPS repository and discovers its origin and default branch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "anything-obsidian-vaults-"));
  const registry = createVaultRegistry({ rootPath: root, registryPath: path.join(root, "registry.json") });
  const commands = [];
  const storage = createVaultStorage({
    registry,
    runGit: async (args, cwd, env) => {
      commands.push({ args, cwd, env });
      if (args[0] === "remote") return "https://github.com/acme/work-notes.git";
      if (args[0] === "branch") return "main";
      return "";
    },
  });

  const cloned = await storage.clone({
    repositoryUrl: "https://github.com/acme/work-notes.git",
    gitAuth: { mode: "https-token", username: "oauth2", token: "secret" },
  });

  assert.deepEqual(cloned, {
    name: "work-notes",
    id: "work-notes",
    directory: "work-notes",
    repositoryUrl: "https://github.com/acme/work-notes.git",
    gitRemote: "origin",
    gitBranch: "main",
  });
  assert.deepEqual(commands.map(({ args, cwd }) => ({ args, cwd })), [
    { args: ["clone", "--", "https://github.com/acme/work-notes.git", path.join(root, "work-notes")], cwd: root },
    { args: ["remote", "get-url", "origin"], cwd: path.join(root, "work-notes") },
    { args: ["branch", "--show-current"], cwd: path.join(root, "work-notes") },
  ]);
  assert.equal(commands[0].env.GIT_PASSWORD, "secret");
  await assert.rejects(
    () => storage.clone({ repositoryUrl: "ssh://git@example.test/work.git" }),
    /HTTP\(S\) Git URL/,
  );
});

test("tests HTTPS repository access without creating a vault directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "anything-obsidian-vaults-"));
  const registry = createVaultRegistry({ rootPath: root, registryPath: path.join(root, "registry.json") });
  const commands = [];
  const storage = createVaultStorage({
    registry,
    runGit: async (args, cwd, env) => {
      commands.push({ args, cwd, env });
      return "abc\tHEAD\n";
    },
  });

  await storage.testConnection({
    repositoryUrl: "https://github.com/acme/work-notes.git",
    gitAuth: { mode: "https-token", username: "x-access-token", token: "secret" },
  });

  assert.deepEqual(commands.map(({ args }) => args), [
    ["ls-remote", "--heads", "https://github.com/acme/work-notes.git"],
  ]);
  assert.equal(commands[0].env.GIT_PASSWORD, "secret");
});
