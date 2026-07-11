import http from "node:http";

const DEFAULT_SOCKET = "/var/run/docker.sock";

export function encodeContainerName(name) {
  return encodeURIComponent(name);
}

export class DockerClient {
  constructor({ socketPath = DEFAULT_SOCKET, request = dockerRequest } = {}) {
    this.socketPath = socketPath;
    this.request = request;
  }

  async inspectContainer(name) {
    const response = await this.request({
      method: "GET",
      path: `/containers/${encodeContainerName(name)}/json`,
      socketPath: this.socketPath,
    });

    if (response.statusCode === 404) {
      return { found: false, name, state: "missing", running: false, status: "missing" };
    }
    ensureOk(response, `inspect ${name}`);

    const state = response.body.State || {};
    return {
      found: true,
      id: response.body.Id,
      name: String(response.body.Name || `/${name}`).replace(/^\//, ""),
      state: state.Status || "unknown",
      running: Boolean(state.Running),
      status: state.Status || "unknown",
    };
  }

  async inspectContainerDetails(name) {
    const response = await this.request({
      method: "GET",
      path: `/containers/${encodeContainerName(name)}/json`,
      socketPath: this.socketPath,
    });
    ensureOk(response, `inspect details ${name}`);
    return response.body;
  }

  async startContainer(name) {
    const response = await this.request({
      method: "POST",
      path: `/containers/${encodeContainerName(name)}/start`,
      socketPath: this.socketPath,
    });
    if (![204, 304].includes(response.statusCode)) ensureOk(response, `start ${name}`);
  }

  async stopContainer(name) {
    const response = await this.request({
      method: "POST",
      path: `/containers/${encodeContainerName(name)}/stop?t=10`,
      socketPath: this.socketPath,
    });
    if (![204, 304].includes(response.statusCode)) ensureOk(response, `stop ${name}`);
  }

  async containerLogs(name, { tail = 300 } = {}) {
    const response = await this.request({
      method: "GET",
      path: `/containers/${encodeContainerName(name)}/logs?stdout=1&stderr=1&tail=${Number(tail)}`,
      socketPath: this.socketPath,
    });
    ensureOk(response, `logs ${name}`);
    return typeof response.body === "string" ? response.body : JSON.stringify(response.body);
  }

  async createContainer(body) {
    const response = await this.request({
      method: "POST",
      path: "/containers/create",
      socketPath: this.socketPath,
      body,
    });
    ensureOk(response, "create worker container");
    return response.body;
  }

  async startContainerById(id) {
    const response = await this.request({
      method: "POST",
      path: `/containers/${encodeContainerName(id)}/start`,
      socketPath: this.socketPath,
    });
    if (![204, 304].includes(response.statusCode)) ensureOk(response, `start ${id}`);
  }

  async waitContainer(id) {
    const response = await this.request({
      method: "POST",
      path: `/containers/${encodeContainerName(id)}/wait`,
      socketPath: this.socketPath,
    });
    ensureOk(response, `wait ${id}`);
    return response.body;
  }

  async removeContainer(id) {
    const response = await this.request({
      method: "DELETE",
      path: `/containers/${encodeContainerName(id)}?force=1`,
      socketPath: this.socketPath,
    });
    if (![204, 404].includes(response.statusCode)) ensureOk(response, `remove ${id}`);
  }
}

function ensureOk(response, label) {
  if (response.statusCode >= 200 && response.statusCode < 300) return;
  const message = response.body?.message || response.body || `HTTP ${response.statusCode}`;
  throw new Error(`Docker ${label} failed: ${message}`);
}

async function dockerRequest({ method, path, socketPath = DEFAULT_SOCKET, body }) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        method,
        path,
        headers: payload
          ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
          : undefined,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const contentType = res.headers["content-type"] || "";
          const parsed = contentType.includes("application/json") && text ? JSON.parse(text) : text;
          resolve({ statusCode: res.statusCode || 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
