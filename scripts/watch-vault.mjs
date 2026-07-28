#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");

export async function syncVaultOnce({ config, deps = {} }) {
  const runner = deps.run ?? run;
  const capturer = deps.capture ?? capture;
  const env = gitEnv(config);

  await configureGit(config, runner);
  let pushSucceeded = !config.gitAutoPush;

  if (config.gitAutoPull) {
    await runner("git", ["pull", "--rebase", "--autostash", config.gitRemote, config.gitBranch], {
      cwd: config.vaultPath,
      env,
    });
  }

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

  if (config.gitAutoPush) {
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

async function configureGit(config, runner = run) {
  await runner("git", ["config", "user.name", config.gitUserName], { cwd: config.vaultPath });
  await runner("git", ["config", "user.email", config.gitUserEmail], { cwd: config.vaultPath });
}

async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
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
