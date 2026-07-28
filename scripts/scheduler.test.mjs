import assert from "node:assert/strict";
import test from "node:test";

import { runScheduler } from "./scheduler.mjs";

test("continues scheduling other vaults after one vault fails", async () => {
  const attempted = [];
  const errors = [];
  await runScheduler({
    registry: {
      async list() {
        return [
          { id: "work", enabled: true, syncIntervalSeconds: 300 },
          { id: "personal", enabled: true, syncIntervalSeconds: 300 },
        ];
      },
    },
    async runVault(id) {
      attempted.push(id);
      if (id === "work") throw new Error("remote unavailable");
    },
    sleep: async () => false,
    now: () => 1,
    logger: { error: (message) => errors.push(message) },
  });

  assert.deepEqual(attempted, ["work", "personal"]);
  assert.match(errors[0], /work.*remote unavailable/);
});
