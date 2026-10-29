// Gateway IAM: a named-user directory with hashed bearer tokens, roles,
// and the gateway's own workspace registry. There is no admin credential to
// check here — the admin plane is host-loopback and reaching it is the
// proof.
//
// Workspace registry: nothing is pre-provisioned. A workspace record is
//   { kind: "shared"|"personal", owner, grants }
// — shared workspaces carry a grants list (which users may read them) and
// are fed by the shared-source pipeline targeting them; personal workspaces
// carry exactly one owner and are minted by that user's client through the
// proxy (or pre-provisioned by an admin). Legacy volumes stored the plain
// owner string; those load as personal records.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const USER_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ROLES = ["admin", "member", "reader"];

export function normalizeRole(value) {
  const role = String(value ?? "member");
  if (!ROLES.includes(role)) {
    throw new Error(`Role must be one of: ${ROLES.join(", ")}`);
  }
  return role;
}

export function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

export function createUserStore({ dataDir }) {
  const filePath = path.join(dataDir, "users.json");
  const cache = snapshotKeeper();

  return {
    async list() {
      const state = await read();
      return state.users.map(({ tokenHash, ...user }) => ({
        ...user,
        workspaces: Object.entries(state.workspaces)
          .filter(([, record]) => record.kind === "personal" && record.owner === user.name)
          .map(([slug]) => slug)
          .sort(),
      }));
    },
    async get(name) {
      return (await read()).users.find((user) => user.name === name) ?? null;
    },
    async create(input) {
      const name = String(input?.name ?? "");
      if (!USER_NAME_PATTERN.test(name)) {
        throw new Error("User name must be lowercase dash-separated text");
      }
      const role = normalizeRole(input?.role);
      const state = await read();
      if (state.users.some((user) => user.name === name)) {
        throw new Error(`User already exists: ${name}`);
      }
      const token = randomBytes(24).toString("base64url");
      const user = {
        name,
        role,
        tokenHash: hashToken(token),
        createdAt: new Date().toISOString(),
      };
      state.users.push(user);
      await write(state);
      return { user: { name, role, createdAt: user.createdAt }, token };
    },
    async updateRole(name, input) {
      const role = normalizeRole(input);
      const state = await read();
      const user = state.users.find((candidate) => candidate.name === name);
      if (!user) return null;
      user.role = role;
      await write(state);
      return { name, role, createdAt: user.createdAt };
    },
    async resetToken(name) {
      const state = await read();
      const user = state.users.find((candidate) => candidate.name === name);
      if (!user) return null;
      const token = randomBytes(24).toString("base64url");
      user.tokenHash = hashToken(token);
      await write(state);
      return { user: { name: user.name, role: user.role, createdAt: user.createdAt }, token };
    },
    async remove(name) {
      const state = await read();
      const index = state.users.findIndex((user) => user.name === name);
      if (index === -1) return null;
      // Workspace records stay: the derived data is not the user's to take
      // down, and a re-created user of the same name regains access.
      state.users.splice(index, 1);
      await write(state);
      return { name };
    },
    verify(token) {
      return verify(token);
    },

    // ---- workspace registry ----

    async workspaces() {
      return Object.entries((await read()).workspaces).map(([slug, record]) => ({
        slug,
        kind: record.kind,
        ...(record.kind === "personal" ? { owner: record.owner } : { grants: [...record.grants] }),
      }));
    },
    async workspaceRecord(slug) {
      return (await read()).workspaces[slug] ?? null;
    },
    async recordWorkspace(slug, { kind, owner = null }) {
      const state = await read();
      const existing = state.workspaces[slug];
      if (existing) return existing;
      state.workspaces[slug] = kind === "shared"
        ? { kind: "shared", grants: [] }
        : { kind: "personal", owner: String(owner ?? "") };
      await write(state);
      return state.workspaces[slug];
    },
    // Legacy proxy-mint flow: ownership record for a personal workspace.
    async recordOwnership(slug, name) {
      const existing = await this.workspaceRecord(slug);
      if (existing) return existing.owner ?? name;
      await this.recordWorkspace(slug, { kind: "personal", owner: name });
      return name;
    },
    async grantWorkspaceAccess(slug, name) {
      const state = await read();
      const record = state.workspaces[slug];
      if (!record || record.kind !== "shared") throw new Error(`Not a shared workspace: ${slug}`);
      if (!state.users.some((user) => user.name === name)) throw new Error(`Unknown user: ${name}`);
      if (!record.grants.includes(name)) record.grants.push(name);
      await write(state);
      return [...record.grants];
    },
    async revokeWorkspaceAccess(slug, name) {
      const state = await read();
      const record = state.workspaces[slug];
      if (!record || record.kind !== "shared") throw new Error(`Not a shared workspace: ${slug}`);
      record.grants = record.grants.filter((granted) => granted !== name);
      await write(state);
      return [...record.grants];
    },
    async removeWorkspace(slug) {
      const state = await read();
      if (!state.workspaces[slug]) return false;
      delete state.workspaces[slug];
      await write(state);
      return true;
    },
    async entitlements(name) {
      const state = await read();
      const user = state.users.find((candidate) => candidate.name === name);
      const readList = [];
      const writeList = [];
      for (const [slug, record] of Object.entries(state.workspaces)) {
        if (record.kind === "personal" && record.owner === name) {
          readList.push(slug);
          writeList.push(slug);
        } else if (record.kind === "shared" && record.grants.includes(name)) {
          readList.push(slug);
        }
      }
      return {
        read: readList.sort(),
        // Readers never write — not their own folders, not embeddings.
        write: user?.role === "reader" ? [] : writeList.sort(),
      };
    },
  };

  function verify(token) {
    if (!token) return null;
    const digest = Buffer.from(hashToken(token), "hex");
    const state = cache.snapshot();
    for (const user of state.users) {
      const candidate = Buffer.from(user.tokenHash, "hex");
      if (candidate.length === digest.length && timingSafeEqual(candidate, digest)) {
        return { kind: "user", name: user.name, role: user.role ?? "member" };
      }
    }
    return null;
  }

  async function read() {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") parsed = null;
      else throw error;
    }
    const state = normalize(parsed);
    cache.update(state);
    return state;
  }

  async function write(state) {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
    await rename(temporary, filePath);
    cache.update(state);
  }

  function normalize(parsed) {
    return {
      version: 1,
      users: Array.isArray(parsed?.users)
        ? parsed.users
          .filter((user) => typeof user?.name === "string" && typeof user?.tokenHash === "string")
          .map((user) => ({ ...user, role: ROLES.includes(user.role) ? user.role : "member" }))
        : [],
      workspaces: normalizeWorkspaces(parsed?.workspaces),
    };
  }

  function normalizeWorkspaces(value) {
    const out = {};
    for (const [slug, record] of Object.entries(value ?? {})) {
      if (typeof record === "string") {
        out[slug] = { kind: "personal", owner: record };
      } else if (record && typeof record === "object") {
        out[slug] = record.kind === "shared"
          ? { kind: "shared", grants: Array.isArray(record.grants) ? record.grants.filter((name) => typeof name === "string") : [] }
          : { kind: "personal", owner: typeof record.owner === "string" ? record.owner : "" };
      }
    }
    return out;
  }
}

function snapshotKeeper() {
  let current = { users: [], workspaces: {} };
  return {
    snapshot: () => current,
    update(state) {
      current = state;
    },
  };
}
