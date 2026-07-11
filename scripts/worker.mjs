#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { doctor } from "./doctor.mjs";
import { embedVault } from "./embed-vault.mjs";
import { loadEnvFile, resolveConfig } from "./lib/env.mjs";
import { shouldEmbedAfterSync, syncVaultOnce } from "./watch-vault.mjs";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");

const defaultDeps = {
  doctor,
  embedVault,
  loadConfig,
  loadEnv: loadRuntimeEnv,
  logger: createLogger(),
  sleep,
  shouldEmbedAfterSync,
  syncVaultOnce,
};

export async function runWorker(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const worker = { ...defaultDeps, ...deps };

  const [command] = argv;

  switch (command) {
    case "embed":
      return runCommand(async () => {
        const config = await worker.loadConfig(env);
        worker.logger.info("Embedding command started");
        const result = await worker.embedVault({ config, all: argv.includes("--all") });
        worker.logger.info(formatEmbedResult("Embedding command completed", result));
        console.log(JSON.stringify(result, null, 2));
        return 0;
      });
    case "sync":
      return runCommand(async () => {
        const config = await worker.loadConfig(env);
        const result = await syncAndEmbed({ worker, config });
        console.log(JSON.stringify(result, null, 2));
        return 0;
      });
    case "autosync":
      return runAutosync({ env, worker });
    case "doctor":
      return runCommand(async () => {
        const config = await worker.loadConfig(env);
        const result = await worker.doctor({ config });
        console.log(JSON.stringify(result, null, 2));
        return result.ok ? 0 : 1;
      });
    case "-h":
    case "--help":
    case "help":
    case undefined:
      printUsage();
      return command ? 0 : 2;
    default:
      console.error(`Unknown worker command: ${command}`);
      printUsage();
      return 2;
  }
}

async function loadConfig(env) {
  return resolveConfig(await loadRuntimeEnv(env));
}

async function loadRuntimeEnv(env) {
  return {
    ...(await loadEnvFile(path.join(repoRoot, ".env"))),
    ...env,
  };
}

async function runCommand(fn) {
  try {
    return await fn();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function printUsage() {
  console.error(`Usage: node scripts/worker.mjs <command>

Commands:
  embed [--all]  Embed vault documents into AnythingLLM
  sync           Sync vault Git changes, then embed after successful push
  autosync       Keep syncing and embedding on an interval
  doctor         Check Docker-visible config and service reachability`);
}

async function runAutosync({ env, worker }) {
  worker.logger.info("Autosync loop started");

  let running = true;
  while (running) {
    const runtimeEnv = await worker.loadEnv(env);
    const intervalMs = seconds(runtimeEnv.KB_SYNC_INTERVAL_SECONDS, 300) * 1000;

    try {
      worker.logger.info(`Autosync round started; intervalSeconds=${Math.round(intervalMs / 1000)}`);
      const config = await worker.loadConfig(env);
      const result = await syncAndEmbed({ worker, config });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      worker.logger.error(`Autosync round failed: ${errorMessage(error)}`);
    }

    worker.logger.info(`Autosync waiting ${Math.round(intervalMs / 1000)}s before next round`);
    running = await worker.sleep(intervalMs);
  }

  return 0;
}

async function syncAndEmbed({ worker, config }) {
  worker.logger.info("Sync started");
  const syncResult = await worker.syncVaultOnce({ config });
  worker.logger.info(`Git sync completed; pushed=${syncResult.pushed}`);
  let embedded = false;
  if (
    worker.shouldEmbedAfterSync({
      embedAfterSync: true,
      gitAutoPush: config.gitAutoPush,
      pushSucceeded: syncResult.pushed,
    })
  ) {
    worker.logger.info("Embedding started");
    const embedResult = await worker.embedVault({ config, all: false });
    worker.logger.info(formatEmbedResult("Embedding completed", embedResult));
    embedded = true;
  } else {
    worker.logger.info("Embedding skipped; Git push did not complete");
  }
  const result = { ...syncResult, embedded };
  worker.logger.info(`Sync completed; embedded=${result.embedded}`);
  return result;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return true;
}

function seconds(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function createLogger() {
  return {
    info: (message) => console.error(formatLog(message)),
    error: (message) => console.error(formatLog(message)),
  };
}

function formatLog(message) {
  return `[anything-obsidian-worker] ${new Date().toISOString()} ${message}`;
}

function formatEmbedResult(prefix, result) {
  return `${prefix}; scanned=${result.scanned} uploaded=${result.uploaded} removed=${result.removed} workspace=${result.workspaceSlug}`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runWorker();
}
