import { access } from "node:fs/promises";

export async function doctor({ config, fetchImpl = fetch }) {
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

  return { ok: checks.every((check) => check.ok), checks };
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
