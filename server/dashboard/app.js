const els = {
  headline: document.querySelector("#headline"),
  status: document.querySelector("#status-line"),
  view: document.querySelector("#view"),
};

boot();

async function boot() {
  const state = await request("/api/setup/state", { method: "GET" }).catch(() => null);
  if (!state) return renderFatal("The gateway admin plane is not reachable. Are you on the server, or tunneled to it?");
  if (state.needsSetup) return renderWizard(state);
  return renderDashboard(state);
}

/* ---------- setup wizard ---------- */

function renderWizard(state) {
  els.headline.textContent = "Set up this gateway";
  let step = 1;
  const wizard = element("div", "wizard");

  const steps = [wizardAnythingllmStep, wizardApiKeyStep];

  function render() {
    wizard.replaceChildren(steps[step - 1]());
  }

  function wizardAnythingllmStep() {
    const card = element("section", "card");
    const tunnelCommand = `ssh -L 21505:127.0.0.1:21505 -L 21501:127.0.0.1:21501 ${window.location.hostname}`;
    card.append(
      stepBadge(1),
      element("h2", "", "Initialize AnythingLLM, then mint its API key"),
      element("p", "note", "AnythingLLM's own UI is not on the network — neither is this dashboard. Open both from the server itself, or tunnel once from your machine (this dashboard included):"),
    );
    const pre = element("pre", "command", tunnelCommand);
    const copy = element("button", "button button-quiet", "Copy");
    copy.addEventListener("click", () => {
      window.navigator.clipboard?.writeText(tunnelCommand);
      copy.textContent = "Copied";
    });
    pre.append(copy);
    card.append(
      pre,
      html("p", "note", `Open <code>${state.anythingllmUiUrl}</code> (on the server, or through the tunnel), finish AnythingLLM's first-boot wizard, then go to <strong>Settings → Developer API</strong> and generate an API key.`),
    );
    const next = element("button", "button button-primary", "I have the API key");
    next.addEventListener("click", () => {
      step = 2;
      render();
    });
    card.append(next);
    return card;
  }

  function wizardApiKeyStep() {
    const card = element("section", "card");
    card.append(
      stepBadge(2),
      element("h2", "", "Connect the gateway to AnythingLLM"),
      element("p", "note", "Paste the developer API key. The gateway verifies it, becomes its only holder, and prepares the shared workspace."),
    );
    const form = element("form", "");
    const input = element("input", "", "");
    input.type = "password";
    input.placeholder = "AnythingLLM developer API key";
    input.required = true;
    form.append(input);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await request("/api/setup/api-key", { method: "POST", body: JSON.stringify({ apiKey: input.value }) });
        window.location.reload();
      } catch (error) {
        card.querySelector(".error")?.remove();
        card.append(element("p", "error", error.message));
      }
    });
    card.append(form);
    return card;
  }

  els.status.textContent = `AnythingLLM: ${state.anythingllmBaseUrl || "unknown"} · shared workspace: ${state.sharedWorkspace}`;
  els.view.replaceChildren(wizard);
  render();
}

/* ---------- dashboard ---------- */

async function renderDashboard(state) {
  els.headline.textContent = "any-obs gateway";
  renderTabs(state);
  await renderOverview(state);
}

function renderTabs(state) {
  const tabs = element("nav", "tabs");
  const views = [
    ["Overview", renderOverview],
    ["Workspaces", renderWorkspaces],
    ["Users", renderUsers],
    ["Shared sources", renderSources],
  ];
  const buttons = new Map();
  for (const [label, render] of views) {
    const button = element("button", "tab", label);
    button.addEventListener("click", () => {
      for (const [other, node] of buttons) node.classList.toggle("active", other === label);
      render(state);
    });
    buttons.set(label, button);
    tabs.append(button);
  }
  buttons.get("Overview").classList.add("active");
  els.view.replaceChildren(tabs);
}

