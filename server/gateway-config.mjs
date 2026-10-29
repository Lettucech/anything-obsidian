// Gateway's own state: the AnythingLLM base URL and API key, stored in the
// data directory (0600) and fully self-contained — the gateway never reads
// the client's config.json for new installs, so installing the client on
// the same machine cannot disturb it. Env overrides stay supported for
// tests and non-interactive deployments. There is no admin credential: the
// dashboard plane is host-loopback only and reaching it is the proof.
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
        if (error?.code === "ENOENT") return { apiKey: "", anythingllmBaseUrl: "" };
        throw error;
      }
      return {
        apiKey: typeof parsed?.apiKey === "string" ? parsed.apiKey : "",
        anythingllmBaseUrl: typeof parsed?.anythingllmBaseUrl === "string" ? parsed.anythingllmBaseUrl : "",
      };
    },
    async save(patch) {
      const current = await this.load();
      const next = {
        apiKey: patch.apiKey !== undefined ? String(patch.apiKey) : current.apiKey,
        anythingllmBaseUrl: patch.anythingllmBaseUrl !== undefined ? String(patch.anythingllmBaseUrl) : current.anythingllmBaseUrl,
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
      return Boolean(state.apiKey && state.anythingllmBaseUrl);
    },
  };
}
