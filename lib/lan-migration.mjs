// One-shot LAN retirement (2026-11-02 spec): the 21504 listener and its
// agent-token store are gone; their hashed tokens move into the server user
// directory so holders keep working without re-issuance. Both systems hash
// tokens as sha-256 hex, so the digest is copied verbatim. Each imported
// agent is granted read on the vault workspace that exists today — the
// visibility LAN agents had. The old agent-tokens/ directory is never
// deleted; a failed copy is logged, never fatal.
import { readFile } from "node:fs/promises";
import path from "node:path";

import { createUserStore } from "../server/iam.mjs";
import { loadWorkspace } from "../mcp/vault-registry.mjs";

export async function migrateLanAgents({
  root,
  installation,
  vaultRegistryPath,
  log = console.error,
}) {
  const profile = await installation.load();
  if (!profile.lan) return { migrated: false };
  const report = { migrated: true, imported: [], granted: [], skipped: [] };

  let agents = [];
  try {
    agents =
      JSON.parse(await readFile(path.join(root, "agent-tokens", "agents.json"), "utf8"))
        ?.agents ?? [];
  } catch (error) {
    if (error?.code !== "ENOENT")
      log(`[any-obs-server] LAN migration could not read agent tokens: ${error?.message ?? error}`);
  }

  const users = createUserStore({ dataDir: path.join(root, "gateway") });
  for (const agent of agents) {
    if (typeof agent?.name !== "string" || typeof agent?.tokenHash !== "string") continue;
    try {
      const imported = await users.importUser({
        name: agent.name,
        role: "member",
        tokenHash: agent.tokenHash,
      });
      report[imported ? "imported" : "skipped"].push(agent.name);
    } catch (error) {
      report.skipped.push(agent.name);
      log(`[any-obs-server] LAN token not migrated for ${agent.name}: ${error?.message ?? error}`);
    }
  }

  const workspace = await loadWorkspace(vaultRegistryPath).catch(() => null);
  if (workspace?.slug) {
    await users.recordWorkspace(workspace.slug, { kind: "shared" }).catch(() => null);
    for (const name of [...report.imported, ...report.skipped]) {
      try {
        await users.grantWorkspaceAccess(workspace.slug, name);
        report.granted.push(name);
      } catch (error) {
        log(`[any-obs-server] could not grant '${name}' read on ${workspace.slug}: ${error?.message ?? error}`);
      }
    }
  }

  await installation.update({ lan: false });
  log(
    `[any-obs-server] LAN MCP retired: ${report.imported.length} agent token(s) became server user tokens` +
      (report.skipped.length ? `; skipped: ${report.skipped.join(", ")}` : ""),
  );
  return report;
}
