import { execFile } from "node:child_process";
import { access, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const dashboardRoot = path.dirname(fileURLToPath(import.meta.url));

export function createVaultStorage({ registry, runGit = runGitDefault } = {}) {
  if (!registry) throw new Error("registry is required");

  return {
    async clone(input) {
      const repositoryUrl = requiredRepositoryUrl(input.repositoryUrl);
      const identity = vaultIdentity(input, repositoryUrl);
      const vaultPath = registry.resolvePath(identity);
      const env = gitEnv(input.gitAuth);

      try {
        await runGit(["clone", "--", repositoryUrl, vaultPath], path.dirname(vaultPath), env);
        const discoveredUrl = (await runGit(["remote", "get-url", "origin"], vaultPath, env)).trim();
        const branch = (await runGit(["branch", "--show-current"], vaultPath, env)).trim();
        if (!branch) throw new Error("The cloned repository has no checked-out branch");
        return {
          ...identity,
          repositoryUrl: discoveredUrl || repositoryUrl,
          gitRemote: "origin",
          gitBranch: branch,
        };
      } catch (error) {
        throw new Error(`Could not clone '${repositoryUrl}': ${message(error)}`);
      }
    },
    async import(input) {
      assertSlug(input.id, "id");
      assertSlug(input.directory, "directory");
      const vaultPath = registry.resolvePath(input);
      await assertGitRepository(vaultPath, input.directory);
      const repositoryUrl = (await runGit(["remote", "get-url", "origin"], vaultPath)).trim();
      const gitBranch = (await runGit(["branch", "--show-current"], vaultPath)).trim();
      if (!repositoryUrl || !gitBranch) {
        throw new Error(`Vault '${input.directory}' must have an origin remote and checked-out branch`);
      }
      return { repositoryUrl, gitRemote: "origin", gitBranch };
    },
  };
}

function vaultIdentity(input, repositoryUrl) {
  const inferred = slugify(repositoryName(repositoryUrl));
  const id = String(input.id || inferred);
  const directory = String(input.directory || id);
  assertSlug(id, "id");
  assertSlug(directory, "directory");
  return {
    name: String(input.name || repositoryName(repositoryUrl)),
    id,
    directory,
  };
}

function requiredRepositoryUrl(value) {
  const repositoryUrl = String(value ?? "").trim();
  try {
    const parsed = new URL(repositoryUrl);
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error();
    }
  } catch {
    throw new Error("repositoryUrl must be an HTTP(S) Git URL without embedded credentials");
  }
  return repositoryUrl;
}

function repositoryName(repositoryUrl) {
  const pathName = new URL(repositoryUrl).pathname.replace(/\/+$/, "");
  const name = pathName.split("/").at(-1)?.replace(/\.git$/i, "") || "";
  if (!name) throw new Error("repositoryUrl must include a repository name");
  return name;
}

function slugify(value) {
  const slug = String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!slug) throw new Error("repositoryUrl must produce a lowercase vault id");
  return slug;
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

function gitEnv(auth) {
  if (auth?.mode !== "https-token" || !auth.token) return process.env;
  return {
    ...process.env,
    GIT_ASKPASS: path.join(dashboardRoot, "git-askpass.sh"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_USERNAME: auth.username || "x-access-token",
    GIT_PASSWORD: auth.token,
  };
}

async function runGitDefault(args, cwd, env = process.env) {
  const { stdout } = await execFileAsync("git", args, { cwd, env });
  return stdout;
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
