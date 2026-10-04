import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export function createAgentTokenStore({ rootPath, randomToken = defaultRandomToken }) {
  if (!rootPath) throw new Error("rootPath is required");

  return {
    async list() {
      return (await readAgents(rootPath)).agents;
    },
    async create(name) {
      const agentName = requiredSlug(name, "name");
      const agents = await readAgents(rootPath);
      if (agents.agents.some((agent) => agent.name === agentName)) {
        throw new Error(`Agent already exists: ${agentName}`);
      }
      const token = randomToken();
      const agent = {
        name: agentName,
        tokenHash: sha256Hex(token),
        createdAt: new Date().toISOString(),
      };
      agents.agents.push(agent);
      await writeAgents(rootPath, agents);
      return { agent, token };
    },
    async remove(name) {
      const agentName = requiredSlug(name, "name");
      const agents = await readAgents(rootPath);
      const index = agents.agents.findIndex((agent) => agent.name === agentName);
      if (index === -1) return false;
      agents.agents.splice(index, 1);
      await writeAgents(rootPath, agents);
      return true;
    },
  };
}

export function agentsPath(rootPath) {
  return path.join(rootPath, "agents.json");
}

function defaultRandomToken() {
  return randomBytes(32).toString("base64url");
}

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requiredSlug(value, name) {
  const text = String(value ?? "").trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(text)) {
    throw new Error(`${name} must be lowercase dash-separated text`);
  }
  return text;
}

async function readAgents(rootPath) {
  try {
    const parsed = JSON.parse(await readFile(agentsPath(rootPath), "utf8"));
    return { version: 1, agents: Array.isArray(parsed.agents) ? parsed.agents.filter(isAgentRecord) : [] };
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 1, agents: [] };
    throw error;
  }
}

function isAgentRecord(value) {
  return Boolean(value) && typeof value === "object" &&
    typeof value.name === "string" && value.name.length > 0 &&
    typeof value.tokenHash === "string" && value.tokenHash.length > 0 &&
    typeof value.createdAt === "string";
}

async function writeAgents(rootPath, agents) {
  await mkdir(rootPath, { recursive: true, mode: 0o700 });
  const destination = agentsPath(rootPath);
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(agents, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, destination);
}
