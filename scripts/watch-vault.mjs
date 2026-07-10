#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadEnvFile, resolveConfig } from "./lib/env.mjs";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");

let watchConfig;
let snapshot;
let deadline = 0;
let syncing = false;
let changeCount = 0;

export async function syncVaultOnce({ config }) {
  await configureGit(config);
  let pushSucceeded = !config.gitAutoPush;

  if (config.gitAutoPull) {
    await run("git", ["pull", "--rebase", "--autostash", config.gitRemote, config.gitBranch], {
      cwd: config.vaultPath,
    });
  }

  const statusBefore = await capture("git", ["status", "--porcelain"], {
    cwd: config.vaultPath,
  });
  if (statusBefore.trim()) {
    await run("git", ["add", "-A"], { cwd: config.vaultPath });
    const statusAfterAdd = await capture("git", ["status", "--porcelain"], {
      cwd: config.vaultPath,
    });
    if (statusAfterAdd.trim()) {
      await run("git", ["commit", "-m", commitMessage(config)], { cwd: config.vaultPath });
      log("Committed vault changes");
    }
  } else {
    log("No vault changes to commit");
  }

  if (config.gitAutoPush) {
    if (config.gitPushUrl) {
      await run("git", ["push", config.gitPushUrl, `HEAD:${config.gitBranch}`], {
        cwd: config.vaultPath,
      });
    } else {
      await run("git", ["push", "-u", config.gitRemote, config.gitBranch], {
        cwd: config.vaultPath,
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

async function main() {
  watchConfig = await loadWatchConfig();
  snapshot = await scanVault(watchConfig);

  log(`Watching ${watchConfig.vaultPath}`);
  log(
    `Debounce: ${Math.round(watchConfig.debounceMs / 1000)}s; poll: ${Math.round(
      watchConfig.pollMs / 1000,
    )}s`,
  );

  try {
    const initialStatus = await capture("git", ["status", "--porcelain"], {
      cwd: watchConfig.vaultPath,
    });
    if (initialStatus.trim()) {
      deadline = Date.now() + watchConfig.debounceMs;
      changeCount = 1;
      log("Existing vault changes detected; auto sync scheduled after idle window");
    }
  } catch (error) {
    logError("Failed to inspect initial vault Git status", error);
  }

  setInterval(tick, watchConfig.pollMs);
}

async function tick() {
  if (syncing) return;

  let current;
  try {
    current = await scanVault(watchConfig);
  } catch (error) {
    logError("Failed to scan vault", error);
    return;
  }

  if (!sameSnapshot(snapshot, current)) {
    snapshot = current;
    changeCount += 1;
    deadline = Date.now() + watchConfig.debounceMs;
    log(`Change detected; auto sync scheduled after idle window (${changeCount})`);
    return;
  }

  if (!deadline || Date.now() < deadline) return;

  deadline = 0;
  syncing = true;
  try {
    await syncOnceForWatcher();
    snapshot = await scanVault(watchConfig);
    changeCount = 0;
  } catch (error) {
    logError("Auto sync failed", error);
  } finally {
    syncing = false;
  }
}

async function syncOnceForWatcher() {
  log("Idle window reached; starting auto sync");

  const syncResult = await syncVaultOnce({ config: watchConfig });

  if (
    shouldEmbedAfterSync({
      embedAfterSync: watchConfig.embedAfterSync,
      gitAutoPush: watchConfig.gitAutoPush,
      pushSucceeded: syncResult.pushed,
    })
  ) {
    try {
      await run("node", ["scripts/embed-vault.mjs"], { cwd: repoRoot });
      log("Re-embedding complete");
    } catch (error) {
      logError("Re-embedding failed; git sync already completed", error);
    }
  } else if (watchConfig.embedAfterSync) {
    log("Skipped re-embedding because Git push did not complete");
  }
}

async function configureGit(config) {
  await run("git", ["config", "user.name", config.gitUserName], { cwd: config.vaultPath });
  await run("git", ["config", "user.email", config.gitUserEmail], { cwd: config.vaultPath });
}

async function scanVault(config, dir = config.vaultPath, base = config.vaultPath) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = new Map();

  for (const entry of entries) {
    if (entry.isDirectory() && config.watchExcludeDirs.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const childFiles = await scanVault(config, abs, base);
      for (const [key, value] of childFiles.entries()) files.set(key, value);
      continue;
    }
    if (!entry.isFile()) continue;
    const info = await stat(abs);
    files.set(toPosix(path.relative(base, abs)), `${info.size}:${info.mtimeMs}`);
  }

  return files;
}

function sameSnapshot(left, right) {
  if (left.size !== right.size) return false;
  for (const [key, value] of left.entries()) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
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
      env: process.env,
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
  return `${config.commitPrefix ?? "Auto sync vault"} ${new Date().toISOString()}`;
}

async function loadWatchConfig() {
  const env = { ...(await loadEnvFile(path.join(repoRoot, ".env"))), ...process.env };
  return extendWatchConfig(resolveConfig(env), env);
}

function extendWatchConfig(config, env) {
  return {
    ...config,
    pollMs: seconds(env.KB_WATCH_INTERVAL_SECONDS, 300) * 1000,
    debounceMs: seconds(env.KB_SYNC_DEBOUNCE_SECONDS, 300) * 1000,
    watchExcludeDirs: new Set(csv(env.KB_WATCH_EXCLUDE_DIRS ?? ".git")),
    commitPrefix: env.KB_GIT_COMMIT_MESSAGE_PREFIX ?? "Auto sync vault",
    embedAfterSync: bool(env.KB_EMBED_AFTER_SYNC, true),
  };
}

function csv(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function bool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function seconds(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function log(message) {
  console.log(`[anything-obsidian-sync] ${new Date().toISOString()} ${message}`);
}

function logError(message, error) {
  console.error(`[anything-obsidian-sync] ${new Date().toISOString()} ${message}`);
  console.error(error instanceof Error ? error.stack ?? error.message : error);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
