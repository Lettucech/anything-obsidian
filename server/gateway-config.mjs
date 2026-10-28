// Gateway's own state: the AnythingLLM API key collected by the first-run
// setup wizard, stored in the data volume (0600) — never required as an env
// var. Env overrides stay supported for tests and non-interactive
// deployments. There is no admin credential: the dashboard plane is
// host-loopback only and reaching it is the proof.
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
        if (error?.code === "ENOENT") return { apiKey: "" };
        throw error;
      }
      return { apiKey: typeof parsed?.apiKey === "string" ? parsed.apiKey : "" };
    },
    async save(patch) {
      const current = await this.load();
      const next = {
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
      return Boolean((await this.load()).apiKey);
    },
  };
}
