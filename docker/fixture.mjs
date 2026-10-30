// Disposable fake AnythingLLM and dumb-HTTP Git origin for docker/smoke.mjs.
// Excluded from the production image.
import { createServer } from "node:http";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

await mkdir("/tmp/source", { recursive: true });
const git = (...args) => execFileSync("git", args, { stdio: "pipe" });
git("init", "--initial-branch=main", "/tmp/source");
await writeFile("/tmp/source/note.md", "# Container knowledge\nA disposable test note.\n");
git("-C", "/tmp/source", "add", ".");
git(
  "-C",
  "/tmp/source",
  "-c",
  "user.name=Fixture",
  "-c",
  "user.email=fixture@example.test",
  "commit",
  "-m",
  "fixture",
);
git("clone", "--bare", "/tmp/source", "/tmp/git.git");
git("--git-dir=/tmp/git.git", "update-server-info");
const workspaces = new Map(),
  documents = new Map();
let counter = 0;
createServer(async (req, res) => {
  const url = new URL(req.url, "http://upstream");
  const send = (status, data) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };
  try {
    if (url.pathname.startsWith("/git.git/") && !url.pathname.includes("..")) {
      try {
        res.end(await readFile("/tmp" + url.pathname));
      } catch {
        send(404, {});
      }
      return;
    }
    if (req.headers.authorization !== "Bearer fixture-developer-key") return send(401, {});
    let text = "";
    for await (const chunk of req) text += chunk;
    const input = req.headers["content-type"]?.includes("application/json")
      ? JSON.parse(text || "{}")
      : {};
    if (url.pathname === "/api/v1/workspaces")
      return send(200, { workspaces: [...workspaces.values()] });
    if (url.pathname === "/api/v1/workspace/new") {
      const slug = input.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
      const workspace = { slug, name: input.name, id: workspaces.size + 1 };
      workspaces.set(slug, workspace);
      documents.set(slug, new Set());
      return send(200, { workspace });
    }
    const workspace = url.pathname.match(/^\/api\/v1\/workspace\/([^/]+)(?:\/(.*))?$/);
    if (workspace) {
      const [, slug, action] = workspace;
      if (action === "documents")
        return send(200, {
          documents: [...(documents.get(slug) || [])].map((docpath) => ({ docpath })),
        });
      if (!action)
        return send(200, {
          workspace: {
            ...workspaces.get(slug),
            documents: [...(documents.get(slug) || [])].map((docpath) => ({ docpath })),
          },
        });
      if (action === "update-embeddings") {
        for (const location of input.adds || []) documents.get(slug).add(location);
        for (const location of input.deletes || []) documents.get(slug).delete(location);
      }
      return send(200, { workspace: workspaces.get(slug) });
    }
    if (url.pathname.startsWith("/api/v1/document/upload/")) {
      const folder = decodeURIComponent(url.pathname.split("/").at(-1));
      return send(200, { documents: [{ location: `${folder}/note-${++counter}.json` }] });
    }
    if (url.pathname === "/api/v1/document/remove-folder") return send(200, { success: true });
    send(200, {});
  } catch (error) {
    send(500, { error: error.message });
  }
}).listen(3001, "0.0.0.0");
