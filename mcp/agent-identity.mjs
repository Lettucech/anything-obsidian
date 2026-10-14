import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

export async function loadAgentIdentities(path) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const agents = parsed?.agents;
  if (!Array.isArray(agents)) return [];
  return agents.filter(isAgentRecord);
}

function isAgentRecord(value) {
  if (!value || typeof value !== "object") return false;
  return typeof value.name === "string" && value.name.length > 0 &&
    typeof value.tokenHash === "string" && value.tokenHash.length > 0;
}

export function resolveIdentity(authorization, { adminToken, agents }) {
  if (adminToken && hasBearerToken(authorization, adminToken)) return { kind: "admin" };
  if (authorization?.startsWith("Bearer ")) {
    const presentedHash = sha256Hex(authorization.slice("Bearer ".length));
    for (const agent of agents) {
      if (hashMatches(presentedHash, agent.tokenHash)) return { kind: "agent", name: agent.name };
    }
  }
  return { kind: "anonymous" };
}

export function hasBearerToken(authorization, token) {
  if (!token || typeof authorization !== "string") return false;
  const expected = Buffer.from(`Bearer ${token}`, "utf8");
  const provided = Buffer.from(authorization, "utf8");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

function hashMatches(presentedHash, storedHash) {
  const provided = Buffer.from(presentedHash, "utf8");
  const stored = Buffer.from(storedHash, "utf8");
  if (provided.length !== stored.length) return false;
  return timingSafeEqual(provided, stored);
}

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
