#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { doctor } from "./doctor.mjs";
import { embedVault } from "./embed-vault.mjs";
import { registryFor, loadVaultConfig } from "./vault-config.mjs";
import { runScheduler } from "./scheduler.mjs";
import { shouldEmbedAfterSync, syncVaultOnce } from "./watch-vault.mjs";
import { createSyncStatusStore, syncStatusPath } from "../lib/sync-status.mjs";
import { rotateLogs } from "../lib/log-rotate.mjs";
import { createNotifier } from "../lib/notify.mjs";
import { redactSecretsText } from "../dashboard/redact.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { withFileLock } from "../lib/state.mjs";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");

const defaultNotifier = createNotifier();

const defaultDeps = {
  doctor,
  embedVault,
  loadVaultConfig,
  loadRegistry: registryFor,
  loadEnv: (env) => env,
  logger: createLogger(),
  sleep,
  shouldEmbedAfterSync,
  syncVaultOnce,
  runScheduler,
  notify: defaultNotifier.notify.bind(defaultNotifier),
  rotateLogs,
};

export async function runWorker(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const worker = {
    ...defaultDeps,
    ...deps,
    secretValues: [env.ANYTHINGLLM_API_KEY, env.GIT_PASSWORD],
  };
  const logger = worker.logger;
  worker.logger = {
    info: (text) => logger.info(redactSecretsText(text, worker.secretValues)),
    error: (text) => logger.error(redactSecretsText(text, worker.secretValues)),
  };
  if (deps.signal && !deps.sleep)
    worker.sleep = async (ms) => {
      try {
        await delay(ms, undefined, { signal: deps.signal });
        return true;
      } catch (error) {
        if (error.name === "AbortError") return false;
        throw error;
      }
    };

  const [command] = argv;

  switch (command) {
    case "embed":
      return runCommand(async () => {
        const config = await commandConfig(argv, env, worker);
        worker.logger.info("Embedding command started");
        const result = await worker.embedVault({
          config,
          all: argv.includes("--all"),
          ...(worker.signal ? { signal: worker.signal } : {}),
          onProgress: async (progress) =>
            worker.logger.info(
              `${progress.phase}: ${progress.completed ?? 0}/${progress.total ?? 0}${progress.file ? ` ${progress.file}` : ""}`,
            ),
        });
        worker.logger.info(formatEmbedResult("Embedding command completed", result));
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }, worker);
    case "sync":
      return runCommand(async () => {
        const config = await commandConfig(argv, env, worker);
        const result = await syncAndEmbed({ worker, config });
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }, worker);
    case "scheduler":
      return runCommand(async () => {
        await worker.runScheduler({
          registry: worker.loadRegistry(await worker.loadEnv(env)),
          runVault: async (vaultId) => {
            worker.signal?.throwIfAborted();
            const loaded = await worker.loadVaultConfig(await worker.loadEnv(env), vaultId);
            const config = worker.signal ? { ...loaded, signal: worker.signal } : loaded;
            await syncAndEmbed({ worker, config });
          },
          sleep: worker.sleep,
          logger: worker.logger,
          housekeeping: () =>
            worker.rotateLogs({
              logsRoot: path.join(
                path.dirname(
                  env.VAULT_STATE_ROOT || path.join(repoRoot, ".anything-obsidian-state"),
                ),
                "logs",
              ),
            }),
        });
        return 0;
      }, worker);
    case "doctor":
      return runCommand(async () => {
        const config = await commandConfig(argv, env, worker);
        const result = await worker.doctor({ config });
        console.log(JSON.stringify(result, null, 2));
        return result.ok ? 0 : 1;
      }, worker);
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

async function runCommand(fn, worker) {
  try {
    return await fn();
  } catch (error) {
    if (worker?.signal?.aborted) return 130;
    console.error(
      redactSecretsText(
        error instanceof Error ? error.message : String(error),
        worker?.secretValues,
      ),
    );
    return 1;
  }
}

function printUsage() {
  console.error(`Usage: node scripts/worker.mjs <command>

Commands:
  embed --vault <id> [--all]  Embed one managed vault
  sync --vault <id>           Sync one managed vault, then embed
  doctor --vault <id>         Check one managed vault
  scheduler                   Run due managed-vault syncs`);
}

async function commandConfig(argv, env, worker) {
  const index = argv.indexOf("--vault");
  if (index === -1) throw new Error("--vault is required for managed vault commands");
  const vaultId = argv[index + 1];
  if (!vaultId) throw new Error("--vault requires a vault id");
  const config = await worker.loadVaultConfig(await worker.loadEnv(env), vaultId);
  worker.secretValues.push(config.apiKey, config.gitAuthToken);
  return worker.signal ? { ...config, signal: worker.signal } : config;
}

export async function syncAndEmbed({ worker, config }) {
  const run = () =>
    syncAndEmbedUnlocked({ worker, config: { ...config, operationLockHeld: true } });
  return config.stateDir
    ? withFileLock(`${config.stateDir}.lock`, run, { signal: config.signal })
    : syncAndEmbedUnlocked({ worker, config });
}

async function syncAndEmbedUnlocked({ worker, config }) {
  await config.assertRegistered?.();
  const statusStore = worker.syncStatusStore
    ? worker.syncStatusStore()
    : createSyncStatusStore({
        filePath: syncStatusPath(
          config.vaultStateRoot || path.join(repoRoot, ".anything-obsidian-state"),
        ),
      });
  try {
    worker.logger.info("Sync started");
    const syncResult = await worker.syncVaultOnce({ config });
    worker.logger.info(`Git sync completed; pushed=${syncResult.pushed}`);
    let embedded = false;
    if (
      worker.shouldEmbedAfterSync({
        embedAfterSync: config.embedAfterSync,
        gitAutoPush: config.gitAutoPush,
        pushSucceeded: syncResult.pushed,
      })
    ) {
      worker.logger.info("Embedding started");
      const embedResult = await worker.embedVault({
        config,
        all: false,
        ...(config.signal ? { signal: config.signal } : {}),
        onProgress: async (progress) =>
          worker.logger.info(
            `${progress.phase}: ${progress.completed ?? 0}/${progress.total ?? 0}`,
          ),
      });
      worker.logger.info(formatEmbedResult("Embedding completed", embedResult));
      embedded = true;
    } else {
      worker.logger.info("Embedding skipped; Git push did not complete");
    }
    const result = { ...syncResult, embedded };
    worker.logger.info(`Sync completed; embedded=${result.embedded}`);
    await statusStore.record(config.vaultId, {
      status: "succeeded",
      pushed: result.pushed,
      embedded,
    });
    return result;
  } catch (error) {
    if (config.signal?.aborted) throw error;
    const detail = redactSecretsText(error instanceof Error ? error.message : String(error), [
      config.apiKey,
      config.gitAuthToken,
    ]);
    worker.logger.error(`Sync failed; ${detail}`);
    await statusStore.record(config.vaultId, { status: "failed", error: detail });
    await worker.notify("Anything Obsidian sync failed", `Vault '${config.vaultId}': ${detail}`);
    throw error;
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return true;
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
  return `${prefix}; scanned=${result.scanned} uploaded=${result.uploaded} removed=${result.removed} reconciled=${result.reconciled ?? 0} workspace=${result.workspaceSlug}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Service stopped"));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    process.exitCode = await runWorker(process.argv.slice(2), process.env, {
      signal: controller.signal,
    });
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}
