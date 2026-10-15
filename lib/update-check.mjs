import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let currentVersion;
export async function currentVersionValue() {
  if (!currentVersion) {
    const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
    currentVersion = pkg.version;
  }
  return currentVersion;
}

const LATEST_URL = "https://raw.githubusercontent.com/Lettucech/anything-obsidian/main/package.json";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

let cache = { value: null, at: 0 };

export async function fetchLatestVersion({ fetchImpl = fetch, timeoutMs = 5000, now = Date.now, url = LATEST_URL } = {}) {
  if (cache.value && now() - cache.at < CACHE_TTL_MS) return cache.value;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const pkg = await response.json();
    const latest = String(pkg?.version || "");
    if (!/^\d+\.\d+\.\d+/.test(latest)) return null;
    cache = { value: latest, at: now() };
    return latest;
  } catch {
    return null;
  }
}

export function compareVersions(current, latest) {
  const left = String(current || "").split(".").map(Number);
  const right = String(latest || "").split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] || 0) < (right[index] || 0)) return -1;
    if ((left[index] || 0) > (right[index] || 0)) return 1;
  }
  return 0;
}
