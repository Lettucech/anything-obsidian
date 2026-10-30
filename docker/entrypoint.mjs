import path from "node:path";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { runCli } from "../bin/anything-obsidian.mjs";
import { createAppConfigStore, defaultConfigRoot } from "../lib/app-config.mjs";
import { createGatewayConfig } from "../server/gateway-config.mjs";
import { createInstallationStore } from "../lib/installation.mjs";
import { ensureContainerToken } from "../lib/container-admin.mjs";
import { readJson, withFileLock } from "../lib/state.mjs";
import { startContainerRuntime } from "./runtime.mjs";

export async function containerMain(args = process.argv.slice(2), env = process.env) {
  process.umask(0o077);
  const role = env.AO_CONTAINER_ROLE || args[0];
  if (!["client", "gateway"].includes(role))
    throw new Error("Select client or gateway as AO_CONTAINER_ROLE");
  env = { ...env, AO_CONTAINER: "1", AO_CONTAINER_ROLE: role };
  const root = defaultConfigRoot({ env });
  await mkdir(path.join(root, "run"), { recursive: true });
  await mkdir(path.join(root, "home"), { recursive: true });
  if (args[0] === "setup") {
    const setupArgs = ["setup", ...(role === "gateway" ? ["--server"] : []), ...args.slice(1)];
    return withFileLock(
      path.join(root, "run", "container-owner.lock"),
      () => runCli(setupArgs, { env }),
      { timeoutMs: 0 },
    );
  }
  if (args[0] !== role) return runCli(args, { env });
  return withFileLock(
    path.join(root, "run", "container-owner.lock"),
    async () => {
      const installation = await createInstallationStore(root).load();
      if (installation.roles.length !== 1 || installation.roles[0] !== role || installation.lan)
        throw new Error(
          "Configure a fresh, separate volume with docker compose run --rm client (or gateway) setup first. Native data volumes are not supported.",
        );
      const config =
        role === "client"
          ? await createAppConfigStore({ rootDir: root }).load()
          : await createGatewayConfig({ dataDir: path.join(root, "gateway") }).load();
      if (!config?.apiKey)
        throw new Error("Run docker compose run --rm client (or gateway) setup first");
      if (role === "client") {
        if (
          config.vaultsRoot !== path.join(root, "vaults") ||
          config.dashboardPort !== 21502 ||
          !config.lanToken
        )
          throw new Error(
            "Docker client configuration requires its own setup and fixed volume paths/ports",
          );
        const registry = await readJson(path.join(root, "registry", "vaults.json"), { vaults: [] });
        if (registry.vaults.some((vault) => vault.location === "imported" || vault.importPath))
          throw new Error(
            "Docker cannot run imported local vaults. Use a fresh volume and Git clones.",
          );
      } else if (config.port !== 21500 || config.adminPort !== 21505)
        throw new Error(
          "Docker gateway requires default internal ports; customize host ports in Compose",
        );
      const token = await ensureContainerToken(root);
      const runtime = await startContainerRuntime({
        root,
        role,
        env,
        secrets: [token, config.apiKey, config.lanToken],
      });
      const stop = () => {
        void runtime.shutdown(0);
      };
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
      try {
        return await runtime.done;
      } finally {
        process.off("SIGTERM", stop);
        process.off("SIGINT", stop);
      }
    },
    { timeoutMs: 0 },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await containerMain();
  } catch (error) {
    console.error(`Container startup failed: ${error.message}`);
    process.exitCode = 1;
  }
}
