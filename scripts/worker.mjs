#!/usr/bin/env node
import process from "node:process";
import { pathToFileURL } from "node:url";

export async function runWorker(argv = process.argv.slice(2), env = process.env) {
  void env;

  const [command] = argv;

  switch (command) {
    case "embed":
    case "sync":
    case "doctor":
      console.error(`worker command '${command}' is not wired yet.`);
      return 70;
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

function printUsage() {
  console.error(`Usage: node scripts/worker.mjs <command>

Commands:
  embed [--all]  Embed vault documents into AnythingLLM
  sync           Sync vault Git changes, then embed after successful push
  doctor         Check Docker-visible config and service reachability`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runWorker();
}
