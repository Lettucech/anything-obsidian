const TOKEN_STORAGE_KEY = "any-obs-gateway-admin";

const els = {
  headline: document.querySelector("#headline"),
  status: document.querySelector("#status-line"),
  view: document.querySelector("#view"),
};

let adminToken = window.localStorage.getItem(TOKEN_STORAGE_KEY) || "";

boot();

async function boot() {
  const state = await request("/api/setup/state", { method: "GET", auth: false }).catch(() => null);
  if (!state) return renderFatal("The gateway is not reachable. Is the server stack running?");
  if (state.needsSetup) return renderWizard(state);
  return renderDashboard(state);
}

/* ---------- setup wizard ---------- */

function renderWizard(state) {
  els.headline.textContent = "Set up this gateway";
  let step = 1;
  const wizard = element("div", "wizard");

  const steps = [
    wizardAdminStep,
    wizardAnythingllmStep,
    wizardApiKeyStep,
  ];

  function render() {
    wizard.replaceChildren(steps[step - 1]());
  }

  function wizardAdminStep() {
    const card = element("section", "card");
    card.append(
      stepBadge(1),
      element("h2", "", "Create the gateway admin credential"),
      element("p", "note", "First prove you run this server: paste the one-time setup token printed to <code>docker compose logs gateway</code> (or the bootstrap token you configured). The admin token you get back is shown once — copy it."),
    );
    const form = element("form", "");
    const bootstrap = element("input", "", "");
    bootstrap.type = "password";
    bootstrap.placeholder = "One-time setup token (from the container log)";
    form.append(bootstrap);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const result = await request("/api/setup/admin-token", { method: "POST", auth: false, token: bootstrap.value.trim() });
        adminToken = result.adminToken;
        window.localStorage.setItem(TOKEN_STORAGE_KEY, adminToken);
        step = 2;
        render();
      } catch (error) {
        card.querySelector(".error")?.remove();
        card.append(element("p", "error", error.message));
      }
    });
    card.append(form);
    return card;
  }

  function wizardAnythingllmStep() {
    const card = element("section", "card");
    const tunnelCommand = `ssh -L 21501:127.0.0.1:21501 ${window.location.hostname}`;
    card.append(
      stepBadge(2),
      element("h2", "", "Initialize AnythingLLM, then mint its API key"),
      element("p", "note", "AnythingLLM's own UI is not on the network. Open it from the server itself, or tunnel once from your machine:"),
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
      html("p", "note", `Open <code>${state.anythingllmUiUrl}</code> on the server (or the tunnel on your machine), finish AnythingLLM's first-boot wizard, then go to <strong>Settings → Developer API</strong> and generate an API key.`),
    );
    const next = element("button", "button button-primary", "I have the API key");
    next.addEventListener("click", () => {
      step = 3;
      render();
    });
    card.append(next);
    return card;
  }

  function wizardApiKeyStep() {
    const card = element("section", "card");
    card.append(
      stepBadge(3),
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
        const result = await request("/api/setup/api-key", { method: "POST", body: JSON.stringify({ apiKey: input.value }) });
        window.location.reload();
        return result;
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
  if (!adminToken) return renderSignIn(state);
  renderTabs(state);
  await renderOverview(state);
}

function renderSignIn(state) {
  const card = element("section", "card");
  card.append(
    element("h2", "", "Sign in"),
    element("p", "note", "Paste the gateway admin token you created during setup."),
  );
  const form = element("form", "");
  const input = element("input", "", "");
  input.type = "password";
  input.placeholder = "Gateway admin token";
  form.append(input);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    adminToken = input.value.trim();
    window.localStorage.setItem(TOKEN_STORAGE_KEY, adminToken);
    renderDashboard(state);
  });
  card.append(form);
  els.view.replaceChildren(card);
}

