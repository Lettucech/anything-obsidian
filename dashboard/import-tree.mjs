import { readdir, realpath } from "node:fs/promises";
import path from "node:path";

export async function importTree({ vaultsRoot, requestedPath = "", readdirImpl = readdir, realpathImpl = realpath } = {}) {
  if (!vaultsRoot) throw new Error("vaultsRoot is not configured");
  const rootReal = await realpathOr(path.resolve(vaultsRoot), "Vault root");
  const targetReal = await realpathOr(requestedPath ? path.resolve(requestedPath) : rootReal, "Path");
  const insideRoot = isInside(rootReal, targetReal);

  const entries = await readdirImpl(targetReal, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith("."))
    .map((entry) => {
      const entryPath = path.join(targetReal, entry.name);
      const importMode = path.dirname(entryPath) === rootReal ? "managed" : "imported";
      return {
        name: entry.name,
        path: entryPath,
        canImport: true,
        importMode,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    root: rootReal,
    path: targetReal,
    name: path.basename(targetReal),
    parent: targetReal === rootReal ? null : path.dirname(targetReal),
    insideRoot,
    canUseHere: targetReal !== rootReal && (insideRoot ? path.dirname(targetReal) === rootReal : true),
    importMode: insideRoot ? (targetReal === rootReal ? null : path.dirname(targetReal) === rootReal ? "managed" : "imported") : "imported",
    directories,
  };
}

function isInside(root, target) {
  if (target === root) return true;
  return target.startsWith(`${root}${path.sep}`);
}

async function realpathOr(target, label) {
  try {
    return await realpath(target);
  } catch (error) {
    if (error?.code === "ENOENT") {
      const missing = new Error(`${label} does not exist: ${target}`);
      missing.statusCode = 404;
      throw missing;
    }
    throw error;
  }
}
