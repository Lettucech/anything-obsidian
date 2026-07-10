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
        const result = await worker.embedVault({ config, all: argv.includes("--all") });
        console.log(JSON.stringify(result, null, 2));
        return 0;
      });
    case "sync":
      return runCommand(async () => {
        const config = await worker.loadConfig(env);
        const syncResult = await worker.syncVaultOnce({ config });
        let embedded = false;
        if (
          worker.shouldEmbedAfterSync({
            embedAfterSync: true,
            gitAutoPush: config.gitAutoPush,
            pushSucceeded: syncResult.pushed,
          })
        ) {
          await worker.embedVault({ config, all: false });
          embedded = true;
        }
        console.log(JSON.stringify({ ...syncResult, embedded }, null, 2));
        return 0;
      });
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
  return resolveConfig({
    ...(await loadEnvFile(path.join(repoRoot, ".env"))),
    ...env,
  });
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
  doctor         Check Docker-visible config and service reachability`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runWorker();
}
