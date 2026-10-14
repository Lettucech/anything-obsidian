import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function createNotifier({ env = process.env, platform = process.platform, execFileImpl = execFileAsync, logger = console } = {}) {
  const enabled = env.AO_NOTIFY !== "0";

  return {
    async notify(title, body) {
      if (!enabled) return false;
      try {
        if (platform === "darwin") {
          await execFileImpl("osascript", ["-e", `display notification ${quote(body)} with title ${quote(title)}`]);
          return true;
        }
        if (platform === "linux") {
          await execFileImpl("notify-send", [title, body]);
          return true;
        }
        return false;
      } catch (error) {
        // Notifications are best-effort; a missing helper or a session
        // without a notification center must never break a sync.
        logger.error?.(`notification failed: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    },
  };
}

function quote(value) {
  return JSON.stringify(String(value));
}
