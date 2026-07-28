export function createAnythingllmClient({ baseUrl, apiKey, fetchImpl = fetch }) {
  const root = String(baseUrl).replace(/\/+$/, "");

  return {
    async createWorkspace({ name }) {
      const data = await request("/api/v1/workspace/new", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      return workspace(data?.workspace);
    },
    async listWorkspaces() {
      const data = await request("/api/v1/workspaces", { method: "GET" });
      return Array.isArray(data?.workspaces) ? data.workspaces.map(workspace) : [];
    },
    async workspaceExists(slug) {
      return (await this.listWorkspaces()).some((item) => item.slug === slug);
    },
  };

  async function request(apiPath, init) {
    const response = await fetchImpl(`${root}${apiPath}`, {
      ...init,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) throw new Error(`AnythingLLM API ${response.status}`);
    return data;
  }
}

function workspace(value) {
  if (!value?.slug) throw new Error("AnythingLLM returned an invalid workspace");
  return { id: value.id, name: value.name, slug: value.slug };
}
