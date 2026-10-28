// Gateway IAM: a named-user directory with hashed bearer tokens and
// workspace ownership. The gateway admin token is checked by the caller
// (env comparison); this store only knows user principals.
//
// Ownership is minted when a user's token creates a workspace through the
// proxy — that is how an any-obs client's unified workspace becomes the
// user's personal workspace without any client-side change.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const USER_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

export function createUserStore({ dataDir, sharedWorkspaceSlug }) {
  const filePath = path.join(dataDir, "users.json");
  const cache = snapshotKeeper();

  return {
    async list() {
      return (await read()).users.map(({ tokenHash, ...user }) => user);
    },
    async get(name) {
      return (await read()).users.find((user) => user.name === name) ?? null;
    },
    async create(input) {
      const name = String(input?.name ?? "");
      if (!USER_NAME_PATTERN.test(name)) {
        throw new Error("User name must be lowercase dash-separated text");
      }
      const state = await read();
      if (state.users.some((user) => user.name === name)) {
        throw new Error(`User already exists: ${name}`);
      }
      const token = randomBytes(24).toString("base64url");
      const user = {
        name,
        tokenHash: hashToken(token),
        createdAt: new Date().toISOString(),
      };
      state.users.push(user);
      await write(state);
      return { user: { name, createdAt: user.createdAt }, token };
    },
    async remove(name) {
      const state = await read();
      const index = state.users.findIndex((user) => user.name === name);
      if (index === -1) return null;
      // Owned workspaces stay recorded: the derived data is not the user's to
      // take down, and a re-created user of the same name regains access.
      state.users.splice(index, 1);
      await write(state);
      return { name };
    },
    verify(token) {
      return verify(token);
    },
    async ownedWorkspaces(name) {
      const state = await read();
      return Object.entries(state.workspaces)
        .filter(([, owner]) => owner === name)
        .map(([slug]) => slug);
    },
    async recordOwnership(slug, name) {
      const state = await read();
      if (state.workspaces[slug]) return state.workspaces[slug];
      state.workspaces[slug] = name;
      await write(state);
      return name;
    },
    async entitlements(name) {
      const owned = await this.ownedWorkspaces(name);
      return {
        read: unique([sharedWorkspaceSlug, ...owned]),
        write: owned,
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
        return { kind: "user", name: user.name };
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
        ? parsed.users.filter((user) => typeof user?.name === "string" && typeof user?.tokenHash === "string")
        : [],
      workspaces: parsed?.workspaces && typeof parsed.workspaces === "object" ? parsed.workspaces : {},
    };
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

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
