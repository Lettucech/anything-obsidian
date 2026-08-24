const ACTIONS_REQUIRING_ANYTHINGLLM = new Set(["sync", "embed", "embed-all"]);

export function systemPowerLabel(state) {
  if (state === "on") return "Turn Off";
  if (state === "partial") return "Repair";
  return "Turn On";
}

export function serviceTone(service) {
  if (!service.running) return "off";
  return service.health?.ok ? "ok" : "warn";
}

export function vaultActionUrl(vaultId, actionId) {
  return `/api/vaults/${encodeURIComponent(vaultId)}/actions/${encodeURIComponent(actionId)}`;
}

export function gitAuthForRepository(repositoryVisibility, username, token) {
  if (repositoryVisibility !== "private") return { mode: "none" };
  return { mode: "https-token", username: String(username ?? "").trim(), token: String(token ?? "") };
}

export function activeTheme(savedTheme, prefersDark = false) {
  if (["light", "dark"].includes(savedTheme)) return savedTheme;
  return prefersDark ? "dark" : "light";
}

export function nextTheme(theme) {
  return theme === "dark" ? "light" : "dark";
}

export function dashboardMetrics(status, vaults) {
  const services = status.services ?? [];
  return [
    { label: "Managed vaults", value: vaults.length },
    { label: "Scheduled sync", value: vaults.filter((vault) => vault.enabled).length },
    { label: "Healthy services", value: `${services.filter((service) => service.running && service.health?.ok).length}/${services.length}` },
  ];
}

export function actionDisabledReason(actionId, status, vaultId) {
  const jobs = status.jobs ?? (status.latestJob ? [status.latestJob] : []);
  if (jobs.some((job) => job.vaultId === vaultId && ["queued", "running"].includes(job.status))) {
    return "Worker job running";
  }
  const anythingllm = status.services.find((service) => service.id === "anythingllm");
  if (ACTIONS_REQUIRING_ANYTHINGLLM.has(actionId) && !anythingllm?.running) return "Turn system on first";
  return "";
}

