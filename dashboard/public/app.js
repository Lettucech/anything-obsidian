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

export function vaultSourcePayload(form, sourceMode) {
  const importing = sourceMode === "import";
  const importPath = String(importing ? form.get("importPath") || "" : "").trim();
  return {
    sourceMode: importing ? "import" : "clone",
    repositoryUrl: importing ? "" : form.get("repositoryUrl"),
    id: importing ? form.get("importId") : form.get("id"),
    // A path means "a folder the user owns"; otherwise the directory name
    // lives beneath the vault root and anyobs manages its location.
    directory: importing && importPath ? "" : importing ? form.get("importDirectory") : form.get("directory"),
    importPath,
  };
}

export function activeTheme(savedTheme, prefersDark = false) {
  if (["light", "dark"].includes(savedTheme)) return savedTheme;
  return prefersDark ? "dark" : "light";
}

export function nextTheme(theme) {
  return theme === "dark" ? "light" : "dark";
}

export function lastSyncLabel(lastSync, now = Date.now()) {
  if (!lastSync) return "Never synced";
  const finished = Date.parse(lastSync.finishedAt);
  if (Number.isNaN(finished)) return "Synced";
  const seconds = Math.max(0, Math.round((now - finished) / 1000));
  const ago = seconds < 60 ? `${seconds}s ago`
    : seconds < 3600 ? `${Math.round(seconds / 60)}m ago`
    : seconds < 86400 ? `${Math.round(seconds / 3600)}h ago`
    : `${Math.round(seconds / 86400)}d ago`;
  return lastSync.status === "failed" ? `Sync failed ${ago}` : `Synced ${ago}`;
}

export function jobProgressLabel(job) {
  if (!job || !["queued", "running"].includes(job.status) || !job.logs) return "";
  const matches = [...job.logs.matchAll(/Embedding progress: (\d+)\/(\d+)/g)];
  const latest = matches.at(-1);
  return latest ? ` (${latest[1]}/${latest[2]})` : "";
}

export function failedSyncs(vaults) {
  return vaults.filter((vault) => vault.lastSync?.status === "failed");
}

export function syncBanner(failed) {
  if (!failed.length) return "";
  const names = failed.map((vault) => vault.id).join(", ");
  return `Sync failed for: ${names}. Check the logs below or run Sync now.`;
}

