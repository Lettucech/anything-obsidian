// Pure per-request decisions for the AnythingLLM proxy. The gateway feeds
// every non-gateway /api/ request through decide() and enforces the result;
// no I/O happens here so every rule is directly testable.
//
// Conservative by design: user tokens get exactly what a client or consumer
// needs (entitled RAG, their own workspace lifecycle and document folders)
// and everything else is denied. The admin-plane identity passes through for
// recovery. The gateway's own shared-source pipeline never goes through the
// proxy — it talks to AnythingLLM directly with the admin key, keeping the
// pipeline the only writer to the shared workspace.

export const VAULT_FOLDER_PATTERN = /^anything-obsidian-vault-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function decide({ method, pathname, identity, body, entitlements }) {
  const isUser = identity?.kind === "user";
  const isAdmin = identity?.kind === "admin";
  if (!identity) return deny(401, "Bearer token required");
  if (!isUser && !isAdmin) return deny(403, "Unknown identity");

  if (pathname === "/api/v1/workspaces" && method === "GET") {
    if (isAdmin) return { action: "proxy" };
    return { action: "workspaces-list" };
  }

  if (pathname === "/api/v1/workspace/new" && method === "POST") {
    if (isAdmin) return { action: "proxy" };
    return { action: "create-workspace" };
  }

  const workspaceAction = pathname.match(/^\/api\/v1\/workspace\/([^/]+)\/(vector-search|chat|update-embeddings)$/);
  if (workspaceAction && method === "POST") {
    const slug = decodeURIComponent(workspaceAction[1]);
    const action = workspaceAction[2];
    if (action === "update-embeddings") {
      if (isAdmin) return { action: "proxy" };
      if (!entitlements.write.includes(slug)) return deny(403, `Workspace is not writable by this user: ${slug}`);
      return { action: "proxy" };
    }
    if (isAdmin) return { action: "proxy" };
    if (!entitlements.read.includes(slug)) return deny(403, `Workspace is not readable by this user: ${slug}`);
    return { action: "proxy" };
  }

  const upload = pathname.match(/^\/api\/v1\/document\/upload\/([^/]+)$/);
  if (upload && method === "POST") {
    const folder = decodeURIComponent(upload[1]);
    if (isAdmin) return { action: "proxy" };
    if (!VAULT_FOLDER_PATTERN.test(folder)) return deny(403, `Folder is not a vault pipeline folder: ${folder}`);
    return { action: "proxy" };
  }

  if (pathname === "/api/v1/document/remove-folder" && method === "DELETE") {
    const folder = String(body?.name ?? "");
    if (isAdmin) return { action: "proxy" };
    if (!VAULT_FOLDER_PATTERN.test(folder)) return deny(403, `Folder is not a vault pipeline folder: ${folder}`);
    return { action: "proxy" };
  }

  if (isAdmin) return { action: "proxy" };
  return deny(403, `User tokens cannot call this endpoint: ${method} ${pathname}`);
}

function deny(status, reason) {
  return { action: "deny", status, reason };
}
