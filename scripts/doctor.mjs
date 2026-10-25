import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_DOCUMENT_UPLOAD_PATH_TEMPLATE,
  embeddableVaultFiles,
} from "./embed-vault.mjs";
import { gitEnv } from "./watch-vault.mjs";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");

export async function doctor({
  config,
  fetchImpl = fetch,
  runGit = runGitDefault,
  readManifest = readManifestDefault,
}) {
  const checks = [];

  await record(checks, "vault mount", async () => {
    await access(config.vaultPath);
    return `Vault path is readable: ${config.vaultPath}`;
  });

  await record(checks, "anythingllm api docs", async () => {
    const response = await fetchImpl(`${config.anythingllmBaseUrl}/api/docs`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return "AnythingLLM API docs are reachable";
  });

  await record(checks, "anythingllm api key", async () => {
    if (!config.apiKey) throw new Error("ANYTHINGLLM_API_KEY is empty");
    const response = await fetchImpl(`${config.anythingllmBaseUrl}/api/v1/workspaces`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return "AnythingLLM API key can list workspaces";
  });

  // Exercises the one path the other checks cannot see: a real document
  // upload through the configured folder template. The probe file lives in a
  // dedicated `-doctor` folder that is purged afterwards, so repeated runs
  // never accumulate documents next to the vault's real uploads.
  await record(checks, "anythingllm upload probe", async () => {
    if (!config.apiKey) throw new Error("ANYTHINGLLM_API_KEY is empty");
    const probeFolder = `${config.documentFolder ?? "anything-obsidian-vault"}-doctor`;
    const uploadPath = (
      config.documentUploadPathTemplate ?? DEFAULT_DOCUMENT_UPLOAD_PATH_TEMPLATE
    ).replace("{folder}", encodeURIComponent(probeFolder));
    const body = new FormData();
    body.append("file", new Blob(["# anything-obsidian doctor probe\n"]), "doctor-probe.md");
    body.append(
      "metadata",
      JSON.stringify({
        title: "doctor-probe.md",
        docSource: "anything-obsidian doctor",
        chunkSource: "doctor-probe",
      }),
    );
    const response = await fetchImpl(`${config.anythingllmBaseUrl}${uploadPath}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body,
    });
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      throw new Error(`document upload HTTP ${response.status}: ${text.trim() || "no detail"}`);
    }
    const uploaded = text ? tryJson(text) : null;
    if (!Array.isArray(uploaded?.documents) || uploaded.documents.length === 0) {
      throw new Error(
        `document upload returned no documents: ${text.trim() || "empty body"}`,
      );
    }
    const cleanup = await fetchImpl(
      `${config.anythingllmBaseUrl}/api/v1/document/remove-folder`,
      {
        method: "DELETE",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({ name: probeFolder }),
      },
    ).catch((error) => ({ ok: false, status: String(error?.message ?? error) }));
    const leftover = cleanup.ok
      ? ""
      : `; leftover probe folder could not be removed (HTTP ${cleanup.status})`;
    return `Document upload accepted a probe file in folder '${probeFolder}'${leftover}`;
  });

  await record(checks, "git remote", async () => {
    const result = await runGit({
      args: ["ls-remote", "--heads", config.gitRemote, config.gitBranch],
      cwd: config.vaultPath,
      env: { ...gitEnv(config), GIT_TERMINAL_PROMPT: "0" },
    });
    if (!result.ok) {
      throw new Error(
        `git ls-remote failed (exit ${result.code}): ${result.stderr.trim() || "no output"}` +
          (config.gitAuthToken ? "" : " — configure this vault's HTTPS credential in the dashboard for private repos"),
      );
    }
    return `git remote '${config.gitRemote}' is reachable`;
  });

  await record(checks, "mcp health", async () => {
    const response = await fetchImpl(`${config.mcpBaseUrl}/health`);
    if (!response.ok) throw new Error(`MCP /health HTTP ${response.status}`);
    return `MCP is reachable at ${config.mcpBaseUrl}/health`;
  });

  await record(checks, "embedder probe", async () => {
    if (!config.apiKey) throw new Error("ANYTHINGLLM_API_KEY is empty");
    const url = `${config.anythingllmBaseUrl}/api/v1/workspace/${encodeURIComponent(
      config.workspaceSlug,
    )}/vector-search`;
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ query: "doctor", topN: 1 }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`vector-search HTTP ${response.status}: ${detail.trim() || "no detail"}`);
    }
    return "Embedder responded to a vector-search probe";
  });

  await record(checks, "index drift", async () => {
    const manifest = await readManifest(manifestPath(config));
    const embedded = Object.keys(manifest.files ?? {}).length;
    const files = await embeddableVaultFiles(config.vaultPath, {
      extensions: config.embedExtensions,
      excludeDirs: config.embedExcludeDirs,
    });
    if (files.length === 0) {
      return `Vault has no embeddable files; index has ${embedded} entries`;
    }
    if (embedded === 0) {
      throw new Error(
        `index empty: 0 embedded vs ${files.length} vault files (use the dashboard's Rebuild index action)`,
      );
    }
    const embeddedSet = new Set(Object.keys(manifest.files ?? {}));
    const missing = files
      .map((file) => toPosix(path.relative(config.vaultPath, file)))
      .filter((rel) => !embeddedSet.has(rel))
      .sort()
      .slice(0, 5);
    if (missing.length) {
      const label = missing.length === 5 ? "5+" : String(missing.length);
      throw new Error(
        `index drift: ${label} vault file(s) not embedded (e.g. ${missing.join(", ")})`,
      );
    }
    return `Index up to date: ${embedded} embedded vs ${files.length} vault files`;
  });

  return { ok: checks.every((check) => check.ok), checks };
}

function manifestPath(config) {
  return path.join(config.stateDir ?? path.resolve(repoRoot, ".anything-obsidian-state"), "embed-manifest.json");
}

async function runGitDefault({ args, cwd, env }) {
  return await new Promise((resolve) => {
    const child = spawn("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", () =>
      resolve({ ok: false, code: -1, stdout, stderr: "spawn failed" }),
    );
    child.on("close", (code) => resolve({ ok: code === 0, code, stdout, stderr }));
  });
}

async function readManifestDefault(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return { version: 1, files: parsed.files ?? {} };
  } catch {
    return { version: 1, files: {} };
  }
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function record(checks, name, fn) {
  try {
    checks.push({ name, ok: true, message: await fn() });
  } catch (error) {
    checks.push({
      name,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
