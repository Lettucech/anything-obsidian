import { readdir, realpath } from "node:fs/promises";
import path from "node:path";

export async function importTree({ vaultsRoot, requestedPath = "", readdirImpl = readdir, realpathImpl = realpath } = {}) {
  if (!vaultsRoot) throw new Error("vaultsRoot is not configured");
  const rootReal = await realpathOr(path.resolve(vaultsRoot), "Vault root");
  const targetReal = await realpathOr(requestedPath ? path.resolve(requestedPath) : rootReal, "Path");
  assertInside(rootReal, targetReal, "Path");

  const entries = await readdirImpl(targetReal, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith("."))
    .map((entry) => {
      const entryPath = path.join(targetReal, entry.name);
      return {
        name: entry.name,
        path: entryPath,
        canImport: path.dirname(entryPath) === rootReal,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    root: rootReal,
    path: targetReal,
    name: path.basename(targetReal),
    parent: targetReal === rootReal ? null : path.dirname(targetReal),
    canUseHere: targetReal !== rootReal && path.dirname(targetReal) === rootReal,
    directories,
  };
}

function assertInside(root, target, label) {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    const error = new Error(`${label} is outside the vault root`);
    error.statusCode = 403;
    throw error;
  }
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
