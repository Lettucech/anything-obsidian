import assert from "node:assert/strict";
import test from "node:test";

import { shouldEmbedAfterSync } from "./watch-vault.mjs";

test("skips embedding when required git push fails", () => {
  assert.equal(
    shouldEmbedAfterSync({
      embedAfterSync: true,
      gitAutoPush: true,
      pushSucceeded: false,
    }),
    false,
  );
});

test("embeds when push is disabled or succeeds", () => {
  assert.equal(
    shouldEmbedAfterSync({
      embedAfterSync: true,
      gitAutoPush: false,
      pushSucceeded: false,
    }),
    true,
  );
  assert.equal(
    shouldEmbedAfterSync({
      embedAfterSync: true,
      gitAutoPush: true,
      pushSucceeded: true,
    }),
    true,
  );
});
