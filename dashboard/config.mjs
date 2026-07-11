export const CONTROLLED_SERVICES = Object.freeze({
  anythingllm: Object.freeze({
    id: "anythingllm",
    name: "anything-obsidian-anythingllm",
    label: "AnythingLLM",
    health: Object.freeze({ url: "http://anythingllm:3001/api/docs", okStatus: 200 }),
  }),
  mcp: Object.freeze({
    id: "mcp",
    name: "anything-obsidian-mcp",
    label: "MCP",
    health: Object.freeze({ url: "http://mcp:3333/health", okStatus: 200 }),
  }),
  syncer: Object.freeze({
    id: "syncer",
    name: "anything-obsidian-syncer",
    label: "Syncer",
  }),
});

export const LOG_SERVICES = Object.freeze({
  anythingllm: CONTROLLED_SERVICES.anythingllm,
  mcp: CONTROLLED_SERVICES.mcp,
  syncer: CONTROLLED_SERVICES.syncer,
});

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
  const running = services.filter((service) => service.found && service.running).length;
  if (running === services.length) return "on";
  if (running === 0) return "off";
  return "partial";
}

export function publicConfig(env) {
  const dashboardPort = env.HOST_DASHBOARD_PORT || "11300";
  const anythingllmPort = env.HOST_ANYTHINGLLM_PORT || "11301";
  const mcpPort = env.HOST_MCP_PORT || "11333";

  return {
    dashboardUrl: `http://localhost:${dashboardPort}`,
    anythingllmUrl: `http://localhost:${anythingllmPort}`,
    mcpUrl: `http://localhost:${mcpPort}/mcp`,
    workspaceSlug: env.ANYTHINGLLM_WORKSPACE_SLUG || "obsidian",
    syncIntervalSeconds: env.KB_SYNC_INTERVAL_SECONDS || "300",
    gitRemote: env.KB_GIT_REMOTE || "origin",
    gitBranch: env.KB_GIT_BRANCH || "main",
  };
}