async function renderWorkspaces(state) {
  const card = element("section", "card");
  card.append(
    element("h2", "", "Workspaces"),
    element("p", "note", "The shared workspace is fed by the shared-source pipeline and is readable by everyone. Personal workspaces are minted by their owner's any-obs client through the proxy — or pre-provisioned here."),
  );
  const form = element("form", "row");
  const name = element("input", "", "");
  name.placeholder = "workspace name"; name.required = true;
  const owner = element("select", "", "");
  owner.innerHTML = '<option value="">(no owner)</option>';
  const { users } = await request("/api/gateway/users");
  for (const user of users) {
    const option = element("option", "", user.name);
    option.value = user.name;
    owner.append(option);
  }
  form.append(name, owner, element("button", "button button-primary", "Create workspace"));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const created = await request("/api/gateway/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: name.value, owner: owner.value }),
      });
      name.value = "";
      await fill();
    } catch (error) {
      card.querySelector(".error")?.remove();
      card.append(element("p", "error", error.message));
    }
  });
  card.append(form);
  const list = element("div", "list");
  card.append(list);
  els.view.append(card);

  async function fill() {
    const { workspaces } = await request("/api/gateway/workspaces");
    list.replaceChildren(...workspaces.map((workspace) => {
      const row = element("div", "row item");
      row.append(element("span", "pill", workspace.shared ? "shared" : "personal"));
      row.append(element("code", "", workspace.slug));
      if (workspace.shared) row.append(element("span", "muted", "pipeline-fed, readable by everyone"));
      else row.append(element("span", "muted", workspace.owner ? `owned by ${workspace.owner}` : "no owner"));
      if (!workspace.shared) {
        const remove = element("button", "button button-quiet button-danger", "Delete");
        remove.addEventListener("click", async () => {
          if (!window.confirm(`Delete workspace '${workspace.slug}'? Its embeddings are removed from AnythingLLM${workspace.owner ? ` and '${workspace.owner}' loses it — their client must re-create the workspace before indexing works again` : ""}.`)) return;
          await request(`/api/gateway/workspaces/${encodeURIComponent(workspace.slug)}`, { method: "DELETE" });
          await fill();
        });
        row.append(remove);
      }
      return row;
    }));
  }
  await fill();
}

async function renderOverview(state) {
  const card = element("section", "card");
  card.append(element("h2", "", "Overview"));
  const grid = element("div", "grid");
  try {
    const health = await request("/health", { method: "GET" });
    grid.append(
      metric("Status", health.ok ? "Running" : "Down"),
      metric("Shared workspace", health.sharedWorkspace),
      metric("Users", health.users),
      metric("Gateway version", health.version),
    );
  } catch (error) {
    card.append(element("p", "error", error.message));
  }
  card.append(grid);
  card.append(
    html("p", "note", `<strong>Connect an any-obs client:</strong> <code>anything-obsidian init --url ${window.location.protocol}//${window.location.hostname}:21500 --api-key &lt;user-token&gt;</code>`),
    html("p", "note", `<strong>Connect an agent (MCP):</strong> <code>${window.location.protocol}//${window.location.hostname}:21500/mcp</code> with a user token as Bearer.`),
    html("p", "note", `<strong>AnythingLLM UI</strong> stays off the network: open <code>${state.anythingllmUiUrl}</code> on the server, or <code>ssh -L 21501:127.0.0.1:21501 ${window.location.hostname}</code>.`),
  );
  els.status.textContent = "";
  els.view.append(card);
}

