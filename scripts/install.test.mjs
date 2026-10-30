import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
const exec = promisify(execFile);
const installer = new URL("../install.sh", import.meta.url).pathname;

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "any-obs-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = root + "/bin",
    source = root + "/source/release";
  await mkdir(bin);
  await mkdir(source + "/bin", { recursive: true });
  await symlink(process.execPath, bin + "/node");
  await writeFile(bin + "/npm", "process.exit(0);\n");
  await writeFile(bin + "/git", '#!/bin/sh\nprintf "git version test\\n"\n');
  await chmod(bin + "/git", 0o755);
  await writeFile(bin + "/curl", '#!/bin/sh\ncat "$AO_TEST_ARCHIVE"\n');
  await chmod(bin + "/curl", 0o755);
  await writeFile(
    source + "/package.json",
    '{"name":"anything-obsidian","version":"0.4.0","type":"module"}',
  );
  await writeFile(
    source + "/bin/anything-obsidian.mjs",
    `import {appendFile} from 'node:fs/promises';
await appendFile(process.env.AO_TEST_CALLS, JSON.stringify({args:process.argv.slice(2),root:process.env.ANYTHING_OBSIDIAN_HOME,app:process.env.ANYTHING_OBSIDIAN_APP_HOME})+'\\n');
if(process.argv[2]==='status') console.log(JSON.stringify({ok:true}));
`,
  );
  const archive = root + "/release.tar.gz";
  await exec("tar", ["-czf", archive, "-C", root + "/source", "release"]);
  const appRoot = root + "/app 'quoted' $HOME";
  const dataRoot = root + "/data 'quoted' $HOME `touch PWNED`";
  const env = {
    ...process.env,
    HOME: root,
    PATH: `${bin}:/usr/bin:/bin`,
    SHELL: "/bin/sh",
    AO_INSTALLER_EXECED: "1",
    ANYTHING_OBSIDIAN_APP_HOME: appRoot,
    ANYTHING_OBSIDIAN_HOME: dataRoot,
    AO_TEST_ARCHIVE: archive,
    AO_TEST_CALLS: root + "/calls.jsonl",
  };
  const args = [
    installer,
    "--vaults-root",
    root + "/notes with spaces",
    "--url",
    "http://fake.test",
    "--api-key",
    "fake key ' $x",
    "--no-browser",
  ];
  return { root, appRoot, dataRoot, env, args };
}

test("installer preserves arguments and pins the data root in a safely quoted launcher", async (t) => {
  const f = await fixture(t);
  await exec("sh", f.args, { env: f.env, cwd: f.root });
  const launcher = f.root + "/.local/bin/anything-obsidian";
  const freshShell = { ...f.env };
  delete freshShell.ANYTHING_OBSIDIAN_HOME;
  delete freshShell.ANYTHING_OBSIDIAN_APP_HOME;
  await exec(launcher, ["status", "--json"], { env: freshShell, cwd: f.root });
  const calls = (await readFile(f.root + "/calls.jsonl", "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  const setup = calls.find((call) => call.args[0] === "setup");
  assert.equal(setup.args[setup.args.indexOf("--api-key") + 1], "fake key ' $x");
  assert.equal(setup.args[setup.args.indexOf("--vaults-root") + 1], f.root + "/notes with spaces");
  assert.equal(calls.at(-1).root, f.dataRoot);
  assert.equal(calls.at(-1).app, f.appRoot);
  assert.equal(existsSync(f.root + "/PWNED"), false);
});

test("installer refuses to replace an existing app and preserves its files", async (t) => {
  const f = await fixture(t);
  await mkdir(f.appRoot + "/app", { recursive: true });
  await writeFile(f.appRoot + "/app/keep", "existing release");
  await assert.rejects(
    exec("sh", f.args, { env: f.env, cwd: f.root }),
    /Use anything-obsidian update/,
  );
  assert.equal(await readFile(f.appRoot + "/app/keep", "utf8"), "existing release");
});
