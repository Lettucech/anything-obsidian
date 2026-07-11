#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CONTROLLED_SERVICES, LOG_SERVICES, classifySystemState, publicConfig } from "./config.mjs";
import { DockerClient } from "./docker-client.mjs";
import { createJobManager } from "./jobs.mjs";
import { redactSecretsObject, redactSecretsText } from "./redact.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createDashboardServer({
  docker = new DockerClient(),
  jobs = createJobManager({ docker }),
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/api/status") {
        return sendJson(res, 200, await statusPayload({ docker, jobs, env, fetchImpl }));
      }
      if (req.method === "POST" && url.pathname === "/api/system/on") {
        for (const service of Object.values(CONTROLLED_SERVICES)) await docker.startContainer(service.name);
        return sendJson(res, 200, await statusPayload({ docker, jobs, env, fetchImpl }));
      }
      if (req.method === "POST" && url.pathname === "/api/system/off") {
        for (const service of Object.values(CONTROLLED_SERVICES)) await docker.stopContainer(service.name);
        return sendJson(res, 200, await statusPayload({ docker, jobs, env, fetchImpl }));
      }
      if (req.method === "GET" && url.pathname === "/api/logs") {
        const id = url.searchParams.get("service") || "";
        const service = LOG_SERVICES[id];
        if (!service) return sendJson(res, 400, { error: `Unknown log service: ${id}` });
        const logs = redactSecretsText(await docker.containerLogs(service.name, { tail: 300 }));
        return sendJson(res, 200, { service: id, logs });
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/actions/")) {
        const actionId = url.pathname.slice("/api/actions/".length);
        if (!["sync", "embed", "embed-all", "doctor"].includes(actionId)) {
          return sendJson(res, 404, { error: `Unknown action: ${actionId}` });
        }
        const snapshot = await serviceSnapshot({ docker, fetchImpl });
        const job = await jobs.start(actionId, snapshot);
        return sendJson(res, 202, job);
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/actions/")) {
        const id = url.pathname.slice("/api/actions/".length);
        const job = jobs.get(id);
        return job ? sendJson(res, 200, job) : sendJson(res, 404, { error: `Unknown job: ${id}` });
      }
      if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
        return await serveStatic(res, url.pathname);
      }
      return sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

async function statusPayload({ docker, jobs, env, fetchImpl }) {
  const services = await serviceSnapshot({ docker, fetchImpl });
  return redactSecretsObject({
    ok: true,
    systemState: classifySystemState(services),
    services,
    latestJob: jobs.latest(),
    config: publicConfig(env),
  });
}

async function serviceSnapshot({ docker, fetchImpl }) {
  return await Promise.all(
    Object.values(CONTROLLED_SERVICES).map(async (service) => {
      const inspected = await docker.inspectContainer(service.name);
      const health = inspected.running && service.health
        ? await probeHealth(fetchImpl, service.health.url, service.health.okStatus)
        : { ok: false, status: "not-running" };
      return { ...inspected, id: service.id, label: service.label, health };
    }),
  );
}

async function probeHealth(fetchImpl, url, okStatus) {
  try {
    const response = await fetchImpl(url);
    return { ok: response.status === okStatus || response.ok, status: response.status };
  } catch (error) {
    return { ok: false, status: error instanceof Error ? error.message : String(error) };
  }
}

async function serveStatic(res, pathname) {
  const file = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const fullPath = path.join(__dirname, "public", file);
  if (!fullPath.startsWith(path.join(__dirname, "public"))) return sendJson(res, 403, { error: "Forbidden" });
  const body = await readFile(fullPath);
  res.writeHead(200, { "content-type": contentType(file) });
  res.end(body);
}

function contentType(file) {
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "text/html; charset=utf-8";
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.DASHBOARD_PORT || 3000);
  createDashboardServer().listen(port, "0.0.0.0", () => {
    console.error(`[anything-obsidian-dashboard] listening on ${port}`);
  });
}
