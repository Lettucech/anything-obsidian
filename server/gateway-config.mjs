// Gateway's own state: the AnythingLLM base URL and API key, stored in the
// data directory (0600) and fully self-contained — the gateway never reads
// the client's config.json for new installs, so installing the client on
// the same machine cannot disturb it. Env overrides stay supported for
// tests and non-interactive deployments. There is no admin credential: the
// dashboard plane is host-loopback only and reaching it is the proof.
import { chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { withFileLock, writeJson } from "../lib/state.mjs";

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
        anythingllmBaseUrl:
          typeof parsed?.anythingllmBaseUrl === "string" ? parsed.anythingllmBaseUrl : "",
        ...Object.fromEntries(
          ["port", "adminPort", "bind"]
            .filter((key) => parsed[key] !== undefined)
            .map((key) => [key, parsed[key]]),
        ),
      };
    },
    async save(patch) {
      return withFileLock(`${filePath}.lock`, async () => {
        const current = await this.load();
        const next = {
          ...current,
          apiKey: patch.apiKey !== undefined ? String(patch.apiKey) : current.apiKey,
          anythingllmBaseUrl:
            patch.anythingllmBaseUrl !== undefined
              ? String(patch.anythingllmBaseUrl)
              : current.anythingllmBaseUrl,
        };
        for (const key of ["port", "adminPort"]) {
          if (patch[key] !== undefined) {
            const port = Number(patch[key]);
            if (!Number.isInteger(port) || port < 1 || port > 65535)
              throw new Error(`${key} must be between 1 and 65535`);
            next[key] = port;
          }
        }
        if (patch.bind !== undefined) next.bind = String(patch.bind);
        if (
          next.anythingllmBaseUrl &&
          !["http:", "https:"].includes(new URL(next.anythingllmBaseUrl).protocol)
        )
          throw new Error("AnythingLLM URL must be HTTP(S)");
        await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
        await writeJson(filePath, next);
        await chmod(filePath, 0o600);
        return next;
      });
    },
    async configured() {
      const state = await this.load();
      return Boolean(state.apiKey && state.anythingllmBaseUrl);
    },
  };
}