async function renderUsers() {
  const card = element("section", "card");
  card.append(element("h2", "", "Users"));
  const form = element("form", "row");
  const name = element("input", "", "");
  name.placeholder = "user-name (lowercase-dash)";
  name.required = true;
  const role = element("select", "", "");
  // Least privilege by default: new users start as readers; promote them.
  role.innerHTML = ["reader", "member", "admin"].map((value) =>
    `<option value="${value}"${value === "reader" ? " selected" : ""}>${value}</option>`,
  ).join("");
  const roleHelp = element("span", "muted", "reader (default): search only · member: shared + own workspaces · admin: also manages the gateway with this token");
  form.append(name, role, element("button", "button button-primary", "Create user"), roleHelp);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const created = await request("/api/gateway/users", { method: "POST", body: JSON.stringify({ name: name.value, role: role.value }) });
      name.value = "";
      revealToken(created.token, `Token for '${created.user.name}' (${created.user.role})`);
      await fillList();
    } catch (error) {
      card.querySelector(".error")?.remove();
      card.append(element("p", "error", error.message));
    }
  });
  card.append(form);
  const list = element("div", "list");
  card.append(list);
  els.view.append(card);

  async function fillList() {
    const { users } = await request("/api/gateway/users");
    list.replaceChildren(...(users.length ? users.map((user) => {
      const row = element("div", "row item columned");
      const line = element("div", "row");
      line.append(
        element("code", "", user.name),
        roleSelect(user),
        element("span", "muted", new Date(user.createdAt).toLocaleDateString()),
      );
      const reset = element("button", "button button-quiet", "Reset token");
      reset.addEventListener("click", async () => {
        if (!window.confirm(`Reset the token for '${user.name}'? Their old token stops working immediately.`)) return;
        const result = await request(`/api/gateway/users/${encodeURIComponent(user.name)}/reset-token`, { method: "POST" });
        revealToken(result.token, `New token for '${user.name}' (${result.user.role})`);
      });
      line.append(reset, revokeButton(user, fillList));
      row.append(line);
      for (const slug of user.workspaces ?? []) {
        const workspaceLine = element("div", "row workspace-line");
        workspaceLine.append(element("span", "pill", "workspace"), element("code", "", slug));
        const remove = element("button", "button button-quiet button-danger", "Delete");
        remove.addEventListener("click", async () => {
          if (!window.confirm(`Delete workspace '${slug}'? Its embeddings are removed from AnythingLLM and '${user.name}' loses it — their client must re-create the workspace before indexing works again.`)) return;
          await request(`/api/gateway/workspaces/${encodeURIComponent(slug)}`, { method: "DELETE" });
          await fillList();
        });
        workspaceLine.append(remove);
        row.append(workspaceLine);
      }
      return row;
    }) : [element("p", "note", "No users yet — create one for each person or agent (they start as readers; promote when you trust them).")]));
  }

  function roleSelect(user) {
    const select = element("select", "", "");
    select.innerHTML = ["member", "admin", "reader"].map((value) =>
      `<option value="${value}"${value === user.role ? " selected" : ""}>${value}</option>`,
    ).join("");
    select.addEventListener("change", async () => {
      try {
        await request(`/api/gateway/users/${encodeURIComponent(user.name)}`, { method: "PATCH", body: JSON.stringify({ role: select.value }) });
      } catch (error) {
        select.value = user.role;
        window.alert(error.message);
      }
    });
    return select;
  }

  function revokeButton(user, refresh) {
    const revoke = element("button", "button button-quiet button-danger", "Revoke");
    revoke.addEventListener("click", async () => {
      if (!window.confirm(`Revoke '${user.name}'? Clients using this token lose access immediately.`)) return;
      await request(`/api/gateway/users/${encodeURIComponent(user.name)}`, { method: "DELETE" });
      await refresh();
    });
    return revoke;
  }
  await fillList();
}

function revealToken(token, title) {
  const reveal = element("section", "card");
  reveal.append(
    element("h2", "", `${title} — shown once`),
    html("pre", "command", token),
    element("p", "note", "Copy it now: it cannot be shown again."),
  );
  els.view.append(reveal);
  window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
}

