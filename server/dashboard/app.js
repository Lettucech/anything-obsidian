const els = {
  headline: document.querySelector("#headline"),
  status: document.querySelector("#status-line"),
  view: document.querySelector("#view"),
};

let viewController = new AbortController();
boot();

async function boot() {
  const state = await request("/api/setup/state", { method: "GET" }).catch(() => null);
  if (!state)
    return renderFatal(
      "The gateway admin plane is not reachable. Are you on the server, or tunneled to it?",
    );
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
    const upstreamPort =
      new URL(state.anythingllmUiUrl).port ||
      (state.anythingllmUiUrl.startsWith("https:") ? "443" : "80");
    const tunnelCommand = `ssh -L ${state.adminPort}:127.0.0.1:${state.adminPort} -L ${upstreamPort}:127.0.0.1:${upstreamPort} ${state.serverHost}`;
    card.append(
      stepBadge(1),
      element("h2", "", "Initialize AnythingLLM, then mint its API key"),
      element(
        "p",
        "note",
        "Open your configured AnythingLLM instance and generate a developer API key. If it is bound to server loopback, use an SSH tunnel from your machine:",
      ),
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
      html(
        "p",
        "note",
        `Open <code>${state.anythingllmUiUrl}</code> (on the server, or through the tunnel), finish AnythingLLM's first-boot wizard, then go to <strong>Settings → Developer API</strong> and generate an API key.`,
      ),
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
      element(
        "p",
        "note",
        "Paste the developer API key. The gateway verifies it and becomes its only holder.",
      ),
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
        await request("/api/setup/api-key", {
          method: "POST",
          body: JSON.stringify({ apiKey: input.value }),
        });
        window.location.reload();
      } catch (error) {
        card.querySelector(".error")?.remove();
        card.append(element("p", "error", error.message));
      }
    });
    card.append(form);
    return card;
  }

  els.status.textContent = `AnythingLLM: ${state.anythingllmBaseUrl || "unknown"}`;
  els.view.replaceChildren(wizard);
  render();
}

/* ---------- dashboard ---------- */

async function renderDashboard(state) {
  els.headline.textContent = "any-obs gateway";
  // renderTabs already shows the initial tab (Overview); rendering it here
  // as well produced two identical cards on landing.
  renderTabs(state);
}

function renderTabs(state) {
  const tabs = element("nav", "tabs");
  const views = [
    ["Overview", renderOverview],
    ["Workspaces", renderWorkspaces],
    ["Users", renderUsers],
    ["Shared sources", renderSources],
    ["Operations", renderOperations],
    ["Settings", renderSettings],
  ];
  const buttons = new Map();
  // One switch point: clear everything under the tab bar, then let the
  // chosen tab append its own cards. Render functions only ever append —
  // without this they would stack below the previous tab's DOM.
  const show = (label) => {
    for (const [other, node] of buttons) node.classList.toggle("active", other === label);
    viewController.abort();
    viewController = new AbortController();
    const keep = tabs;
    els.view.replaceChildren(keep);
    const current = viewController;
    views
      .find(([name]) => name === label)[1](state)
      .catch((error) => {
        if (!current.signal.aborted) els.view.append(element("p", "error", error.message));
      });
  };
  for (const [label] of views) {
    const button = element("button", "tab", label);
    button.addEventListener("click", () => show(label));
    buttons.set(label, button);
    tabs.append(button);
  }
  buttons.get("Overview").classList.add("active");
  els.view.replaceChildren(tabs);
  show("Overview");
}

