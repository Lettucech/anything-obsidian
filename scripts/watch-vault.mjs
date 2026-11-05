#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");

export async function syncVaultOnce({ config, deps = {} }) {
  const runner = (command, args, options) => {
    config.signal?.throwIfAborted();
    return (deps.run ?? run)(command, args, {
      ...options,
      ...(config.signal ? { signal: config.signal } : {}),
    });
  };
  const capturer = (command, args, options) => {
    config.signal?.throwIfAborted();
    return (deps.capture ?? capture)(command, args, {
      ...options,
      ...(config.signal ? { signal: config.signal } : {}),
    });
  };
  const env = gitEnv(config);
  const hasGit = deps.hasGit ?? isGitRepository;

  // Location flavour and git-ness are independent: an imported folder may
  // have no checkout at all, in which case every git step is skipped and
  // only the embed pass runs.
  const isCheckout = await hasGit(config.vaultPath);

  if (isCheckout) await configureGit(config, runner);
  let pushSucceeded = !config.gitAutoPush || !isCheckout;

  if (config.gitAutoPull && isCheckout) {
    await runner("git", ["pull", "--rebase", "--autostash", config.gitRemote, config.gitBranch], {
      cwd: config.vaultPath,
      env,
    });
  }

  if (isCheckout) {
    const statusBefore = await capturer("git", ["status", "--porcelain"], {
      cwd: config.vaultPath,
      env,
    });
    if (statusBefore.trim()) {
      await runner("git", ["add", "-A"], { cwd: config.vaultPath, env });
      const statusAfterAdd = await capturer("git", ["status", "--porcelain"], {
        cwd: config.vaultPath,
        env,
      });
      if (statusAfterAdd.trim()) {
        await runner("git", ["commit", "-m", commitMessage(config)], { cwd: config.vaultPath, env });
        log("Committed vault changes");
      }
    } else {
      log("No vault changes to commit");
    }
  }

  if (config.gitAutoPush && isCheckout) {
    if (config.gitPushUrl) {
      await runner("git", ["push", config.gitPushUrl, `HEAD:${config.gitBranch}`], {
        cwd: config.vaultPath,
        env,
      });
    } else {
      await runner("git", ["push", "-u", config.gitRemote, config.gitBranch], {
        cwd: config.vaultPath,
        env,
      });
    }
    pushSucceeded = true;
    log("Pushed vault changes");
  }

  return { pushed: pushSucceeded, embedded: false };
}

export function shouldEmbedAfterSync({ embedAfterSync, gitAutoPush, pushSucceeded }) {
  return embedAfterSync && (!gitAutoPush || pushSucceeded);
}

export function gitEnv(config) {
  if (!config.gitAuthToken) return process.env;
  return {
    ...process.env,
    GIT_ASKPASS: path.join(repoRoot, "scripts", "git-askpass.sh"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_USERNAME: config.gitAuthUsername || "x-access-token",
    GIT_PASSWORD: config.gitAuthToken,
  };
}

async function isGitRepository(dir) {
  try {
    await access(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function configureGit(config, runner = run) {
  await runner("git", ["config", "user.name", config.gitUserName], { cwd: config.vaultPath });
  await runner("git", ["config", "user.email", config.gitUserEmail], { cwd: config.vaultPath });
}

async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      signal: options.signal,
      timeout: 120_000,
      env: options.env ?? process.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

async function capture(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd: options.cwd,
      signal: options.signal,
      timeout: 120_000,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}: ${stderr}`));
    });
  });
}

function commitMessage(config) {
  return `${config.gitCommitMessagePrefix} ${new Date().toISOString()}`;
}

function log(message) {
  console.log(`[anything-obsidian-sync] ${new Date().toISOString()} ${message}`);
}