function renderTabs(state) {
  const tabs = element("nav", "tabs");
  const views = [
    ["Overview", renderOverview],
    ["Users", renderUsers],
    ["Shared sources", renderSources],
  ];
  let current = "Overview";
  const buttons = new Map();
  for (const [label, render] of views) {
    const button = element("button", "tab", label);
    button.addEventListener("click", () => {
      current = label;
      for (const [other, node] of buttons) node.classList.toggle("active", other === label);
      render(state);
    });
    buttons.set(label, button);
    tabs.append(button);
  }
  buttons.get("Overview").classList.add("active");
  els.view.replaceChildren(tabs);
  renderTabs.refresh = (label, view) => {
    current = label;
    for (const [other, node] of buttons) node.classList.toggle("active", other === label);
    view(state);
  };
}

async function renderOverview(state) {
  const card = element("section", "card");
  card.append(element("h2", "", "Overview"));
  const grid = element("div", "grid");
  try {
    const health = await request("/health", { method: "GET", auth: false });
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
    html("p", "note", `<strong>Connect an any-obs client:</strong> <code>anything-obsidian init --url ${window.location.origin} --api-key &lt;user-token&gt;</code>`),
    html("p", "note", `<strong>Connect an agent (MCP):</strong> <code>${window.location.origin}/mcp</code> with a user token as Bearer.`),
    html("p", "note", `<strong>AnythingLLM UI</strong> stays off the network: open <code>${state.anythingllmUiUrl}</code> on the server, or <code>ssh -L 21501:127.0.0.1:21501 ${window.location.hostname}</code>.`),
  );
  els.status.textContent = "";
  els.view.querySelector(".card:last-of-type")?.remove();
  els.view.append(card);
}

async function renderUsers() {
  const card = element("section", "card");
  card.append(element("h2", "", "Users"));
  const form = element("form", "row");
  const name = element("input", "", "");
  name.placeholder = "user-name (lowercase-dash)";
  name.required = true;
  form.append(name, element("button", "button button-primary", "Create user"));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const created = await request("/api/gateway/users", { method: "POST", body: JSON.stringify({ name: name.value }) });
      name.value = "";
      const reveal = element("section", "card");
      reveal.append(
        element("h2", "", `Token for '${created.user.name}' — shown once`),
        html("pre", "command", created.token),
        element("p", "note", "Give it to the user for their any-obs client or MCP agent. It cannot be shown again."),
      );
      card.after(reveal);
      await fillList();
    } catch (error) {
      card.querySelector(".error")?.remove();
      card.append(element("p", "error", error.message));
    }
  });
  card.append(form);
  const list = element("div", "list");
  card.append(list);
  els.view.querySelector("nav.tabs").after(card);
  els.view.querySelector(".card:last-of-type")?.remove();
  els.view.append(card);

  async function fillList() {
    const { users } = await request("/api/gateway/users");
    list.replaceChildren(...(users.length ? users.map((user) => {
      const row = element("div", "row item");
      row.append(
        element("code", "", user.name),
        element("span", "muted", new Date(user.createdAt).toLocaleDateString()),
      );
      const revoke = element("button", "button button-quiet button-danger", "Revoke");
      revoke.addEventListener("click", async () => {
        if (!window.confirm(`Revoke '${user.name}'? Clients using this token lose access immediately.`)) return;
        await request(`/api/gateway/users/${encodeURIComponent(user.name)}`, { method: "DELETE" });
        await fillList();
      });
      row.append(revoke);
      return row;
    }) : [element("p", "note", "No users yet — create one for each person or agent.")]));
  }
  await fillList();
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
  els.view.querySelector("nav.tabs").after(card);

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
  return element("span", "badge", `Step ${n} of 3`);
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

async function request(path, { method = "GET", body, auth = true, token } = {}) {
  const bearer = token ?? (auth ? adminToken : "");
  const response = await fetch(path, {
    method,
    ...(body !== undefined ? { body } : {}),
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `${path} returned ${response.status}`);
  return data;
}
