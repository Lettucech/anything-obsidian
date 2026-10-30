import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, mkdir, readFile, rename, rm, access } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { fetchWithTimeout } from "./http.mjs";
import { withFileLock } from "./state.mjs";

const exec = promisify(execFile);

// The running release remains intact until preparation and validation succeed.
export async function activateRelease({ appDir, candidate, controller, verify, log = () => {} }) {
  const previous = `${appDir}.previous`;
  let switched = false;
  try {
    await controller.stop();
    await rm(previous, { recursive: true, force: true });
    await rename(appDir, previous);
    try {
      await rename(candidate, appDir);
    } catch (error) {
      await rename(previous, appDir);
      throw error;
    }
    switched = true;
    await controller.start();
    if (!(await verify()).ok) throw new Error("Updated services failed readiness checks");
    log("Update activated and services verified. Previous release retained for recovery.");
  } catch (error) {
    if (switched) {
      await controller.stop();
      await rename(appDir, candidate);
      await rename(previous, appDir);
    }
    await controller.start();
    const restored = await verify();
    throw new Error(
      `Update failed: ${error.message}. ${restored.ok ? "Previous release restored and verified" : "Previous release restored, but services need attention; run status and logs"}`,
    );
  }
}

export async function updateApplication({
  appRoot,
  root,
  controller,
  verify,
  log,
  env = process.env,
  fetchImpl = fetch,
  execImpl = exec,
  prepare,
  activate = activateRelease,
}) {
  return withFileLock(path.join(root, "run", "update.lock"), async () => {
    const appDir = path.join(appRoot, "app");
    await access(path.join(appDir, "package.json"));
    const staging = await mkdtemp(path.join(appRoot, "update-"));
    const candidate = path.join(staging, "candidate");
    await mkdir(candidate);
    try {
      if (prepare) await prepare(candidate);
      else {
        const repo = env.ANYTHING_OBSIDIAN_REPO || "Lettucech/anything-obsidian";
        const branch = env.ANYTHING_OBSIDIAN_BRANCH || "main";
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[\w./-]+$/.test(branch))
          throw new Error("Invalid update repository or branch");
        log(`Preparing update from ${repo} (${branch})…`);
        const archive = path.join(staging, "release.tar.gz");
        const response = await fetchWithTimeout(
          fetchImpl,
          `https://github.com/${repo}/archive/refs/heads/${branch}.tar.gz`,
          {},
          120_000,
        );
        if (!response.ok) throw new Error(`Download failed (HTTP ${response.status})`);
        await pipeline(
          Readable.fromWeb(response.body),
          createWriteStream(archive, { mode: 0o600 }),
        );
        await execImpl("tar", ["-xzf", archive, "--strip-components=1", "-C", candidate], {
          timeout: 120_000,
        });
        const manifest = JSON.parse(await readFile(path.join(candidate, "package.json"), "utf8"));
        if (manifest.name !== "anything-obsidian")
          throw new Error("Archive is not an Anything Obsidian release");
        const npmEnv = {
          ...env,
          PATH: `${path.dirname(process.execPath)}:${env.PATH || "/usr/bin:/bin"}`,
        };
        await execImpl("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], {
          cwd: candidate,
          env: npmEnv,
          timeout: 180_000,
        });
        await execImpl(
          process.execPath,
          [path.join(candidate, "bin", "anything-obsidian.mjs"), "--help"],
          { env: npmEnv, timeout: 15_000 },
        );
        for (const script of ["server/gateway.mjs", "dashboard/server.mjs", "mcp/index.mjs"]) {
          await execImpl(process.execPath, ["--check", path.join(candidate, script)], {
            timeout: 15_000,
          });
        }
      }
      await activate({ appDir, candidate, controller, verify, log });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });
}
