// Builds are separate: node docker/smoke.mjs anything-obsidian:local
// Creates only uniquely named, disposable containers/networks/volumes.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);
const image = process.argv[2] || "anything-obsidian:local";
const prefix = `any-obs-smoke-${process.pid}-${Date.now()}`;
const network = prefix,
  containers = [],
  volumes = [];
const docker = async (...args) =>
  (await exec("docker", args, { maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
const names = {
  upstream: `${prefix}-upstream`,
  gateway: `${prefix}-gateway`,
  client: `${prefix}-client`,
};
const admin = {},
  bases = {};
async function refreshBase(role) {
  const port = role === "gateway" ? 21505 : 21502;
  const info = JSON.parse(await docker("inspect", names[role]))[0];
  bases[role] = `http://127.0.0.1:${info.NetworkSettings.Ports[`${port}/tcp`][0].HostPort}`;
}
async function poll(action, predicate, timeout = 25_000) {
  const start = Date.now();
  let last;
  do {
    try {
      last = await action();
      if (predicate(last)) return last;
    } catch (error) {
      last = error;
    }
    await delay(200);
  } while (Date.now() - start < timeout);
  throw new Error(`Timed out: ${JSON.stringify(last instanceof Error ? last.message : last)}`);
}
async function api(
  role,
  pathname,
  { method = "GET", body, status = 200, token = admin[role] } = {},
) {
  const response = await fetch(bases[role] + pathname, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  assert.equal(response.status, status, `${role} ${pathname}: ${text}`);
  return text ? JSON.parse(text) : null;
}
async function setup(role, url, token) {
  const volume = `${prefix}-${role}`;
  await docker("volume", "create", volume);
  volumes.push(volume);
  await docker(
    "run",
    "--rm",
    "--network",
    network,
    "-v",
    `${volume}:/data`,
    "-e",
    `AO_CONTAINER_ROLE=${role}`,
    image,
    "setup",
    "--url",
    url,
    "--api-key",
    token,
  );
  return volume;
}
async function start(role, volume) {
  const port = role === "gateway" ? 21505 : 21502;
  await docker(
    "run",
    "--detach",
    "--name",
    names[role],
    "--network",
    network,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=128m,mode=1777",
    "--restart",
    "unless-stopped",
    "--stop-timeout",
    "30",
    "-v",
    `${volume}:/data`,
    "-p",
    `127.0.0.1::${port}`,
    "-e",
    `AO_CONTAINER_ROLE=${role}`,
    image,
    role,
  );
  if (!containers.includes(names[role])) containers.push(names[role]);
  await refreshBase(role);
  admin[role] = await docker("exec", names[role], "cat", "/data/secrets/container-admin-token");
  await poll(
    () => fetch(bases[role] + "/ready", { headers: { Authorization: `Bearer ${admin[role]}` } }),
    (response) => response.ok,
  );
  await poll(
    () => docker("exec", names[role], "node", "docker/healthcheck.mjs"),
    () => true,
  );
  assert.equal(await docker("exec", names[role], "id", "-u"), "1000");
}
async function waitJob(role, id, gateway = true) {
  return poll(
    () => api(role, `${gateway ? "/api/gateway/jobs/" : "/api/jobs/"}${id}`),
    (job) => {
      if (job.status === "failed") throw new Error(`${job.error}\n${job.logs || ""}`);
      return job.status === "succeeded";
    },
  );
}
try {
  await docker("network", "create", network);
  await docker(
    "run",
    "--rm",
    "--detach",
    "--name",
    names.upstream,
    "--network",
    network,
    "--network-alias",
    "upstream",
    "--entrypoint",
    "node",
    image,
    "--input-type=module",
    "-e",
    await readFile(new URL("./fixture.mjs", import.meta.url), "utf8"),
  );
  containers.push(names.upstream);
  // The disposable upstream has no published ports or access to host files.
  await poll(
    () =>
      docker(
        "exec",
        names.upstream,
        "node",
        "-e",
        "fetch('http://127.0.0.1:3001/api/v1/workspaces',{headers:{Authorization:'Bearer fixture-developer-key'}}).then(r=>process.exit(r.ok?0:1))",
      ),
    () => true,
  );
  const gatewayVolume = await setup("gateway", "http://upstream:3001", "fixture-developer-key");
  await start("gateway", gatewayVolume);
  await api("gateway", "/api/gateway/users", { status: 401, token: "" });
  const session = await fetch(bases.gateway + "/container/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: admin.gateway }),
  });
  assert.equal(session.status, 200);
  assert.ok(session.headers.get("set-cookie").includes("HttpOnly"));
  await api("gateway", "/api/gateway/workspaces", {
    method: "POST",
    status: 201,
    body: { name: "shared", kind: "shared" },
  });
  await api("gateway", "/api/gateway/sources", {
    method: "POST",
    status: 403,
    body: { id: "forbidden", kind: "dir", ref: "/etc", workspace: "shared" },
  });
  await api("gateway", "/api/gateway/sources", {
    method: "POST",
    status: 201,
    body: {
      id: "handbook",
      kind: "git",
      ref: "http://upstream:3001/git.git",
      workspace: "shared",
      intervalSeconds: 0,
    },
  });
  const job = await api("gateway", "/api/gateway/sources/handbook/refresh", {
    method: "POST",
    status: 202,
    body: {},
  });
  const indexed = await waitJob("gateway", job.id);
  assert.equal(indexed.result.uploaded, 1);
  assert.equal(indexed.result.verified, true);
  const user = await api("gateway", "/api/gateway/users", {
    method: "POST",
    status: 201,
    body: { name: "docker-client", role: "member" },
  });
  const clientVolume = await setup("client", `http://${names.gateway}:21500`, user.token);
  await start("client", clientVolume);
  const clientStatus = await api("client", "/api/status");
  assert.equal(clientStatus.deployment.localImport, false);
  assert.equal(clientStatus.services.length, 4);
  assert.ok(clientStatus.services.every((service) => service.health.ok));
  await api("client", "/api/import-tree", { status: 403 });
  await api("client", "/api/vaults", {
    method: "POST",
    status: 403,
    body: { sourceMode: "import", importPath: "/etc" },
  });
  await api("client", "/api/vaults", {
    method: "POST",
    status: 201,
    body: {
      sourceMode: "clone",
      id: "notes",
      repositoryUrl: "http://upstream:3001/git.git",
      repositoryVisibility: "public",
      gitUserName: "Fixture",
      gitUserEmail: "fixture@example.test",
      gitAutoPull: false,
      gitAutoPush: false,
      enabled: false,
      embedAfterSync: false,
    },
  });
  const clientJob = await api("client", "/api/vaults/notes/actions/embed-all", {
    method: "POST",
    status: 202,
  });
  const clientIndexed = await waitJob("client", clientJob.id, false);
  assert.equal(clientIndexed.status, "succeeded");
  const mcp = await docker(
    "exec",
    names.client,
    "node",
    "-e",
    "fetch('http://127.0.0.1:21503/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>console.log(r.status))",
  );
  assert.equal(mcp, "401");
  await docker(
    "exec",
    names.client,
    "node",
    "--input-type=module",
    "-e",
    `
    import { Client } from '@modelcontextprotocol/sdk/client/index.js';
    import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
    import { readFile } from 'node:fs/promises';
    const config = JSON.parse(await readFile('/data/config.json','utf8'));
    const client = new Client({name:'docker-smoke',version:'1'});
    await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:21503/mcp'), {requestInit:{headers:{Authorization:'Bearer '+config.lanToken}}}));
    const result = await client.callTool({name:'any_obs_status',arguments:{}});
    if(result.isError || JSON.parse(result.content[0].text).deployment.flavor !== 'docker') throw new Error('MCP management proxy failed');
    const tools = await client.listTools();
    const sourceMode = tools.tools.find(tool=>tool.name==='any_obs_vault_add').inputSchema.properties.sourceMode;
    if(sourceMode.enum.includes('import')) throw new Error('Docker MCP must not offer import');
    await client.close();
  `,
  );
  await docker("restart", names.gateway, names.client);
  await refreshBase("gateway");
  await refreshBase("client");
  for (const role of ["gateway", "client"])
    await poll(
      () => api(role, "/ready"),
      (result) => result.ok,
    );
  assert.equal((await api("gateway", `/api/gateway/jobs/${job.id}`)).status, "succeeded");
  assert.equal((await api("client", "/api/vaults")).vaults[0].id, "notes");
  assert.equal(
    await docker("exec", names.gateway, "cat", "/data/secrets/container-admin-token"),
    admin.gateway,
  );
  // Kill the foreground wrapper, leaving inherited child pipes open. The
  // supervisor must observe exit (not wait forever for close), drain the process
  // group, exit, and let Docker's restart policy recover the complete role.
  await docker(
    "exec",
    names.client,
    "node",
    "--input-type=module",
    "-e",
    `
    import {createContainerController} from './lib/container-services.mjs';
    const state = await createContainerController({root:'/data'}).status();
    process.kill(state.services.dashboard.pid,'SIGKILL');
  `,
  ).catch(() => {});
  await poll(
    async () => JSON.parse(await docker("inspect", names.client))[0],
    (info) => info.RestartCount > 0 && info.State.Running,
    90_000,
  );
  await poll(
    async () => {
      await refreshBase("client");
      return api("client", "/ready");
    },
    (result) => result.ok,
    90_000,
  );
  // Recreate the client against the same volume: config, clone and job survive.
  await docker("stop", names.client);
  await docker("rm", names.client);
  await start("client", clientVolume);
  assert.equal((await api("client", `/api/jobs/${clientJob.id}`)).status, "succeeded");
  await docker("exec", names.client, "test", "-f", "/data/vaults/git/note.md").catch(async () => {
    // The registry's inferred directory follows its explicit vault ID.
    await docker("exec", names.client, "test", "-f", "/data/vaults/notes/note.md");
  });
  console.log(
    JSON.stringify({
      ok: true,
      nonRoot: true,
      readonlyRoot: true,
      gatewayGitEmbedding: indexed.result.verified,
      clientGitEmbedding: true,
      unauthorizedAdmin: 401,
      unauthorizedMcp: 401,
      directoryImport: 403,
      restartPersistence: true,
      recreatePersistence: true,
      crashRecovery: true,
    }),
  );
} catch (error) {
  for (const name of containers)
    console.error(
      name,
      (await docker("logs", "--tail", "30", name).catch(() => "unavailable"))
        .replaceAll(admin.gateway || "<unset>", "[redacted]")
        .replaceAll(admin.client || "<unset>", "[redacted]"),
    );
  throw error;
} finally {
  if (process.env.AO_SMOKE_KEEP === "1") {
    await writeFile(
      "/tmp/any-obs-docker-qa.json",
      JSON.stringify({ containers, volumes, network, bases, admin }),
      { mode: 0o600 },
    );
    console.log("Disposable QA fixture retained; details in /tmp/any-obs-docker-qa.json");
  } else {
    for (const name of containers.reverse()) await docker("rm", "-f", name).catch(() => {});
    for (const volume of volumes) await docker("volume", "rm", volume).catch(() => {});
    await docker("network", "rm", network).catch(() => {});
  }
}