async function renderWorkspaces(state) {
  const card = element("section", "card");
  card.append(
    element("h2", "", "Workspaces"),
    element(
      "p",
      "note",
      "Nothing is pre-created. Shared workspaces carry a grants list — only granted users (plus the sources targeting them) feed and read them. Personal workspaces have one owner, minted by their any-obs client or pre-provisioned here.",
    ),
  );
  const { users } = await request("/api/gateway/users");
  const form = element("form", "row");
  const name = element("input", "", "");
  name.placeholder = "workspace name";
  name.required = true;
  const kind = element("select", "", "");
  kind.innerHTML =
    '<option value="shared">shared (grant users read)</option><option value="personal">personal (one owner)</option>';
  const owner = element("select", "", "");
  owner.innerHTML = users
    .map((user) => `<option value="${user.name}">${user.name}</option>`)
    .join("");
  form.append(name, kind, owner, element("button", "button button-primary", "Create workspace"));
  const syncKind = () => {
    owner.hidden = kind.value !== "personal";
  };
  kind.addEventListener("change", syncKind);
  syncKind();
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const created = await request("/api/gateway/workspaces", {
        method: "POST",
        body: JSON.stringify({
          name: name.value,
          kind: kind.value,
          ...(kind.value === "personal" ? { owner: owner.value } : {}),
        }),
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
    const { workspaces, untracked } = await request("/api/gateway/workspaces");
    list.replaceChildren(
      ...workspaces.map((workspace) => {
        const row = element("div", "row item columned");
        const line = element("div", "row");
        line.append(element("span", "pill", workspace.kind));
        line.append(element("code", "", workspace.slug));
        if (workspace.kind === "personal") {
          line.append(element("span", "muted", `owned by ${workspace.owner}`));
        }
        const remove = element("button", "button button-quiet button-danger", "Delete");
        remove.addEventListener("click", async () => {
          const who =
            workspace.kind === "personal"
              ? ` and '${workspace.owner}' loses it — their client must re-create the workspace before indexing works again`
              : "";
          if (
            !window.confirm(
              `Delete workspace '${workspace.slug}'? Its embeddings are removed from AnythingLLM${who}.`,
            )
          )
            return;
          await request(`/api/gateway/workspaces/${encodeURIComponent(workspace.slug)}`, {
            method: "DELETE",
          });
          await fill();
        });
        line.append(remove);
        row.append(line);
        if (workspace.kind === "shared") row.append(grantsLine(workspace));
        return row;
      }),
    );

    // Reverse scan: workspaces that exist in AnythingLLM but are not
    // tracked here (made outside the gateway, e.g. during setup). Adopt
    // them into the registry or delete them upstream.
    if (untracked?.length) {
      const section = element("div", "untracked");
      section.append(
        element("h2", "", "Untracked on AnythingLLM"),
        element(
          "p",
          "note",
          "These exist in AnythingLLM but the gateway has no record of them. Adopt (choose what they are) or delete.",
        ),
      );
      for (const workspace of untracked) {
        const row = element("div", "row item");
        row.append(
          element("span", "pill", "untracked"),
          element("code", "", workspace.slug),
          element("span", "muted", workspace.name),
        );
        const kind = element("select", "", "");
        kind.innerHTML =
          '<option value="shared">adopt as shared</option><option value="personal">adopt as personal</option>';
        const owner = element("select", "", "");
        owner.hidden = true;
        owner.innerHTML = users
          .map((user) => `<option value="${user.name}">${user.name}</option>`)
          .join("");
        kind.addEventListener("change", () => {
          owner.hidden = kind.value !== "personal";
        });
        const adopt = element("button", "button button-primary", "Adopt");
        adopt.addEventListener("click", async () => {
          try {
            await request("/api/gateway/workspaces/adopt", {
              method: "POST",
              body: JSON.stringify({
                slug: workspace.slug,
                kind: kind.value,
                ...(kind.value === "personal" ? { owner: owner.value } : {}),
              }),
            });
            await fill();
          } catch (error) {
            window.alert(error.message);
          }
        });
        const remove = element("button", "button button-quiet button-danger", "Delete");
        remove.addEventListener("click", async () => {
          if (
            !window.confirm(
              `Delete '${workspace.slug}' from AnythingLLM? Its embeddings go with it.`,
            )
          )
            return;
          await request(`/api/gateway/workspaces/${encodeURIComponent(workspace.slug)}`, {
            method: "DELETE",
          });
          await fill();
        });
        row.append(kind, owner, adopt, remove);
        section.append(row);
      }
      list.append(section);
    }
  }

  function grantsLine(workspace) {
    const line = element("div", "row workspace-line");
    line.append(element("span", "muted", "read grants:"));
    const grants = workspace.grants ?? [];
    if (!grants.length)
      line.append(
        element("span", "muted", "nobody yet — sources can still feed it, but no user can read it"),
      );
    for (const name of grants) {
      const chip = element("span", "pill", name);
      const revoke = element("button", "button button-quiet button-danger", "×");
      revoke.title = `Revoke ${name}`;
      revoke.addEventListener("click", async () => {
        await request(
          `/api/gateway/workspaces/${encodeURIComponent(workspace.slug)}/grants/${encodeURIComponent(name)}`,
          { method: "DELETE" },
        );
        await fill();
      });
      chip.append(revoke);
      line.append(chip);
    }
    const select = element("select", "", "");
    select.innerHTML =
      '<option value="">grant a user…</option>' +
      users
        .filter((user) => !grants.includes(user.name))
        .map((user) => `<option value="${user.name}">${user.name}</option>`)
        .join("");
    const grant = element("button", "button button-quiet", "Grant");
    grant.disabled = !select.value;
    select.addEventListener("change", () => {
      grant.disabled = !select.value;
    });
    grant.addEventListener("click", async () => {
      if (!select.value) return;
      await request(`/api/gateway/workspaces/${encodeURIComponent(workspace.slug)}/grants`, {
        method: "POST",
        body: JSON.stringify({ user: select.value }),
      });
      await fill();
    });
    line.append(select, grant);
    return line;
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
      metric("Users", health.users),
      metric("Gateway version", health.version),
    );
  } catch (error) {
    card.append(element("p", "error", error.message));
  }
  card.append(grid);
  card.append(
    html(
      "p",
      "note",
      `<strong>Connect an any-obs client:</strong> <code>anything-obsidian setup --url ${state.publicUrl} --api-key &lt;user-token&gt;</code>`,
    ),
    html(
      "p",
      "note",
      `<strong>Connect an agent (MCP):</strong> <code>${state.publicUrl}/mcp</code> with a user token as Bearer.`,
    ),
    html(
      "p",
      "note",
      `<strong>Configured AnythingLLM:</strong> <code>${state.anythingllmUiUrl}</code>. If bound to server loopback, forward its configured port over SSH.`,
    ),
  );
  els.status.textContent = "";
  els.view.append(card);
}

