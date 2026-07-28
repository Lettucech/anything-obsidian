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
  const state = { status: null, vaults: [], editingId: null };
  const els = Object.fromEntries([
    "system-state", "power", "services", "vaults", "add-vault", "vault-form-panel", "vault-form",
    "vault-form-title", "cancel-vault", "vault-message", "latest-job", "logs", "vault-source",
    "source-mode-field", "clone-url-field", "import-help", "workspace-slug-field", "allowlist-field", "vault-submit",
  ].map((id) => [id.replaceAll("-", ""), document.querySelector(`#${id}`)]));

  els.power.addEventListener("click", async () => {
    await request(state.status.systemState === "on" ? "/api/system/off" : "/api/system/on", { method: "POST" });
    await refresh();
  });
  els.addvault.addEventListener("click", () => showForm());
  els.cancelvault.addEventListener("click", hideForm);
  els.vaults.addEventListener("click", handleVaultAction);
  els.vaultform.addEventListener("submit", saveVault);
  els.vaultform.addEventListener("change", syncFormControls);

  async function handleVaultAction(event) {
    const button = event.target.closest("button[data-vault-id]");
    if (!button) return;
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
    const form = new FormData(els.vaultform);
    const input = formInput(form);
    try {
      if (state.editingId) {
        delete input.id; delete input.directory; delete input.sourceMode; delete input.repositoryUrl;
        delete input.workspaceMode; delete input.workspaceSlug;
        const saved = await request(`/api/vaults/${encodeURIComponent(state.editingId)}`, { method: "PATCH", body: JSON.stringify(input) });
        hideForm();
        message(`Vault '${saved.id}' saved.`);
      } else {
        const saved = await request("/api/vaults", { method: "POST", body: JSON.stringify(input) });
        hideForm();
        message(`Vault '${saved.id}' added.`);
      }
      await refresh();
    } catch (error) {
      message(error.message, true);
    }
  }

  function formInput(form) {
    return {
      sourceMode: form.get("sourceMode"), repositoryUrl: form.get("repositoryUrl"),
      id: form.get("id"), name: form.get("name"), directory: form.get("directory"),
      workspaceMode: form.get("workspaceMode"), workspaceSlug: form.get("workspaceSlug"),
      gitAutoPull: form.get("gitAutoPull") === "on", gitAutoPush: form.get("gitAutoPush") === "on",
      gitUserName: form.get("gitUserName"), gitUserEmail: form.get("gitUserEmail"),
      gitPushUrl: form.get("gitPushUrl"), gitCommitMessagePrefix: form.get("gitCommitMessagePrefix"),
      gitAuthMode: form.get("gitAuthMode"),
      gitAuth: { mode: form.get("gitAuthMode"), username: form.get("gitAuthUsername"), token: form.get("gitAuthToken") },
      syncIntervalSeconds: Number(form.get("syncIntervalSeconds")), enabled: form.get("enabled") === "on",
      embedAfterSync: form.get("embedAfterSync") === "on", embedExtensions: form.get("embedExtensions"),
      embedExcludeDirs: form.get("embedExcludeDirs"),
      accessMode: form.get("accessMode"), allowlist: String(form.get("allowlist") || "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
    };
  }

  function showForm(vault) {
    state.editingId = vault?.id || null;
    els.vaultform.reset();
    if (vault) Object.entries(vault).forEach(([key, value]) => {
      const field = els.vaultform.elements.namedItem(key);
      if (!field) return;
      if (field.type === "checkbox") field.checked = Boolean(value);
      else field.value = Array.isArray(value) ? value.join("\n") : value;
    });
    for (const name of ["id", "directory", "workspaceMode", "workspaceSlug"]) {
      const field = els.vaultform.elements.namedItem(name); if (field) field.disabled = Boolean(vault);
    }
    els.vaultformtitle.textContent = vault ? `Edit ${vault.name}` : "Add vault";
    syncFormControls();
    els.vaultformpanel.hidden = false;
  }

  function syncFormControls() {
    const form = els.vaultform;
    const editing = Boolean(state.editingId);
    const sourceMode = form.elements.sourceMode.value;
    const isClone = sourceMode === "clone";
    const privateHttps = form.elements.gitAuthMode.value === "https-token";
    const attachWorkspace = form.elements.workspaceMode.value === "attach";
    const restricted = form.elements.accessMode.value === "restricted";

    els.vaultsource.hidden = false;
    els.sourcemodefield.hidden = editing;
    els.cloneurlfield.hidden = editing || !isClone;
    els.importhelp.hidden = editing || isClone;
    form.elements.repositoryUrl.required = !editing && isClone;
    for (const field of form.querySelectorAll(".clone-auth-field")) field.hidden = !privateHttps;
    els.workspaceslugfield.hidden = !attachWorkspace || editing;
    form.elements.workspaceSlug.required = attachWorkspace && !editing;
    els.allowlistfield.hidden = !restricted;
    for (const name of ["name", "id", "directory"]) form.elements[name].required = !editing && !isClone;
    form.querySelector(".advanced-settings").open = !editing && !isClone;
    els.vaultsubmit.textContent = editing ? "Save vault" : isClone ? "Clone and add vault" : "Import vault";
  }

  function hideForm() { state.editingId = null; els.vaultformpanel.hidden = true; }
  function message(text, error = false) { els.vaultmessage.textContent = text; els.vaultmessage.className = error ? "message error" : "message"; }

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
    els.power.textContent = systemPowerLabel(state.status.systemState);
    els.services.replaceChildren(...state.status.services.map(renderService));
    els.vaults.replaceChildren(...(state.vaults.length ? state.vaults.map(renderVault) : [emptyState()]));
    const latest = state.status.latestJob;
    els.latestjob.textContent = latest ? `${latest.vaultId}: ${latest.label} — ${latest.status}` : "No dashboard worker job yet";
  }

  function renderService(service) {
    const article = element("article", `service ${serviceTone(service)}`);
    article.append(element("h3", "", service.label), element("p", "", service.status || service.state), element("small", "", service.health?.ok ? "healthy" : service.health?.status || "not healthy"));
    return article;
  }

  function renderVault(vault) {
    const card = element("article", "vault-card");
    card.append(element("h3", "", vault.name), element("p", "vault-meta", `id: ${vault.id} · workspace: ${vault.workspaceSlug}`), element("p", "vault-meta", `${vault.gitRemote}/${vault.gitBranch} · every ${vault.syncIntervalSeconds}s · ${vault.enabled ? "enabled" : "paused"}`));
    if (vault.accessMode === "restricted") card.append(element("p", "note", "Restricted policy is not enforced yet."));
    const actions = element("div", "vault-actions");
    ["sync", "embed", "embed-all", "doctor", "edit", "remove"].forEach((action) => {
      const button = element("button", "", actionLabel(action));
      button.dataset.vaultId = vault.id; button.dataset.action = action;
      const reason = ["edit", "remove"].includes(action) ? "" : actionDisabledReason(action, state.status, vault.id);
      button.disabled = Boolean(reason); button.title = reason;
      actions.append(button);
    });
    card.append(actions);
    return card;
  }

  function emptyState() {
    const card = element("article", "empty-state");
    card.append(element("h3", "", "Clone your first vault"), element("p", "", "Add a repository URL and let the dashboard clone and manage it beneath the configured vault root."));
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