async function renderSources() {
  const card = element("section", "card");
  card.append(
    element("h2", "", "Shared sources"),
    element("p", "note", "The shared workspace's knowledge comes only from these sources: a git repository (pulled on refresh) or a directory on this server (read as-is). Each refresh reindexes into the shared workspace."),
  );
  const form = element("form", "row");
  const id = element("input", "", ""); id.placeholder = "source-id"; id.required = true;
  const kind = element("select", "", "");
  kind.innerHTML = '<option value="git">git repository</option><option value="dir">server directory</option>';
  const ref = element("input", "", ""); ref.placeholder = "https://git.example/kb.git or /srv/kb"; ref.required = true;
  const interval = element("input", "", ""); interval.type = "number"; interval.value = "600"; interval.min = "0";
  form.append(id, kind, ref, interval, element("button", "button button-primary", "Add source"));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await request("/api/gateway/sources", {
        method: "POST",
        body: JSON.stringify({ id: id.value, kind: kind.value, ref: ref.value, intervalSeconds: Number(interval.value) }),
      });
      await fill();
    } catch (error) {
      card.querySelector(".error")?.remove();
      card.append(element("p", "error", error.message));
    }
  });
  card.append(form);
  const list = element("div", "list");
  card.append(list);
  els.view.append(card);

  async function fill() {
    const { sources } = await request("/api/gateway/sources");
    list.replaceChildren(...(sources.length ? sources.map((source) => {
      const row = element("div", "row item columned");
      const line = element("div", "row");
      line.append(
        element("code", "", source.id),
        element("span", "pill", source.kind),
        html("span", "muted", source.kind === "git" ? `${source.ref} @ ${source.branch}` : source.ref),
        element("span", "muted", source.lastRefresh ? `refreshed ${new Date(source.lastRefresh).toLocaleString()}` : "never refreshed"),
      );
      const actions = element("div", "row");
      const refresh = element("button", "button button-quiet", "Refresh now");
      refresh.addEventListener("click", async () => {
        refresh.disabled = true;
        try {
          const job = await request(`/api/gateway/sources/${encodeURIComponent(source.id)}/refresh`, { method: "POST" });
          await pollJob(job.id, row);
        } finally {
          refresh.disabled = false;
        }
      });
      const remove = element("button", "button button-quiet button-danger", "Remove");
      remove.addEventListener("click", async () => {
        if (!window.confirm(`Remove source '${source.id}' from the pipeline?`)) return;
        await request(`/api/gateway/sources/${encodeURIComponent(source.id)}`, { method: "DELETE" });
        await fill();
      });
      actions.append(refresh, remove);
      row.append(line, actions);
      return row;
    }) : [element("p", "note", "No shared sources yet.")]));
  }
  await fill();
}

async function pollJob(jobId, mount) {
  for (let seen = ""; ; ) {
    const job = await request(`/api/gateway/jobs/${encodeURIComponent(jobId)}`);
    if (job.status === "succeeded" || job.status === "failed" || job.id !== seen) {
      mount.querySelector(".job-line")?.remove();
      mount.append(html("p", "job-line muted", `Last job: ${job.status}${job.error ? ` — ${job.error}` : job.result ? ` — uploaded ${job.result.uploaded}, removed ${job.result.removed}` : ""}`));
    }
    if (job.status !== "queued" && job.status !== "running") return;
    seen = job.id;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

/* ---------- helpers ---------- */

function stepBadge(n) {
  return element("span", "badge", `Step ${n} of 2`);
}

function metric(label, value) {
  const node = element("div", "metric");
  node.append(element("dt", "", label), element("dd", "", String(value)));
  return node;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function html(tag, className, markup) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.innerHTML = markup;
  return node;
}

function renderFatal(message) {
  els.headline.textContent = "Gateway";
  els.view.replaceChildren(element("p", "error", message));
}

async function request(path, { method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    ...(body !== undefined ? { body } : {}),
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `${path} returned ${response.status}`);
  return data;
}