export function dashboardMetrics(status, vaults) {
  const services = status.services ?? [];
  return [
    { label: "Managed vaults", value: vaults.length },
    { label: "RAG workspace", value: status.workspace?.slug || "Not set up yet" },
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

export function restrictedAccessNote(allowlist = []) {
  const names = (allowlist ?? []).filter(Boolean);
  return names.length
    ? `Restricted: only allowlisted MCP agents (${names.join(", ")}) can read this vault.`
    : "Restricted: no agent is allowlisted, so MCP callers cannot read this vault.";
}

export function agentCreatedLabel(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString();
}

export function agentRevokeMessage(name, referencedBy = []) {
  if (!referencedBy.length) return `Agent '${name}' revoked.`;
  return `Agent '${name}' revoked. These vault allowlists still name it: ${referencedBy.join(", ")}`;
}

export function breadcrumbSegments(rootPath, currentPath, rootLabel = "Vault root") {
  const crumbs = [{ name: rootLabel, path: rootPath }];
  if (!currentPath || currentPath === rootPath) return crumbs;
  const relative = currentPath.startsWith(`${rootPath}/`) ? currentPath.slice(rootPath.length + 1) : currentPath;
  let accumulated = rootPath;
  for (const segment of relative.split("/")) {
    accumulated = `${accumulated}/${segment}`;
    crumbs.push({ name: segment, path: accumulated });
  }
  return crumbs;
}

// Breadcrumbs for a path outside the vault root: walk from the filesystem
// root so every level is navigable.
export function absoluteCrumbs(currentPath) {
  const crumbs = [{ name: "/", path: "/" }];
  const segments = String(currentPath ?? "").split("/").filter(Boolean);
  let accumulated = "";
  for (const segment of segments) {
    accumulated = `${accumulated}/${segment}`;
    crumbs.push({ name: segment, path: accumulated });
  }
  return crumbs;
}

export function useFolderBlockedReason(tree) {
  if (!tree) return "Open a folder to import it";
  if (tree.canUseHere) return "";
  return tree.path === tree.root
    ? "The vault root itself cannot be imported"
    : "That folder cannot be imported";
}

export function slugifyName(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

if (typeof document !== "undefined") {
  const state = { status: null, vaults: [], agents: [], editingId: null, createdVaultId: null, createdAgentName: null, browse: { open: false, path: "", tree: null } };
  const els = Object.fromEntries([
    "system-state", "power", "services", "vaults", "add-vault", "vault-dialog", "vault-form", "sync-banner", "update-badge", "lan-dialog", "lan-token-value", "lan-done",
    "vault-form-title", "cancel-vault", "vault-message", "latest-job", "logs", "vault-source",
    "source-mode-field", "import-help", "import-id-field", "import-directory-field", "import-path-field",
    "clone-url-field", "allowlist-field", "vault-submit", "test-vault-connection", "private-auth-fields", "edit-settings", "add-vault-note", "vault-dialog-message",
    "add-vault-inline", "vault-summary", "service-summary", "theme-toggle", "theme-label", "theme-icon",
    "agents", "agent-message", "add-agent", "agent-dialog", "agent-form", "agent-form-title",
    "agent-create-fields", "agent-token-reveal", "agent-token-value", "agent-submit", "cancel-agent", "agent-dialog-message",
    "import-browse", "import-browse-toggle", "import-tree-panel", "import-breadcrumb", "import-tree", "import-tree-note", "import-use-folder", "import-refresh-tree", "import-path-jump", "import-jump",
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
  els.vaultform.elements.importPath?.addEventListener("input", syncFormControls);
  els.vaultdialog.addEventListener("close", () => { state.editingId = null; state.createdVaultId = null; });
  els.addagent.addEventListener("click", showAgentForm);
  els.cancelagent.addEventListener("click", hideAgentForm);
  els.agents.addEventListener("click", handleAgentAction);
  els.agentform.addEventListener("submit", createAgent);
  els.agentdialog.addEventListener("close", () => { state.createdAgentName = null; });
  els.importbrowsetoggle.addEventListener("click", toggleImportBrowse);
  els.importrefreshtree.addEventListener("click", () => loadImportTree(state.browse.path));
  els.importjumptree.addEventListener("click", () => jumpToPath());
  els.importpathjump.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      jumpToPath();
    }
  });
  els.importtree.addEventListener("click", handleBrowseNavigation);
  els.importbreadcrumb.addEventListener("click", handleBrowseNavigation);
  els.importusefolder.addEventListener("click", useSelectedFolder);
  els.updatebadge.addEventListener("click", () => {
    message(`Version ${state.status.update?.latest} is available. Update in a terminal with: anything-obsidian update`);
  });
  els.services.addEventListener("click", handleLanToggle);
  els.landone.addEventListener("click", () => els.landialog.close());

  async function handleVaultAction(event) {
    const button = event.target.closest("button[data-vault-id], button[data-dashboard-action]");
    if (!button) return;
    if (button.dataset.dashboardAction === "add-vault") return showForm();
    const { vaultId, action } = button.dataset;
    if (action === "edit") return showForm(state.vaults.find((vault) => vault.id === vaultId));
    if (action === "remove") {
      if (!window.confirm(`Remove '${vaultId}' from management? Its repository and files stay on disk; its indexed chunks leave the shared RAG workspace.`)) return;
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
        delete input.repositoryVisibility;
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
      ...vaultSourcePayload(form, form.get("sourceMode")),
      repositoryVisibility: form.get("repositoryVisibility"),
      name: form.get("name"),
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
    state.browse = { open: false, path: "", tree: null };
    els.vaultform.reset();
    if (vault) Object.entries(vault).forEach(([key, value]) => {
      const field = els.vaultform.elements.namedItem(key);
      if (!field) return;
      if (field.type === "checkbox") field.checked = Boolean(value);
      else field.value = Array.isArray(value) ? value.join("\n") : value;
    });
    if (vault) els.vaultform.elements.repositoryVisibility.value = vault.gitAuthMode === "https-token" ? "private" : "public";
    for (const name of ["id", "directory", "importPath", "importDirectory"]) {
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
    const importMode = !editing && form.elements.sourceMode.value === "import";
    const privateRepository = form.elements.repositoryVisibility.value === "private";
    const restricted = form.elements.accessMode.value === "restricted";

    els.vaultsource.hidden = false;
    els.editsettings.hidden = !editing;
    els.addvaultnote.hidden = editing;
    els.sourcemodefield.hidden = editing;
    form.elements.sourceMode.disabled = editing;
    els.importhelp.hidden = !importMode;
    els.importidfield.hidden = !importMode;
    // The path field is always available in import mode: any folder the user
    // owns, anywhere on disk. While it holds a value it replaces the
    // directory field (an imported vault is never managed beneath the root).
    const importedPath = String(form.elements.importPath?.value || "").trim();
    const asImport = importMode && Boolean(importedPath);
    els.importpathfield.hidden = !importMode;
    els.importdirectoryfield.hidden = importMode && Boolean(importedPath);
    form.elements.importId.required = importMode;
    form.elements.importDirectory.required = importMode && !asImport;
    els.importbrowse.hidden = editing || !importMode;
    if (els.importbrowse.hidden) closeImportBrowse();
    els.cloneurlfield.hidden = editing || importMode;
    form.elements.repositoryUrl.required = !editing && !importMode;
    els.privateauthfields.hidden = !privateRepository;
    for (const name of ["gitAuthUsername", "gitAuthToken"]) form.elements[name].required = !editing && privateRepository;
    els.allowlistfield.hidden = !restricted;
    els.vaultsubmit.textContent = editing ? "Save vault" : importMode ? "Import and add vault" : "Clone and add vault";
    els.vaultsubmit.hidden = completed;
    els.testvaultconnection.hidden = editing || completed || importMode;
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

  async function toggleImportBrowse() {
    if (state.browse.open) {
      closeImportBrowse();
      return;
    }
    state.browse.open = true;
    els.importtreepanel.hidden = false;
    els.importbrowsetoggle.textContent = "Hide browser";
    await loadImportTree(state.browse.path);
  }

  function closeImportBrowse() {
    state.browse.open = false;
    if (els.importtreepanel) els.importtreepanel.hidden = true;
    if (els.importbrowsetoggle) els.importbrowsetoggle.textContent = "Browse vault root…";
  }

  async function loadImportTree(browsePath) {
    setBrowseNote("Loading folders…");
    try {
      const tree = await fetchJson(`/api/import-tree${browsePath ? `?path=${encodeURIComponent(browsePath)}` : ""}`);
      state.browse.path = tree.path;
      state.browse.tree = tree;
      renderImportTree(tree);
    } catch (error) {
      setBrowseNote(error.message, true);
    }
  }

  function renderImportTree(tree) {
    const crumbs = tree.insideRoot
      ? breadcrumbSegments(tree.root, tree.path)
      : absoluteCrumbs(tree.path);
    els.importbreadcrumb.replaceChildren(...crumbs.map((crumb) => {
      const crumbButton = element("button", "crumb", crumb.name);
      crumbButton.type = "button";
      crumbButton.dataset.browsePath = crumb.path;
      if (crumb.path === tree.path) crumbButton.classList.add("current");
      return crumbButton;
    }));
    els.importpathjump.value = tree.path;
    const items = tree.directories.map((entry) => {
      const item = element("li", "");
      const button = element("button", "tree-item", entry.name);
      button.type = "button";
      button.dataset.browsePath = entry.path;
      item.append(button);
      return item;
    });
    els.importtree.replaceChildren(...(items.length ? items : [element("li", "tree-empty", "No subdirectories here.")]));
    els.importusefolder.disabled = Boolean(useFolderBlockedReason(tree));
    els.importusefolder.title = useFolderBlockedReason(tree);
    setBrowseNote(useFolderBlockedReason(tree) || (tree.importMode === "managed"
      ? `Importing '${tree.name}' as a managed vault beneath the vault root.`
      : `Importing '${tree.path}' as a folder you own; anyobs records the path and leaves auto-sync off.`));
  }

  function setBrowseNote(text, error = false) {
    els.importtreenote.textContent = text;
    els.importtreenote.className = error ? "browse-note error" : "browse-note";
  }

  async function handleBrowseNavigation(event) {
    const button = event.target.closest("button[data-browse-path]");
    if (!button) return;
    await loadImportTree(button.dataset.browsePath);
  }

  function jumpToPath() {
    const target = String(els.importpathjump.value || "").trim();
    if (target) loadImportTree(target);
  }

  function useSelectedFolder() {
    const tree = state.browse.tree;
    if (!tree || useFolderBlockedReason(tree)) return;
    const form = els.vaultform;
    const managed = tree.importMode === "managed";
    if (managed) {
      form.elements.importDirectory.value = tree.name;
      form.elements.importPath.value = "";
    } else {
      form.elements.importPath.value = tree.path;
      form.elements.importDirectory.value = "";
      if (!form.elements.importId.value) form.elements.importId.value = slugifyName(tree.name);
    }
    if (!form.elements.importId.value) form.elements.importId.value = tree.name;
    closeImportBrowse();
    syncFormControls();
    setDialogMessage(managed
      ? `Directory set to '${tree.name}' (managed beneath the vault root).`
      : `Folder set to '${tree.path}' (yours — auto-sync stays off).`);
  }

  async function refresh() {
    try {
      [state.status, { vaults: state.vaults }, { agents: state.agents }] = await Promise.all([
        fetchJson("/api/status"), fetchJson("/api/vaults"), fetchJson("/api/agents"),
      ]);
      render();
      const logs = await fetchJson("/api/logs?service=syncer");
      els.logs.textContent = logs.logs || "";
    } catch (error) { message(error.message, true); }
  }

  function render() {
    const update = state.status.update;
    els.updatebadge.hidden = !(update && update.available);
    const failed = failedSyncs(state.vaults);
    const banner = syncBanner(failed);
    els.syncbanner.textContent = banner;
    els.syncbanner.hidden = !banner;
    els.systemstate.textContent = state.status.systemState;
    els.systemstate.className = `system-status ${state.status.systemState}`;
    els.power.textContent = systemPowerLabel(state.status.systemState);
    els.power.classList.toggle("is-on", state.status.systemState === "on");
    els.services.replaceChildren(...state.status.services.map(renderService));
    els.vaults.replaceChildren(...(state.vaults.length ? state.vaults.map(renderVault) : [emptyState()]));
    els.agents.replaceChildren(...(state.agents.length ? state.agents.map(renderAgent) : [element("p", "note", "No agent tokens yet. Create one, then name it in a vault's access policy allowlist.")]));
    els.vaultsummary.replaceChildren(...dashboardMetrics(state.status, state.vaults).map(renderMetric));
    const healthy = state.status.services.filter((service) => service.running && service.health?.ok).length;
    const total = state.status.services.length;
    els.servicesummary.textContent = `${healthy}/${total} healthy`;
    els.servicesummary.className = `section-status ${healthy === total ? "ok" : "warn"}`;
    const latest = state.status.latestJob;
    els.latestjob.textContent = latest
      ? `${latest.vaultId}: ${latest.label} — ${latest.status}${jobProgressLabel(latest)}`
      : "No dashboard worker job yet";
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
    if (service.id === "mcp-lan") {
      const actions = element("div", "vault-actions");
      const toggle = element("button", "button button-quiet", state.status.lan?.enabled ? "Turn LAN off" : "Turn LAN on");
      toggle.dataset.lanToggle = state.status.lan?.enabled ? "off" : "on";
      actions.append(toggle);
      article.append(actions);
    }
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
    details.append(vaultDetail("Repository", `${vault.gitRemote}/${vault.gitBranch}`), vaultDetail("Sync", `Every ${vault.syncIntervalSeconds}s`), vaultDetail("Last sync", lastSyncLabel(vault.lastSync)));
    if (vault.lastSync?.status === "failed") card.classList.add("sync-failed");
    card.append(header, details);
    if (vault.accessMode === "restricted") card.append(element("p", "note", restrictedAccessNote(vault.allowlist)));
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

  function renderAgent(agent) {
    const card = element("article", "agent-card");
    const identity = element("div", "agent-identity");
    identity.append(element("h3", "", agent.name), element("p", "agent-created", agentCreatedLabel(agent.createdAt)));
    const actions = element("div", "agent-actions");
    const revoke = element("button", "button button-quiet button-danger", "Revoke");
    revoke.dataset.agentName = agent.name;
    revoke.dataset.agentAction = "revoke";
    actions.append(revoke);
    card.append(identity, actions);
    return card;
  }

  async function handleLanToggle(event) {
    const button = event.target.closest("button[data-lan-toggle]");
    if (!button) return;
    const action = button.dataset.lanToggle;
    if (action === "on" && !window.confirm("Enable the LAN RAG endpoint on port 21504? A Bearer token will be required for remote clients.")) return;
    try {
      const result = await request("/api/lan", { method: "POST", body: JSON.stringify({ action }) });
      if (result.token) {
        els.lantokenvalue.textContent = result.token;
        els.landialog.showModal();
      }
      await refresh();
    } catch (error) { message(error.message, true); }
  }

  async function handleAgentAction(event) {
    const button = event.target.closest("button[data-agent-name]");
    if (!button) return;
    const { agentName } = button.dataset;
    if (!window.confirm(`Revoke agent token '${agentName}'? Clients using it lose MCP access immediately.`)) return;
    try {
      const result = await request(`/api/agents/${encodeURIComponent(agentName)}`, { method: "DELETE" });
      agentMessage(agentRevokeMessage(agentName, result.referencedBy));
    } catch (error) {
      agentMessage(error.message, true);
    }
    await refresh();
  }

  async function createAgent(event) {
    event.preventDefault();
    const form = new FormData(els.agentform);
    setAgentDialogMessage("Creating agent token…");
    els.agentsubmit.disabled = true;
    try {
      const created = await request("/api/agents", { method: "POST", body: JSON.stringify({ name: form.get("name") }) });
      state.createdAgentName = created.agent.name;
      els.agentformtitle.textContent = `Agent '${created.agent.name}' created`;
      els.agentcreatefields.hidden = true;
      els.agenttokenreveal.hidden = false;
      els.agenttokenvalue.textContent = created.token;
      els.agentsubmit.hidden = true;
      els.cancelagent.textContent = "Done";
      setAgentDialogMessage("");
      await refresh();
    } catch (error) {
      setAgentDialogMessage(error.message, true);
    } finally {
      els.agentsubmit.disabled = false;
    }
  }

  function showAgentForm() {
    state.createdAgentName = null;
    els.agentform.reset();
    els.agentformtitle.textContent = "Add agent";
    els.agentcreatefields.hidden = false;
    els.agenttokenreveal.hidden = true;
    els.agenttokenvalue.textContent = "";
    els.agentsubmit.hidden = false;
    els.cancelagent.textContent = "Cancel";
    setAgentDialogMessage("");
    els.agentdialog.showModal();
  }

  function hideAgentForm() { state.createdAgentName = null; els.agentdialog.close(); }
  function agentMessage(text, error = false) { els.agentmessage.textContent = text; els.agentmessage.className = error ? "message error" : "message"; }
  function setAgentDialogMessage(text, error = false) { els.agentdialogmessage.textContent = text; els.agentdialogmessage.className = error ? "message dialog-message error" : "message dialog-message"; }

  function emptyState() {
    const card = element("article", "empty-state");
    const copy = element("div", "");
    copy.append(element("h3", "", "Bring your first vault online"), element("p", "", "Clone or import a Git repository beneath the configured vault root and let the dashboard synchronize and index it."));
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