if (typeof document !== "undefined") {
  const state = { status: null, vaults: [], editingId: null, createdVaultId: null };
  const els = Object.fromEntries([
    "system-state", "power", "services", "vaults", "add-vault", "vault-dialog", "vault-form",
    "vault-form-title", "cancel-vault", "vault-message", "latest-job", "logs", "vault-source",
    "clone-url-field", "workspace-slug-field", "allowlist-field", "vault-submit", "test-vault-connection", "private-auth-fields", "edit-settings", "add-vault-note", "vault-dialog-message",
    "add-vault-inline", "vault-summary", "service-summary", "theme-toggle", "theme-label", "theme-icon",
  ].map((id) => [id.replaceAll("-", ""), document.querySelector(`#${id}`)]));

  const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
  let theme = activeTheme(window.localStorage.getItem("anything-obsidian-theme"), themeMedia.matches);
  applyTheme(theme);

  els.power.addEventListener("click", async () => {
    await request(state.status.systemState === "on" ? "/api/system/off" : "/api/system/on", { method: "POST" });
    await refresh();
  });
  els.addvault.addEventListener("click", () => showForm());
  els.addvaultinline.addEventListener("click", () => showForm());
  els.themetoggle.addEventListener("click", () => {
    theme = nextTheme(theme);
    window.localStorage.setItem("anything-obsidian-theme", theme);
    applyTheme(theme);
  });
  els.cancelvault.addEventListener("click", hideForm);
  els.vaults.addEventListener("click", handleVaultAction);
  els.vaultform.addEventListener("submit", saveVault);
  els.testvaultconnection.addEventListener("click", testVaultConnection);
  els.vaultform.addEventListener("change", syncFormControls);
  els.vaultdialog.addEventListener("close", () => { state.editingId = null; state.createdVaultId = null; });

  async function handleVaultAction(event) {
    const button = event.target.closest("button[data-vault-id], button[data-dashboard-action]");
    if (!button) return;
    if (button.dataset.dashboardAction === "add-vault") return showForm();
    const { vaultId, action } = button.dataset;
    if (action === "edit") return showForm(state.vaults.find((vault) => vault.id === vaultId));
    if (action === "remove") {
      if (!window.confirm(`Remove '${vaultId}' from management? Its repository and workspace will remain.`)) return;
      await request(`/api/vaults/${encodeURIComponent(vaultId)}`, { method: "DELETE" });
      message(`Removed '${vaultId}' from management.`);
    } else {
      await request(vaultActionUrl(vaultId, action), { method: "POST" });
      message(`${button.textContent} started for '${vaultId}'.`);
    }
    await refresh();
  }

  async function saveVault(event) {
    event.preventDefault();
    const editing = Boolean(state.editingId);
    const form = new FormData(els.vaultform);
    const input = formInput(form);
    setDialogMessage(editing ? "Saving vault…" : "Checking connection and adding vault…");
    setVaultFormBusy(true);
    try {
      if (editing) {
        delete input.id; delete input.directory; delete input.sourceMode; delete input.repositoryUrl;
        delete input.repositoryVisibility; delete input.workspaceMode; delete input.workspaceSlug;
        if (!input.gitAuth.token) delete input.gitAuth;
        const saved = await request(`/api/vaults/${encodeURIComponent(state.editingId)}`, { method: "PATCH", body: JSON.stringify(input) });
        hideForm();
        message(`Vault '${saved.id}' saved.`);
      } else {
        const saved = await request("/api/vaults", { method: "POST", body: JSON.stringify(input) });
        state.createdVaultId = saved.id;
        setDialogMessage(`Vault '${saved.id}' added.`);
      }
      await refresh();
      if (!editing) syncFormControls();
    } catch (error) {
      setDialogMessage(error.message, true);
    } finally {
      setVaultFormBusy(false);
    }
  }

  async function testVaultConnection() {
    const form = els.vaultform;
    const repositoryUrl = form.elements.repositoryUrl;
    const privateRepository = form.elements.repositoryVisibility.value === "private";
    const credentialFields = [form.elements.gitAuthUsername, form.elements.gitAuthToken];
    if (!repositoryUrl.reportValidity() || (privateRepository && credentialFields.some((field) => !field.reportValidity()))) return;
    const input = formInput(new FormData(form));
    setDialogMessage("Testing Git and AnythingLLM connection…");
    setVaultFormBusy(true);
    try {
      await request("/api/vaults/test-connection", {
        method: "POST",
        body: JSON.stringify({
          repositoryUrl: input.repositoryUrl,
          repositoryVisibility: input.repositoryVisibility,
          gitAuth: input.gitAuth,
        }),
      });
      setDialogMessage("Connection verified. Ready to add this vault.");
    } catch (error) {
      setDialogMessage(error.message, true);
    } finally {
      setVaultFormBusy(false);
    }
  }

  function formInput(form) {
    return {
      sourceMode: "clone", repositoryUrl: form.get("repositoryUrl"),
      repositoryVisibility: form.get("repositoryVisibility"),
      id: form.get("id"), name: form.get("name"), directory: form.get("directory"),
      workspaceMode: form.get("workspaceMode"), workspaceSlug: form.get("workspaceSlug"),
      gitAutoPull: form.get("gitAutoPull") === "on", gitAutoPush: form.get("gitAutoPush") === "on",
      gitUserName: form.get("gitUserName"), gitUserEmail: form.get("gitUserEmail"),
      gitPushUrl: form.get("gitPushUrl"), gitCommitMessagePrefix: form.get("gitCommitMessagePrefix"),
      gitAuth: gitAuthForRepository(form.get("repositoryVisibility"), form.get("gitAuthUsername"), form.get("gitAuthToken")),
      syncIntervalSeconds: Number(form.get("syncIntervalSeconds")), enabled: form.get("enabled") === "on",
      embedAfterSync: form.get("embedAfterSync") === "on", embedExtensions: form.get("embedExtensions"),
      embedExcludeDirs: form.get("embedExcludeDirs"),
      accessMode: form.get("accessMode"), allowlist: String(form.get("allowlist") || "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
    };
  }

  function showForm(vault) {
    state.editingId = vault?.id || null;
    state.createdVaultId = null;
    els.vaultform.reset();
    if (vault) Object.entries(vault).forEach(([key, value]) => {
      const field = els.vaultform.elements.namedItem(key);
      if (!field) return;
      if (field.type === "checkbox") field.checked = Boolean(value);
      else field.value = Array.isArray(value) ? value.join("\n") : value;
    });
    if (vault) els.vaultform.elements.repositoryVisibility.value = vault.gitAuthMode === "https-token" ? "private" : "public";
    for (const name of ["id", "directory", "workspaceMode", "workspaceSlug"]) {
      const field = els.vaultform.elements.namedItem(name); if (field) field.disabled = Boolean(vault);
    }
    els.vaultformtitle.textContent = vault ? `Edit ${vault.name}` : "Add vault";
    setDialogMessage("");
    syncFormControls();
    els.vaultdialog.showModal();
  }

  function syncFormControls() {
    const form = els.vaultform;
    const editing = Boolean(state.editingId);
    const completed = Boolean(state.createdVaultId);
    const privateRepository = form.elements.repositoryVisibility.value === "private";
    const attachWorkspace = form.elements.workspaceMode.value === "attach";
    const restricted = form.elements.accessMode.value === "restricted";

    els.vaultsource.hidden = false;
    els.editsettings.hidden = !editing;
    els.addvaultnote.hidden = editing;
    els.cloneurlfield.hidden = editing;
    form.elements.repositoryUrl.required = !editing;
    els.privateauthfields.hidden = !privateRepository;
    for (const name of ["gitAuthUsername", "gitAuthToken"]) form.elements[name].required = !editing && privateRepository;
    els.workspaceslugfield.hidden = !attachWorkspace || editing;
    form.elements.workspaceSlug.required = attachWorkspace && !editing;
    els.allowlistfield.hidden = !restricted;
    els.vaultsubmit.textContent = editing ? "Save vault" : "Clone and add vault";
    els.vaultsubmit.hidden = completed;
    els.testvaultconnection.hidden = editing || completed;
    els.cancelvault.textContent = completed ? "Done" : "Cancel";
  }

  function applyTheme(next) {
    document.documentElement.dataset.theme = next;
    document.querySelector('meta[name="theme-color"]').content = next === "dark" ? "#111a2b" : "#f6f7ff";
    const switchingTo = nextTheme(next);
    els.themelabel.textContent = switchingTo === "dark" ? "Dark mode" : "Light mode";
    els.themeicon.textContent = switchingTo === "dark" ? "◐" : "☼";
    els.themetoggle.setAttribute("aria-label", `Switch to ${switchingTo} theme`);
    els.themetoggle.title = `Switch to ${switchingTo} theme`;
  }

  function hideForm() { state.editingId = null; state.createdVaultId = null; els.vaultdialog.close(); }
  function message(text, error = false) { els.vaultmessage.textContent = text; els.vaultmessage.className = error ? "message error" : "message"; }
  function setDialogMessage(text, error = false) { els.vaultdialogmessage.textContent = text; els.vaultdialogmessage.className = error ? "message dialog-message error" : "message dialog-message"; }
  function setVaultFormBusy(busy) {
    const completed = Boolean(state.createdVaultId);
    els.vaultsubmit.disabled = busy || completed;
    els.testvaultconnection.disabled = busy || completed;
  }

  async function refresh() {
    try {
      [state.status, { vaults: state.vaults }] = await Promise.all([fetchJson("/api/status"), fetchJson("/api/vaults")]);
      render();
      const logs = await fetchJson("/api/logs?service=syncer");
      els.logs.textContent = logs.logs || "";
    } catch (error) { message(error.message, true); }
  }

  function render() {
    els.systemstate.textContent = state.status.systemState;
    els.systemstate.className = `system-status ${state.status.systemState}`;
    els.power.textContent = systemPowerLabel(state.status.systemState);
    els.power.classList.toggle("is-on", state.status.systemState === "on");
    els.services.replaceChildren(...state.status.services.map(renderService));
    els.vaults.replaceChildren(...(state.vaults.length ? state.vaults.map(renderVault) : [emptyState()]));
    els.vaultsummary.replaceChildren(...dashboardMetrics(state.status, state.vaults).map(renderMetric));
    const healthy = state.status.services.filter((service) => service.running && service.health?.ok).length;
    const total = state.status.services.length;
    els.servicesummary.textContent = `${healthy}/${total} healthy`;
    els.servicesummary.className = `section-status ${healthy === total ? "ok" : "warn"}`;
    const latest = state.status.latestJob;
    els.latestjob.textContent = latest ? `${latest.vaultId}: ${latest.label} — ${latest.status}` : "No dashboard worker job yet";
  }

  function renderMetric(metric) {
    const item = element("div", "metric");
    item.append(element("dt", "", metric.label), element("dd", "", metric.value));
    return item;
  }

  function renderService(service) {
    const article = element("article", `service ${serviceTone(service)}`);
    const topline = element("div", "service-topline");
    topline.append(element("h3", "", service.label), element("span", "service-status", service.health?.ok ? "Healthy" : service.health?.status || "Needs attention"));
    article.append(topline, element("p", "", service.status || service.state));
    return article;
  }

  function renderVault(vault) {
    const card = element("article", "vault-card");
    const header = element("div", "vault-card-header");
    const identity = element("div", "vault-identity");
    identity.append(element("h3", "", vault.name), element("p", "vault-id", vault.id));
    const pills = element("div", "vault-pills");
    pills.append(element("span", `vault-pill ${vault.enabled ? "enabled" : "paused"}`, vault.enabled ? "Scheduled" : "Paused"));
    if (vault.gitAuthMode === "https-token") pills.append(element("span", "vault-pill private", "Private"));
    header.append(identity, pills);
    const details = element("dl", "vault-details");
    details.append(vaultDetail("Repository", `${vault.gitRemote}/${vault.gitBranch}`), vaultDetail("Workspace", vault.workspaceSlug), vaultDetail("Sync", `Every ${vault.syncIntervalSeconds}s`));
    card.append(header, details);
    if (vault.accessMode === "restricted") card.append(element("p", "note", "Restricted policy is not enforced yet."));
    const actions = element("div", "vault-actions");
    ["sync", "embed", "embed-all", "doctor", "edit", "remove"].forEach((action) => {
      const button = element("button", action === "sync" ? "button button-primary" : action === "remove" ? "button button-quiet button-danger" : "button button-quiet", actionLabel(action));
      button.dataset.vaultId = vault.id; button.dataset.action = action;
      const reason = ["edit", "remove"].includes(action) ? "" : actionDisabledReason(action, state.status, vault.id);
      button.disabled = Boolean(reason); button.title = reason;
      actions.append(button);
    });
    card.append(actions);
    return card;
  }

  function vaultDetail(label, value) {
    const item = element("div", "");
    item.append(element("dt", "", label), element("dd", "", value));
    return item;
  }

  function emptyState() {
    const card = element("article", "empty-state");
    const copy = element("div", "");
    copy.append(element("h3", "", "Bring your first vault online"), element("p", "", "Connect a Git repository and let the dashboard clone, synchronize, and index it beneath the configured vault root."));
    const button = element("button", "button button-primary", "Add your first vault");
    button.dataset.dashboardAction = "add-vault";
    card.append(copy, button);
    return card;
  }

  async function fetchJson(url) { return request(url); }
  async function request(url, init = {}) {
    const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init.headers || {}) } });
    const body = response.status === 204 ? {} : await response.json();
    if (!response.ok) throw new Error(body.error || `${url} returned ${response.status}`);
    return body;
  }
  function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
  function actionLabel(action) { return ({ sync: "Sync now", embed: "Embed changed", "embed-all": "Rebuild index", doctor: "Run doctor", edit: "Edit", remove: "Remove" })[action]; }

  refresh();
  setInterval(refresh, 5_000);
}
