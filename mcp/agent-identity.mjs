import { timingSafeEqual } from "node:crypto";

// Two connection kinds, two identities: a loopback local caller whose admin
// token (containers) or loopback reach grants the owner's full surface, and
// everyone else — anonymous until a real server-side token takes over. The
// LAN agent-token identities were retired with the 21504 listener; their
// hashed tokens now live in the server user directory.
export function resolveIdentity(authorization, { adminToken }) {
  if (adminToken && hasBearerToken(authorization, adminToken)) return { kind: "admin" };
  return { kind: "anonymous" };
}

export function hasBearerToken(authorization, token) {
  if (!token || typeof authorization !== "string") return false;
  const expected = Buffer.from(`Bearer ${token}`, "utf8");
  const provided = Buffer.from(authorization, "utf8");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
