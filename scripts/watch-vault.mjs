#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");
const env = loadEnv(path.join(repoRoot, ".env"));

const vaultPath = path.resolve(repoRoot, env.VAULT_PATH ?? "../vault");
const pollMs = seconds(env.KB_WATCH_INTERVAL_SECONDS, 300) * 1000;
const debounceMs = seconds(env.KB_SYNC_DEBOUNCE_SECONDS, 300) * 1000;
const watchExcludeDirs = new Set(csv(env.KB_WATCH_EXCLUDE_DIRS ?? ".git"));
const gitRemote = env.KB_GIT_REMOTE ?? "origin";
const gitBranch = env.KB_GIT_BRANCH ?? "main";
const gitAutoPull = bool(env.KB_GIT_AUTO_PULL, true);
const gitAutoPush = bool(env.KB_GIT_AUTO_PUSH, true);
const gitUserName = env.KB_GIT_USER_NAME ?? "anything-obsidian";
const gitUserEmail = env.KB_GIT_USER_EMAIL ?? "anything-obsidian@local";
const commitPrefix = env.KB_GIT_COMMIT_MESSAGE_PREFIX ?? "Auto sync vault";
const gitPushUrl = env.KB_GIT_PUSH_URL ?? "";
const embedAfterSync = bool(env.KB_EMBED_AFTER_SYNC, true);

let snapshot;
let deadline = 0;
let syncing = false;
let changeCount = 0;

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}

async function main() {
  snapshot = await scanVault();

  log(`Watching ${vaultPath}`);
  log(`Debounce: ${Math.round(debounceMs / 1000)}s; poll: ${Math.round(pollMs / 1000)}s`);

  try {
    const initialStatus = await capture("git", ["status", "--porcelain"], {
      cwd: vaultPath,
    });
    if (initialStatus.trim()) {
      deadline = Date.now() + debounceMs;
      changeCount = 1;
      log("Existing vault changes detected; auto sync scheduled after idle window");
    }
  } catch (error) {
    logError("Failed to inspect initial vault Git status", error);
  }

  setInterval(tick, pollMs);
}

async function tick() {
  if (syncing) return;

  let current;
  try {
    current = await scanVault();
  } catch (error) {
    logError("Failed to scan vault", error);
    return;
  }

  if (!sameSnapshot(snapshot, current)) {
    snapshot = current;
    changeCount += 1;
    deadline = Date.now() + debounceMs;
    log(`Change detected; auto sync scheduled after idle window (${changeCount})`);
    return;
  }

  if (!deadline || Date.now() < deadline) return;

  deadline = 0;
  syncing = true;
  try {
    await syncOnce();
    snapshot = await scanVault();
    changeCount = 0;
  } catch (error) {
    logError("Auto sync failed", error);
  } finally {
    syncing = false;
  }
}

async function syncOnce() {
  log("Idle window reached; starting auto sync");

  await configureGit();
  let pushSucceeded = !gitAutoPush;

  if (gitAutoPull) {
    await run("git", ["pull", "--rebase", "--autostash", gitRemote, gitBranch], {
      cwd: vaultPath,
    });
  }

  const statusBefore = await capture("git", ["status", "--porcelain"], {
    cwd: vaultPath,
  });
  if (statusBefore.trim()) {
    await run("git", ["add", "-A"], { cwd: vaultPath });
    const statusAfterAdd = await capture("git", ["status", "--porcelain"], {
      cwd: vaultPath,
    });
    if (statusAfterAdd.trim()) {
      await run("git", ["commit", "-m", commitMessage()], { cwd: vaultPath });
      log("Committed vault changes");
    }
  } else {
    log("No vault changes to commit");
  }

  if (gitAutoPush) {
    try {
      if (gitPushUrl) {
        await run("git", ["push", gitPushUrl, `HEAD:${gitBranch}`], { cwd: vaultPath });
      } else {
        await run("git", ["push", "-u", gitRemote, gitBranch], { cwd: vaultPath });
      }
      pushSucceeded = true;
      log("Pushed vault changes");
    } catch (error) {
      logError("Git push failed; local commit is kept and re-embedding will wait", error);
    }
  }

  if (shouldEmbedAfterSync({ embedAfterSync, gitAutoPush, pushSucceeded })) {
    try {
      await run("node", ["scripts/embed-vault.mjs"], { cwd: repoRoot });
      log("Re-embedding complete");
    } catch (error) {
      logError("Re-embedding failed; git sync already completed", error);
    }
  } else if (embedAfterSync) {
    log("Skipped re-embedding because Git push did not complete");
  }
}

export function shouldEmbedAfterSync({ embedAfterSync, gitAutoPush, pushSucceeded }) {
  return embedAfterSync && (!gitAutoPush || pushSucceeded);
}

async function configureGit() {
  await run("git", ["config", "user.name", gitUserName], { cwd: vaultPath });
  await run("git", ["config", "user.email", gitUserEmail], { cwd: vaultPath });
}

async function scanVault(dir = vaultPath, base = vaultPath) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = new Map();

  for (const entry of entries) {
    if (entry.isDirectory() && watchExcludeDirs.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const childFiles = await scanVault(abs, base);
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

function commitMessage() {
  return `${commitPrefix} ${new Date().toISOString()}`;
}

function loadEnv(file) {
  const values = {};
  try {
    const raw = readFileSync(file, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index === -1) continue;
      const key = trimmed.slice(0, index).trim();
      let value = trimmed.slice(index + 1).trim();
      value = value.replace(/^['"]|['"]$/g, "");
      values[key] = process.env[key] ?? value;
    }
  } catch {
    // Missing .env is acceptable for config validation; runtime checks happen elsewhere.
  }
  return { ...values, ...process.env };
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
