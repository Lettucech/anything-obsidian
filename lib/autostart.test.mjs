import assert from "node:assert/strict";
import test from "node:test";
import { buildPlistXml, buildUnitFile } from "./autostart.mjs";

test("launchd definitions escape paths and include restart policy and pinned environment", () => {
  const xml = buildPlistXml({
    label: "test",
    programArguments: ["/a & b/node", "run", "dashboard"],
    logPath: "/logs/a<b.log",
    environment: { ANYTHING_OBSIDIAN_HOME: "/data & notes", AO_SUPERVISED: "1" },
  });
  assert.match(xml, /a &amp; b/);
  assert.match(xml, /a&lt;b/);
  assert.match(xml, /KeepAlive/);
  assert.match(xml, /AO_SUPERVISED/);
});

test("systemd definitions quote spaces, quotes, dollars and percent specifiers", () => {
  const unit = buildUnitFile({
    description: "Anything Obsidian",
    programArguments: ["/a b/node", "/app/%data/$run.mjs", "run", "dashboard"],
    logPath: "/log",
    environment: { ANYTHING_OBSIDIAN_HOME: '/a "quoted" %dir', AO_SUPERVISED: "1" },
  });
  assert.match(unit, /"\/a b\/node"/);
  assert.ok(unit.includes("%%data/$$run"));
  assert.ok(unit.includes('\\"quoted\\" %%dir'));
  assert.match(unit, /Restart=always/);
  assert.match(unit, /AO_SUPERVISED=1/);
});
