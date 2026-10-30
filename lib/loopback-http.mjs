// Loopback reach grants native clients access; browser origins and DNS rebinding
// must not turn an unrelated website into a local administrator.
export function assertLoopbackRequest(req) {
  const headers = req.headers || {};
  const host = headers.host;
  const fail = (message) => {
    throw Object.assign(new Error(message), { statusCode: 403 });
  };
  if (host) {
    let hostname;
    try {
      hostname = new URL(`http://${host}`).hostname;
    } catch {
      fail("Invalid Host header");
    }
    if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname))
      fail("Admin requests must use a loopback host");
  }
  if (headers.origin) {
    let origin;
    try {
      origin = new URL(headers.origin);
    } catch {
      fail("Invalid browser origin");
    }
    if (origin.host !== host || !["http:", "https:"].includes(origin.protocol))
      fail("Cross-origin administration is not allowed");
  }
  if (
    ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
    headers["content-type"] &&
    !/^application\/json(?:;|$)/i.test(headers["content-type"])
  ) {
    fail("Admin mutations require application/json");
  }
}
