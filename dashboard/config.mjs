export const WORKER_ACTIONS = Object.freeze({
  sync: Object.freeze({
    id: "sync",
    label: "Sync now",
    command: Object.freeze(["sync"]),
    requiresAnythingLLM: true,
  }),
  embed: Object.freeze({
    id: "embed",
    label: "Embed changed",
    command: Object.freeze(["embed"]),
    requiresAnythingLLM: true,
  }),
  "embed-all": Object.freeze({
    id: "embed-all",
    label: "Rebuild index",
    command: Object.freeze(["embed", "--all"]),
    requiresAnythingLLM: true,
  }),
  doctor: Object.freeze({
    id: "doctor",
    label: "Run doctor",
    command: Object.freeze(["doctor"]),
    requiresAnythingLLM: false,
  }),
});

export function classifySystemState(services) {
  const managed = services.filter((service) => service.powerManaged !== false);
  const running = managed.filter((service) => service.found && service.running).length;
  if (running === managed.length) return "on";
  if (running === 0) return "off";
  return "partial";
}

export function publicConfig(env) {
  return {
    dashboardUrl: `http://localhost:${env.DASHBOARD_PORT || "11400"}`,
    anythingllmUrl: (env.ANYTHINGLLM_BASE_URL || "").replace(/\/+$/, ""),
    mcpUrl: env.MCP_PORT ? `http://localhost:${env.MCP_PORT}/mcp` : null,
    vaultsRoot: env.VAULTS_ROOT || "",
  };
}
