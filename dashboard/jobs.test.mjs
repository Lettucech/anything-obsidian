import assert from "node:assert/strict";
import test from "node:test";

import { createJobManager } from "./jobs.mjs";

test("rejects unknown worker actions", async () => {
  const manager = createJobManager({ docker: fakeDocker(), now: () => 1 });
  await assert.rejects(() => manager.start("rm-all", []), /Unknown action/);
});

test("prevents duplicate active jobs", async () => {
  const docker = fakeDocker({ wait: new Promise(() => {}) });
  const manager = createJobManager({ docker, now: () => 1 });

  await manager.start("doctor", []);
  await assert.rejects(() => manager.start("doctor", []), /already running/);
});

test("blocks embed action when AnythingLLM is not running", async () => {
  const manager = createJobManager({ docker: fakeDocker(), now: () => 1 });

  await assert.rejects(
    () => manager.start("embed", [{ id: "anythingllm", running: false }]),
    /requires AnythingLLM/,
  );
});

test("doctor can run while AnythingLLM is stopped", async () => {
  const docker = fakeDocker();
  const manager = createJobManager({ docker, now: () => 1 });

  const job = await manager.start("doctor", [{ id: "anythingllm", running: false }]);
  await settle();

  assert.equal(job.actionId, "doctor");
  assert.equal(manager.get(job.id).status, "succeeded");
  assert.deepEqual(docker.created[0].Cmd, ["doctor"]);
});

test("creates fixed worker container config for embed all", async () => {
  const docker = fakeDocker();
  const manager = createJobManager({
    docker,
    now: () => 1,
  });

  await manager.start("embed-all", [{ id: "anythingllm", running: true }]);
  await settle();

  assert.equal(docker.created.length, 1);
  assert.deepEqual(docker.created[0].Cmd, ["embed", "--all"]);
  assert.equal(docker.created[0].Image, "anything-obsidian-worker");
  assert.deepEqual(docker.created[0].HostConfig.Binds, [
    "/repo/.env:/workspace/.env:ro",
    "/Users/me/vault:/vault",
    "anything-obsidian-worker-state:/workspace/.anything-obsidian-state",
  ]);
  assert.equal(docker.created[0].HostConfig.NetworkMode, "anything-obsidian_default");
  assert.deepEqual(docker.created[0].Env, [
    "ANYTHINGLLM_BASE_URL=http://anythingllm:3001",
    "VAULT_PATH=/vault",
  ]);
});

function fakeDocker({ wait = Promise.resolve({ StatusCode: 0 }) } = {}) {
  return {
    created: [],
    async inspectContainerDetails(name) {
      assert.equal(name, "anything-obsidian-syncer");
      return {
        Config: {
          Image: "anything-obsidian-worker",
          Env: ["ANYTHINGLLM_BASE_URL=http://anythingllm:3001", "VAULT_PATH=/vault"],
        },
        HostConfig: {
          NetworkMode: "anything-obsidian_default",
        },
        Mounts: [
          { Type: "bind", Source: "/repo/.env", Destination: "/workspace/.env", Mode: "ro", RW: false },
          { Type: "bind", Source: "/Users/me/vault", Destination: "/vault", Mode: "rw", RW: true },
          {
            Type: "volume",
            Name: "anything-obsidian-worker-state",
            Destination: "/workspace/.anything-obsidian-state",
            Mode: "rw",
            RW: true,
          },
        ],
      };
    },
    async createContainer(body) {
      this.created.push(body);
      return { Id: "job123" };
    },
    async startContainerById() {},
    async waitContainer() {
      return await wait;
    },
    async containerLogs() {
      return "[anything-obsidian-worker] done";
    },
    async removeContainer() {},
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}
