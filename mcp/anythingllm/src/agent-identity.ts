import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { CallerIdentity } from "./vault-registry.js";

export type AgentIdentityRecord = { name: string; tokenHash: string };

export async function loadAgentIdentities(path: string): Promise<AgentIdentityRecord[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }
  const agents = (parsed as { agents?: unknown } | null)?.agents;
  if (!Array.isArray(agents)) return [];
  return agents.filter(isAgentRecord);
}

function isAgentRecord(value: unknown): value is AgentIdentityRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<AgentIdentityRecord>;
  return typeof record.name === "string" && record.name.length > 0 &&
    typeof record.tokenHash === "string" && record.tokenHash.length > 0;
}

export function resolveIdentity(
  authorization: string | undefined,
  { adminToken, agents }: { adminToken?: string; agents: AgentIdentityRecord[] },
): CallerIdentity {
  if (adminToken && hasBearerToken(authorization, adminToken)) return { kind: "admin" };
  if (authorization?.startsWith("Bearer ")) {
    const presentedHash = sha256Hex(authorization.slice("Bearer ".length));
    for (const agent of agents) {
      if (hashMatches(presentedHash, agent.tokenHash)) return { kind: "agent", name: agent.name };
    }
  }
  return { kind: "anonymous" };
}

export function hasBearerToken(authorization: string | undefined, token: string) {
  if (!token || typeof authorization !== "string") return false;
  const expected = Buffer.from(`Bearer ${token}`, "utf8");
  const provided = Buffer.from(authorization, "utf8");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

function hashMatches(presentedHash: string, storedHash: string): boolean {
  const provided = Buffer.from(presentedHash, "utf8");
  const stored = Buffer.from(storedHash, "utf8");
  if (provided.length !== stored.length) return false;
  return timingSafeEqual(provided, stored);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
