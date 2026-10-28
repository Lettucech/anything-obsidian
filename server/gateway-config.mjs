// Gateway's own state: the admin credential and the AnythingLLM API key,
// stored in the data volume (0600) — both are collected by the first-run
// setup wizard in the dashboard, never required as env vars. Env overrides
// stay supported for tests and non-interactive deployments.
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export function createGatewayConfig({ dataDir }) {
  const filePath = path.join(dataDir, "gateway.json");

  return {
    async load() {
      let parsed;
      try {
        parsed = JSON.parse(await readFile(filePath, "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT") return { adminToken: "", apiKey: "" };
        throw error;
      }
      return {
        adminToken: typeof parsed?.adminToken === "string" ? parsed.adminToken : "",
        apiKey: typeof parsed?.apiKey === "string" ? parsed.apiKey : "",
      };
    },
    async save(patch) {
      const current = await this.load();
      const next = {
        adminToken: patch.adminToken !== undefined ? String(patch.adminToken) : current.adminToken,
        apiKey: patch.apiKey !== undefined ? String(patch.apiKey) : current.apiKey,
      };
      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const temporary = `${filePath}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, filePath);
      await chmod(filePath, 0o600);
      return next;
    },
    async configured() {
      const state = await this.load();
      return Boolean(state.adminToken && state.apiKey);
    },
  };
}
