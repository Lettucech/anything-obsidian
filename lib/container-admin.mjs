import { randomBytes, timingSafeEqual, createHmac } from "node:crypto";
import { readFile, mkdir, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { defaultConfigRoot } from "./app-config.mjs";
import { isContainer } from "./deployment.mjs";
import { assertLoopbackRequest } from "./loopback-http.mjs";

export const containerTokenPath = (root) => path.join(root, "secrets", "container-admin-token");
export async function ensureContainerToken(root) {
  const file = containerTokenPath(root);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    await writeFile(file, `${randomBytes(32).toString("base64url")}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await chmod(file, 0o600);
  return readContainerToken(root);
}
export async function readContainerToken(root) {
  const token = (await readFile(containerTokenPath(root), "utf8")).trim();
  if (token.length < 32)
    throw new Error("Invalid container admin token; restore secrets/container-admin-token");
  return token;
}
export async function adminHeaders(env = process.env) {
  return isContainer(env)
    ? { Authorization: `Bearer ${await readContainerToken(defaultConfigRoot({ env }))}` }
    : {};
}
function equal(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const first = Buffer.from(a || ""),
    second = Buffer.from(b || "");
  return first.length === second.length && timingSafeEqual(first, second);
}
const sign = (expiry, token) => createHmac("sha256", token).update(expiry).digest("base64url");

// Create one gate per HTTP server. Host/origin validation still applies; Docker
// port publishing does not make container-network reach proof of authority.
export function createAdminGate(env = process.env, { now = Date.now } = {}) {
  const cookieName =
    env.AO_CONTAINER_ROLE === "gateway" ? "any_obs_gateway_session" : "any_obs_client_session";
  let attempts = [];
  return async (req, res) => {
    assertLoopbackRequest(req);
    if (!isContainer(env)) return true;
    const pathname = new URL(req.url, "http://localhost").pathname;
    const token = await readContainerToken(defaultConfigRoot({ env }));
    const json = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(value));
      return false;
    };
    if (pathname === "/container/login" && req.method === "POST") {
      attempts = attempts.filter((time) => now() - time < 60_000);
      if (attempts.length >= 10)
        return json(429, { error: "Too many login attempts. Try again in a minute." });
      attempts.push(now());
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 4096) return json(413, { error: "Request too large" });
      }
      let input;
      try {
        input = JSON.parse(body);
      } catch {
        return json(400, { error: "Expected JSON" });
      }
      if (!equal(input?.token, token)) return json(401, { error: "Invalid admin token" });
      const expiry = String(now() + 8 * 60 * 60_000);
      res.setHeader(
        "Set-Cookie",
        `${cookieName}=${expiry}.${sign(expiry, token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
      );
      return json(200, { ok: true });
    }
    const cookie =
      String(req.headers.cookie || "")
        .split(/;\s*/)
        .find((item) => item.startsWith(`${cookieName}=`))
        ?.slice(cookieName.length + 1) || "";
    const [expiry, signature] = cookie.split(".");
    const session =
      Number(expiry) > now() &&
      Number(expiry) <= now() + 8 * 60 * 60_000 &&
      equal(signature, sign(expiry, token));
    if (equal(req.headers.authorization, `Bearer ${token}`) || session) return true;
    if (req.method === "GET" && (pathname === "/" || pathname === "/container/login")) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy":
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      });
      res.end(
        `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>any-obs · Docker login</title><style>body{font:16px system-ui;background:#111827;color:#eef2ff;margin:10vh auto;padding:24px;max-width:480px}input,button{font:inherit;padding:12px;box-sizing:border-box;width:100%;margin:8px 0}p{line-height:1.6}code{overflow-wrap:anywhere}</style><main><h1>Docker admin login</h1><p>Use the admin token stored in this service's data volume. See the Docker setup guide for the command to retrieve it.</p><form><label for="token">Admin token</label><input id="token" type="password" autocomplete="current-password" required><button>Sign in</button></form><p role="alert"></p></main><script>document.querySelector('form').addEventListener('submit',async e=>{e.preventDefault();const output=document.querySelector('[role=alert]');try{const r=await fetch('/container/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:document.querySelector('input').value})});if(r.ok)location.assign('/');else output.textContent=(await r.json()).error}catch{output.textContent='Connection unavailable. Try again.'}})</script></html>`,
      );
      return false;
    }
    return json(401, { error: "Docker admin login required" });
  };
}
