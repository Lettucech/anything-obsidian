import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createVaultRegistry } from "../lib/vault-registry.mjs";
import { createVaultStorage } from "./vault-storage.mjs";

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
