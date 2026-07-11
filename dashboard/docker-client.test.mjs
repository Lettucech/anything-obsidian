import assert from "node:assert/strict";
import test from "node:test";

import { DockerClient, encodeContainerName } from "./docker-client.mjs";

test("encodes container names for Docker API paths", () => {
  assert.equal(encodeContainerName("anything-obsidian-syncer"), "anything-obsidian-syncer");
  assert.equal(encodeContainerName("name with spaces"), "name%20with%20spaces");
});

test("inspectContainer maps 404 to found false", async () => {
  const client = new DockerClient({
    request: async () => ({ statusCode: 404, body: { message: "No such container" } }),
  });

  assert.deepEqual(await client.inspectContainer("anything-obsidian-syncer"), {
    found: false,
    name: "anything-obsidian-syncer",
    state: "missing",
    running: false,
    status: "missing",
  });
});

test("inspectContainer maps Docker state", async () => {
  const client = new DockerClient({
    request: async () => ({
      statusCode: 200,
      body: {
        Id: "abc123",
        Name: "/anything-obsidian-syncer",
        State: { Status: "running", Running: true },
      },
    }),
  });

  assert.deepEqual(await client.inspectContainer("anything-obsidian-syncer"), {
    found: true,
    id: "abc123",
    name: "anything-obsidian-syncer",
    state: "running",
    running: true,
    status: "running",
  });
});

test("start stop and logs use exact Docker API endpoints", async () => {
  const calls = [];
  const client = new DockerClient({
    request: async (options) => {
      calls.push(options);
      if (options.path.includes("/logs")) return { statusCode: 200, body: "hello\n" };
      return { statusCode: 204, body: "" };
    },
  });

  await client.startContainer("anything-obsidian-syncer");
  await client.stopContainer("anything-obsidian-syncer");
  assert.equal(await client.containerLogs("anything-obsidian-syncer", { tail: 25 }), "hello\n");

  assert.deepEqual(calls, [
    {
      method: "POST",
      path: "/containers/anything-obsidian-syncer/start",
      socketPath: "/var/run/docker.sock",
    },
    {
      method: "POST",
      path: "/containers/anything-obsidian-syncer/stop?t=10",
      socketPath: "/var/run/docker.sock",
    },
    {
      method: "GET",
      path: "/containers/anything-obsidian-syncer/logs?stdout=1&stderr=1&tail=25",
      socketPath: "/var/run/docker.sock",
    },
  ]);
});

test("inspectContainerDetails returns raw Docker inspect payload", async () => {
  const client = new DockerClient({
    request: async () => ({
      statusCode: 200,
      body: {
        Id: "syncer123",
        Config: { Image: "anything-obsidian-worker" },
        HostConfig: { NetworkMode: "anything-obsidian_default" },
        Mounts: [{ Source: "/repo/.env", Destination: "/workspace/.env" }],
      },
    }),
  });

  assert.equal((await client.inspectContainerDetails("anything-obsidian-syncer")).Id, "syncer123");
});
