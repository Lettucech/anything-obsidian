// Management tools: a thin proxy to the dashboard's loopback REST API so the
// dashboard UI and MCP callers share one control plane (same jobs, same
// audit trail). Local profile only — the LAN profile never registers these.
const DEFAULT_DASHBOARD_URL = "http://127.0.0.1:21400";

export function dashboardApi({ baseUrl = process.env.AO_DASHBOARD_URL ?? DEFAULT_DASHBOARD_URL, fetchImpl = fetch } = {}) {
  async function request(method, pathname, body) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${pathname}`, {
        method,
        ...(body !== undefined ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
      });
    } catch (error) {
      throw new Error(`The Anything Obsidian dashboard is not reachable at ${baseUrl}. Start it with: anything-obsidian start (or autostart on). (${error instanceof Error ? error.message : String(error)})`);
    }
    const text = await response.text();
    const data = text ? safeParse(text) : null;
    if (!response.ok) {
      const detail = data && typeof data === "object" && data.error ? data.error : text;
      const error = new Error(`Dashboard API ${response.status}: ${detail}`);
      error.statusCode = response.status;
      throw error;
    }
    return data;
  }

  return {
    request,
    status: () => request("GET", "/api/status"),
    vaults: () => request("GET", "/api/vaults"),
    addVault: (input) => request("POST", "/api/vaults", input),
    updateVault: (vaultId, changes) => request("PATCH", `/api/vaults/${encodeURIComponent(vaultId)}`, changes),
    removeVault: (vaultId) => request("DELETE", `/api/vaults/${encodeURIComponent(vaultId)}`),
    vaultAction: (vaultId, actionId) => request("POST", `/api/vaults/${encodeURIComponent(vaultId)}/actions/${encodeURIComponent(actionId)}`),
    job: (jobId) => request("GET", `/api/jobs/${encodeURIComponent(jobId)}`),
    agents: () => request("GET", "/api/agents"),
    createAgent: (name) => request("POST", "/api/agents", { name }),
    revokeAgent: (name) => request("DELETE", `/api/agents/${encodeURIComponent(name)}`),
    autostart: () => request("GET", "/api/autostart"),
    setAutostart: (action) => request("POST", "/api/autostart", { action }),
    lan: () => request("GET", "/api/lan"),
    setLan: (action, token) => request("POST", "/api/lan", { action, ...(token !== undefined ? { token } : {}) }),
  };
}

export function registerManagementTools(server, api, { z }) {
  server.tool(
    "any_obs_status",
    "Full Anything Obsidian system status: services health, config, jobs history, and vault sync states.",
    {},
    async () => asJson(await api.status()),
  );

  server.tool(
    "any_obs_vault_add",
    "Add a vault to management: clone a Git repository, import a directory beneath the vault root, or import any directory on this machine by passing its absolute importPath. The vault embeds into this instance's unified RAG workspace. Requires the same fields as the dashboard's Add vault dialog (repository URL or import directory, commit identity, visibility).",
    {
      sourceMode: z.enum(["clone", "import"]).default("clone"),
      repositoryUrl: z.string().optional(),
      id: z.string().optional(),
      directory: z.string().optional(),
      importPath: z.string().optional(),
      name: z.string().optional(),
      repositoryVisibility: z.enum(["public", "private"]).default("public"),
      gitUserName: z.string(),
      gitUserEmail: z.string(),
      gitAuthUsername: z.string().optional(),
      gitAuthToken: z.string().optional(),
      gitAutoPull: z.boolean().optional(),
      gitAutoPush: z.boolean().optional(),
      syncIntervalSeconds: z.number().int().optional(),
      embedAfterSync: z.boolean().optional(),
      enabled: z.boolean().optional(),
      accessMode: z.enum(["open", "restricted"]).optional(),
      allowlist: z.array(z.string()).optional(),
    },
    async (input) => asJson(await api.addVault({
      ...input,
      ...(input.gitAuthUsername || input.gitAuthToken
        ? { gitAuth: { mode: "https-token", username: input.gitAuthUsername, token: input.gitAuthToken } }
        : {}),
    })),
  );

  server.tool(
    "any_obs_vault_update",
    "Update one managed vault's sync, embedding, or access settings (same fields as the dashboard Edit dialog). Identity fields (id, directory, repository) cannot change.",
    {
      vaultId: z.string().min(1),
      name: z.string().optional(),
      gitAutoPull: z.boolean().optional(),
      gitAutoPush: z.boolean().optional(),
      gitPushUrl: z.string().optional(),
      gitCommitMessagePrefix: z.string().optional(),
      syncIntervalSeconds: z.number().int().optional(),
      embedAfterSync: z.boolean().optional(),
      embedExtensions: z.string().optional(),
      embedExcludeDirs: z.string().optional(),
      enabled: z.boolean().optional(),
      accessMode: z.enum(["open", "restricted"]).optional(),
      allowlist: z.array(z.string()).optional(),
    },
    async ({ vaultId, ...changes }) => asJson(await api.updateVault(vaultId, changes)),
  );

  server.tool(
    "any_obs_vault_remove",
    "Remove a vault from management. Its repository and the user's files are never deleted; the vault's derived chunks are removed from the shared RAG index so they stop appearing in searches.",
    { vaultId: z.string().min(1) },
    async ({ vaultId }) => asJson({ removed: vaultId, result: await api.removeVault(vaultId) ?? {} }),
  );

  server.tool(
    "any_obs_vault_sync",
    "Trigger a Git sync (pull, commit, push) plus embedding for one vault. Returns the job record; poll any_obs_job_get for completion.",
    { vaultId: z.string().min(1) },
    async ({ vaultId }) => asJson(await api.vaultAction(vaultId, "sync")),
  );

  server.tool(
    "any_obs_vault_embed",
    "Embed changed files into the vault's AnythingLLM index, or rebuild the whole index with all=true.",
    { vaultId: z.string().min(1), all: z.boolean().default(false) },
    async ({ vaultId, all }) => asJson(await api.vaultAction(vaultId, all ? "embed-all" : "embed")),
  );

  server.tool(
    "any_obs_vault_doctor",
    "Run health checks for one managed vault (Git state, AnythingLLM workspace and upload path, embed manifest).",
    { vaultId: z.string().min(1) },
    async ({ vaultId }) => asJson(await api.vaultAction(vaultId, "doctor")),
  );

  server.tool(
    "any_obs_job_get",
    "Get one worker job's status and captured logs (sync/embed/doctor runs triggered here or from the dashboard).",
    { jobId: z.string().min(1) },
    async ({ jobId }) => asJson(await api.job(jobId)),
  );

  server.tool(
    "any_obs_agent_create",
    "Create a named MCP agent token. The raw token is returned once; store it for the client. Add the agent name to vault allowlists to scope its access.",
    { name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lowercase dash-separated name") },
    async ({ name }) => asJson(await api.createAgent(name)),
  );

  server.tool(
    "any_obs_agent_revoke",
    "Revoke an MCP agent token. Clients using it lose MCP access immediately.",
    { name: z.string().min(1) },
    async ({ name }) => asJson(await api.revokeAgent(name)),
  );

  server.tool(
    "any_obs_autostart",
    "Turn the login auto-start / crash auto-restart services on or off (dashboard, scheduler, and the MCP endpoint). action=off stops them permanently.",
    { action: z.enum(["on", "off"]) },
    async ({ action }) => asJson(await api.setAutostart(action)),
  );

  server.tool(
    "any_obs_lan",
    "Manage the LAN RAG MCP endpoint: turn it on or off, or set its admin Bearer token. 'on' generates and returns a token when none is configured.",
    {
      action: z.enum(["on", "off", "token"]),
      token: z.string().optional(),
    },
    async ({ action, token }) => asJson(await api.setLan(action, token)),
  );
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function asJsonContent(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function asJson(data) {
  return asJsonContent(data);
}