async function renderSettings(state) {
  const card = element("section", "card");
  card.append(element("h2", "", "Settings"));
  const info = element("div", "grid");
  const status = element("span", "muted", "Checking connection…");
  card.append(info, status);

  const settings = await request("/api/gateway/settings");
  info.replaceChildren(
    metric("AnythingLLM", settings.anythingllmBaseUrl || "not configured"),
    metric("API key", settings.keyPreview || "not set"),
    metric("Connection", settings.connected ? "OK" : "failing"),
  );
  status.textContent = settings.connected
    ? ""
    : "The configured key is not answering — update it below.";

  const form = element("form", "row");
  const input = element("input", "", "");
  input.type = "password";
  input.placeholder = "New AnythingLLM developer API key";
  input.required = true;
  const submit = element("button", "button button-primary", "Update key");
  form.append(input, submit);
  const note = element(
    "p",
    "note",
    "The replacement key is verified, saved, and used by both gateway interfaces and subsequent jobs immediately.",
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await request("/api/gateway/settings/api-key", {
        method: "POST",
        body: JSON.stringify({ apiKey: input.value }),
      });
      input.value = "";
      card.querySelector(".error")?.remove();
      status.textContent = "Key updated.";
      info.replaceChildren(metric("Connection", "OK"));
    } catch (error) {
      card.querySelector(".error")?.remove();
      card.append(element("p", "error", error.message));
    }
  });
  card.append(form, note);
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
  role.innerHTML = ["reader", "member", "admin"]
    .map(
      (value) =>
        `<option value="${value}"${value === "reader" ? " selected" : ""}>${value}</option>`,
    )
    .join("");
  const roleHelp = element(
    "span",
    "muted",
    "reader (default): search only · member: shared + own workspaces · admin: also manages the gateway with this token",
  );
  form.append(name, role, element("button", "button button-primary", "Create user"), roleHelp);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const created = await request("/api/gateway/users", {
        method: "POST",
        body: JSON.stringify({ name: name.value, role: role.value }),
      });
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
    list.replaceChildren(
      ...(users.length
        ? users.map((user) => {
            const row = element("div", "row item columned");
            const line = element("div", "row");
            line.append(
              element("code", "", user.name),
              roleSelect(user),
              element("span", "muted", new Date(user.createdAt).toLocaleDateString()),
            );
            const reset = element("button", "button button-quiet", "Reset token");
            reset.addEventListener("click", async () => {
              if (
                !window.confirm(
                  `Reset the token for '${user.name}'? Their old token stops working immediately.`,
                )
              )
                return;
              const result = await request(
                `/api/gateway/users/${encodeURIComponent(user.name)}/reset-token`,
                { method: "POST" },
              );
              revealToken(result.token, `New token for '${user.name}' (${result.user.role})`);
            });
            line.append(reset, revokeButton(user, fillList));
            row.append(line);
            for (const slug of user.workspaces ?? []) {
              const workspaceLine = element("div", "row workspace-line");
              workspaceLine.append(element("span", "pill", "workspace"), element("code", "", slug));
              const remove = element("button", "button button-quiet button-danger", "Delete");
              remove.addEventListener("click", async () => {
                if (
                  !window.confirm(
                    `Delete workspace '${slug}'? Its embeddings are removed from AnythingLLM and '${user.name}' loses it — their client must re-create the workspace before indexing works again.`,
                  )
                )
                  return;
                await request(`/api/gateway/workspaces/${encodeURIComponent(slug)}`, {
                  method: "DELETE",
                });
                await fillList();
              });
              workspaceLine.append(remove);
              row.append(workspaceLine);
            }
            return row;
          })
        : [
            element(
              "p",
              "note",
              "No users yet — create one for each person or agent (they start as readers; promote when you trust them).",
            ),
          ]),
    );
  }

  function roleSelect(user) {
    const select = element("select", "", "");
    select.innerHTML = ["member", "admin", "reader"]
      .map(
        (value) =>
          `<option value="${value}"${value === user.role ? " selected" : ""}>${value}</option>`,
      )
      .join("");
    select.addEventListener("change", async () => {
      try {
        await request(`/api/gateway/users/${encodeURIComponent(user.name)}`, {
          method: "PATCH",
          body: JSON.stringify({ role: select.value }),
        });
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
      if (
        !window.confirm(`Revoke '${user.name}'? Clients using this token lose access immediately.`)
      )
        return;
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
    element("pre", "command", token),
    element("p", "note", "Copy it now: it cannot be shown again."),
  );
  els.view.append(reveal);
  window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
}

async function renderSources() {
  const signal = viewController.signal;
  const card = element("section", "card");
  card.append(
    element("h2", "", "Shared sources"),
    element(
      "p",
      "note",
      "Knowledge enters the shared workspaces only through these sources: a git repository (pulled on refresh) or a directory on this server (read as-is). Each source targets one workspace — create it in the Workspaces tab first.",
    ),
  );
  const form = element("form", "row");
  const id = element("input", "", "");
  id.placeholder = "source-id";
  id.required = true;
  const kind = element("select", "", "");
  kind.innerHTML =
    '<option value="git">git repository</option><option value="dir">server directory</option>';
  const ref = element("input", "", "");
  ref.placeholder = "https://git.example/kb.git or /srv/kb";
  ref.required = true;
  const target = element("select", "", "");
  target.required = true;
  const { workspaces } = await request("/api/gateway/workspaces");
  if (signal.aborted) return;
  const sharedOnes = workspaces.filter((workspace) => workspace.kind === "shared");
  target.innerHTML = sharedOnes.length
    ? sharedOnes
        .map((workspace) => `<option value="${workspace.slug}">${workspace.slug}</option>`)
        .join("")
    : '<option value="">(no shared workspaces — create one first)</option>';
  if (!sharedOnes.length) target.disabled = true;
  const branch = element("input", "", "");
  branch.value = "main";
  branch.setAttribute("aria-label", "Git branch");
  const interval = element("input", "", "");
  interval.type = "number";
  interval.value = "600";
  interval.min = "0";
  interval.setAttribute("aria-label", "Refresh interval in seconds (0 disables scheduling)");
  form.append(
    id,
    kind,
    ref,
    target,
    branch,
    interval,
    element("button", "button button-primary", "Add source"),
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await request("/api/gateway/sources", {
        method: "POST",
        body: JSON.stringify({
          id: id.value,
          kind: kind.value,
          ref: ref.value,
          workspace: target.value,
          branch: branch.value,
          intervalSeconds: Number(interval.value),
        }),
      });
      await fill();
    } catch (error) {
      card.querySelector(".error")?.remove();
      card.append(element("p", "error", error.message));
    }
  });
  for (const [input, label] of [
    [id, "Source ID"],
    [kind, "Source kind"],
    [ref, "Repository URL or server directory"],
    [target, "Target shared workspace"],
  ])
    input.setAttribute("aria-label", label);
  card.append(form);
  const warning = element("p", "error");
  warning.setAttribute("role", "status");
  card.append(warning);
  const rows = new Map();
  const list = element("div", "list");
  card.append(list);
  els.view.append(card);

  async function fill() {
    const [{ sources }, { jobs }] = await Promise.all([
      request("/api/gateway/sources"),
      request("/api/gateway/jobs"),
    ]);
    if (signal.aborted) return;
    const ids = new Set(sources.map((source) => source.id));
    for (const [id, record] of rows)
      if (!ids.has(id)) {
        record.node.remove();
        rows.delete(id);
      }
    list.querySelector(".empty-sources")?.remove();
    if (!sources.length) list.append(element("p", "note empty-sources", "No shared sources yet."));
    for (const source of sources) {
      let record = rows.get(source.id);
      if (!record) {
        const node = element("div", "item");
        const line = element("p", "note");
        const summary = element("p", "job-line muted");
        const actions = element("div", "row");
        const refresh = element("button", "button button-quiet", "Refresh changed");
        const rebuild = element("button", "button button-quiet", "Rebuild all");
        const remove = element("button", "button button-quiet button-danger", "Remove");
        const queue = async (action, force = false) => {
          refresh.disabled = rebuild.disabled = remove.disabled = true;
          try {
            await request(
              `/api/gateway/sources/${encodeURIComponent(source.id)}${action === "refresh" ? "/refresh" : ""}`,
              {
                method: action === "refresh" ? "POST" : "DELETE",
                ...(force ? { body: JSON.stringify({ force: true }) } : {}),
              },
            );
            warning.textContent = "";
          } catch (error) {
            if (!signal.aborted) warning.textContent = error.message;
          }
          if (!signal.aborted) await fill();
        };
        refresh.addEventListener("click", () => queue("refresh"));
        rebuild.addEventListener("click", () => {
          if (
            window.confirm(
              `Re-upload and verify every file in '${source.id}'? This can take time and incur embedding costs.`,
            )
          )
            queue("refresh", true);
        });
        remove.addEventListener("click", () => {
          if (
            window.confirm(
              `Remove source '${source.id}' and its derived index? Source files are kept.`,
            )
          )
            queue("remove");
        });
        actions.append(refresh, rebuild, remove);
        node.append(line, summary, actions);
        list.append(node);
        record = { node, line, summary, refresh, rebuild, remove };
        rows.set(source.id, record);
      }
      const job = jobs.find((job) => job.sourceId === source.id);
      const active = ["queued", "running"].includes(job?.status);
      record.line.textContent = `${source.id} · ${source.kind} · ${source.ref}${source.kind === "git" ? ` @ ${source.branch}` : ""} → ${source.workspace} · ${source.lastRefresh ? `verified ${new Date(source.lastRefresh).toLocaleString()}` : "never refreshed"}`;
      record.summary.textContent = job ? jobSummary(job).textContent : "";
      record.summary.className = `job-line ${job?.status === "failed" ? "error" : "muted"}`;
      record.refresh.disabled = record.rebuild.disabled = active || source.cleanupPending;
      record.remove.disabled = active;
      record.remove.textContent = source.cleanupPending ? "Retry cleanup" : "Remove";
    }
  }
  await fill();
  while (!signal.aborted && card.isConnected) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if (signal.aborted || !card.isConnected) return;
    try {
      await fill();
    } catch (error) {
      if (!signal.aborted)
        warning.textContent = `Unable to refresh source status: ${error.message}`;
    }
  }
}

