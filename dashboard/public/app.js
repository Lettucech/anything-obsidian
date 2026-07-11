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

export function actionDisabledReason(actionId, status) {
  if (status.latestJob && ["queued", "running"].includes(status.latestJob.status)) {
    return "Worker job running";
  }
  const anythingllm = status.services.find((service) => service.id === "anythingllm");
  if (ACTIONS_REQUIRING_ANYTHINGLLM.has(actionId) && !anythingllm?.running) {
    return "Turn system on first";
  }
  return "";
}

if (typeof document !== "undefined") {
  const state = { status: null, logsService: "syncer" };
  const els = {
    systemState: document.querySelector("#system-state"),
    power: document.querySelector("#power"),
    services: document.querySelector("#services"),
    actions: document.querySelector("#actions"),
    logs: document.querySelector("#logs"),
    config: document.querySelector("#config"),
    latestJob: document.querySelector("#latest-job"),
  };

  els.power.addEventListener("click", async () => {
    const endpoint = state.status.systemState === "on" ? "/api/system/off" : "/api/system/on";
    await fetch(endpoint, { method: "POST" });
    await refresh();
  });

  els.actions.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    await fetch(`/api/actions/${button.dataset.action}`, { method: "POST" });
    await refresh();
  });

  async function refresh() {
    state.status = await fetchJson("/api/status");
    renderStatus(state.status);
    const logs = await fetchJson(`/api/logs?service=${state.logsService}`);
    els.logs.textContent = logs.logs || "";
  }

  function renderStatus(status) {
    els.systemState.textContent = status.systemState;
    els.power.textContent = systemPowerLabel(status.systemState);
    els.services.innerHTML = status.services.map(renderService).join("");
    els.config.innerHTML = Object.entries(status.config)
      .map(([key, value]) => `<div><span>${escapeHtml(key)}</span><strong>${escapeHtml(value)}</strong></div>`)
      .join("");
    els.latestJob.textContent = status.latestJob
      ? `${status.latestJob.label || status.latestJob.actionId}: ${status.latestJob.status}`
      : "No dashboard worker job yet";
    for (const button of els.actions.querySelectorAll("button[data-action]")) {
      const reason = actionDisabledReason(button.dataset.action, status);
      button.disabled = Boolean(reason);
      button.title = reason;
    }
  }

  function renderService(service) {
    return `<article class="service ${serviceTone(service)}">
      <h2>${escapeHtml(service.label)}</h2>
      <p>${escapeHtml(service.status || service.state)}</p>
      <small>${escapeHtml(service.health?.ok ? "healthy" : service.health?.status || "not healthy")}</small>
    </article>`;
  }

  async function fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    return await response.json();
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[char]);
  }

  refresh();
  setInterval(refresh, 5000);
}
