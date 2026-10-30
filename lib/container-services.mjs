import { request } from "node:http";
import path from "node:path";

export const containerSocketPath = (root) => path.join(root, "run", "container.sock");
export function createContainerController({ root }) {
  const call = (method, pathname) =>
    new Promise((resolve, reject) => {
      const req = request(
        { socketPath: containerSocketPath(root), path: pathname, method, timeout: 5000 },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            try {
              const data = JSON.parse(body);
              res.statusCode >= 400 ? reject(new Error(data.error)) : resolve(data);
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.once("timeout", () => req.destroy(new Error("Container runtime timed out")));
      req.once("error", () =>
        reject(new Error("Container runtime unavailable. Use docker compose up -d.")),
      );
      req.end();
    });
  const managed = () => {
    throw Object.assign(
      new Error(
        "Docker manages service lifecycle and restart policy. Use docker compose up -d, stop, restart, or logs; rebuild the image to update.",
      ),
      { statusCode: 409 },
    );
  };
  return {
    status: () => call("GET", "/status"),
    startService: (role) => call("POST", `/services/${encodeURIComponent(role)}/start`),
    stopService: (role) => call("POST", `/services/${encodeURIComponent(role)}/stop`),
    start: managed,
    stop: managed,
    restart: managed,
    restartRole: managed,
    setAutostart: managed,
    setLan: managed,
  };
}