function jobSummary(job) {
  const progress = job.progress?.total
    ? ` · ${job.progress.completed ?? 0}/${job.progress.total}`
    : "";
  return element(
    "p",
    `job-line ${job.status === "failed" ? "error" : "muted"}`,
    `${job.action === "remove" ? "Cleanup" : job.force ? "Rebuild" : "Refresh"}: ${job.status} · ${job.phase || job.status}${progress}${job.error ? ` — ${job.error}` : ""}`,
  );
}

async function renderOperations() {
  const signal = viewController.signal;
  const card = element("section", "card");
  card.append(
    element("h2", "", "Jobs and logs"),
    element(
      "p",
      "note",
      "Work is recorded before it is accepted. Interrupted jobs remain visible after a restart and can be retried.",
    ),
  );
  const warning = element("p", "error");
  warning.setAttribute("role", "status");
  const list = element("div", "list");
  const heading = element("h2", "", "Gateway log");
  const logs = element("pre", "log-output");
  logs.setAttribute("aria-label", "Gateway log");
  card.append(warning, list, heading, logs);
  els.view.append(card);
  const records = new Map();
  const empty = element("p", "note", "No jobs yet. Add a shared source and refresh it to begin.");
  list.append(empty);
  while (!signal.aborted && card.isConnected) {
    try {
      const [history, output, registry] = await Promise.all([
        request("/api/gateway/jobs"),
        request("/api/gateway/logs"),
        request("/api/gateway/sources"),
      ]);
      if (signal.aborted) return;
      warning.textContent = "";
      logs.textContent = output.logs || "No gateway log output yet.";
      empty.hidden = history.jobs.length > 0;
      const ids = new Set(history.jobs.map((job) => job.id));
      for (const [id, record] of records)
        if (!ids.has(id)) {
          record.node.remove();
          records.delete(id);
        }
      for (const job of [...history.jobs].reverse()) {
        let record = records.get(job.id);
        if (!record) {
          const node = element("article", "item");
          const summary = element("p", "job-line");
          const timing = element("p", "muted");
          const result = element("p", "note");
          const details = element("details", "");
          const output = element("pre", "log-output");
          details.append(element("summary", "", "Job log"), output);
          const action = element("button", "button button-quiet");
          record = { node, summary, timing, result, output, action, job };
          records.set(job.id, record);
          action.addEventListener("click", async () => {
            action.disabled = true;
            try {
              await request(
                `/api/gateway/jobs/${encodeURIComponent(job.id)}/${["queued", "running"].includes(record.job.status) ? "cancel" : "retry"}`,
                { method: "POST" },
              );
            } catch (error) {
              if (!signal.aborted) warning.textContent = error.message;
            }
          });
          node.append(
            element("strong", "", job.sourceId),
            summary,
            timing,
            result,
            details,
            action,
          );
          list.prepend(node);
        }
        record.job = job;
        const latest = history.jobs.find((current) => current.sourceId === job.sourceId);
        const resolved = latest?.id !== job.id && latest?.status === "succeeded";
        record.summary.textContent =
          jobSummary(job).textContent +
          (job.status === "failed" && resolved ? " · Resolved by a later successful job" : "");
        record.summary.className = `job-line ${job.status === "failed" ? "error" : "muted"}`;
        record.timing.textContent = `Queued ${new Date(job.createdAt).toLocaleString()}${job.finishedAt ? ` · Finished ${new Date(job.finishedAt).toLocaleString()}` : ""}`;
        record.result.textContent = !job.result
          ? ""
          : job.action === "remove"
            ? "Derived index removed. Source files kept."
            : `Uploaded ${job.result.uploaded ?? 0} · Removed ${job.result.removed ?? 0} · Repaired ${job.result.repaired ?? 0} · ${job.result.verified ? "Verified" : "Completed"}`;
        record.output.textContent = job.logs || "No job output yet.";
        const active = ["queued", "running"].includes(job.status);
        record.action.textContent = active ? "Cancel" : "Retry";
        record.action.hidden = !(
          active ||
          (latest?.id === job.id &&
            ["failed", "cancelled"].includes(job.status) &&
            registry.sources.some((source) => source.id === job.sourceId))
        );
        record.action.disabled = false;
      }
    } catch (error) {
      if (!signal.aborted)
        warning.textContent = `Connection unavailable: ${error.message}. Reconnecting…`;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
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
    headers: { "Content-Type": "application/json" },
    signal: viewController.signal,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `${path} returned ${response.status}`);
  return data;
}
