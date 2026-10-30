import { readFileSync } from "node:fs";
// In-memory service controller used by HTTP handler tests. Never runs OS commands.
export function fakeServices({ running = false, pid = 4242, autostart = false, lan = false } = {}) {
  const calls = [];
  return {
    calls,
    async startService(name) {
      calls.push(`start:${name}`);
      running = true;
    },
    async stopService(name) {
      calls.push(`stop:${name}`);
      running = false;
    },
    async setAutostart(value) {
      calls.push(`autostart:${value}`);
      autostart = value;
    },
    async setLan(value) {
      calls.push(`lan:${value}`);
      lan = value;
    },
    async status() {
      return {
        roles: ["client"],
        lan,
        services: { scheduler: { running, pid: running ? pid : null } },
        autostart: { enabled: autostart, guarantee: autostart ? "after-login" : "disabled" },
      };
    },
  };
}

export function readSchedulerStatus({ pidPath, killImpl }) {
  try {
    const pid = Number(readFileSync(pidPath, "utf8").trim());
    killImpl(pid, 0);
    return { running: true, pid };
  } catch {
    return { running: false, pid: null };
  }
}
