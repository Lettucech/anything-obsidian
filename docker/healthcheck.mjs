import { runCli } from "../bin/anything-obsidian.mjs";

let report;
await runCli(["status", "--json"], {
  log: (line) => {
    try {
      report = JSON.parse(line);
    } catch {}
  },
});
process.exitCode = report?.ready === true ? 0 : 1;
