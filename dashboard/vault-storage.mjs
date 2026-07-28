import { execFile } from "node:child_process";
import { access, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function createVaultStorage({ registry, runGit = runGitDefault } = {}) {
  if (!registry) throw new Error("registry is required");

  return {
    async prepare(input) {
      assertSlug(input.id, "id");
      assertSlug(input.directory, "directory");
      const vaultPath = registry.resolvePath(input);
      if (input.vaultMode === "create") {
        await mkdir(vaultPath, { recursive: false });
        try {
          await runGit(["init", "--initial-branch=main"], vaultPath);
        } catch (error) {
          throw new Error(`Could not initialise Git repository for '${input.directory}': ${message(error)}`);
        }
        return vaultPath;
      }
      await assertGitRepository(vaultPath, input.directory);
      return vaultPath;
    },
  };
}

function assertSlug(value, name) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(value ?? ""))) {
    throw new Error(`${name} must be lowercase dash-separated text beneath the vault root`);
  }
}

async function assertGitRepository(vaultPath, directory) {
  try {
    const info = await stat(vaultPath);
    if (!info.isDirectory()) throw new Error("not a directory");
    await access(path.join(vaultPath, ".git"));
  } catch {
    throw new Error(`Vault '${directory}' must be an existing Git repository beneath the configured vault root`);
  }
}

async function runGitDefault(args, cwd) {
  await execFileAsync("git", args, { cwd });
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
