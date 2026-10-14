const DEFAULT_ALLOWED_HOSTS = ["localhost", "127.0.0.1"];

export function mcpHttpOptions(allowedHostsText, { host = "127.0.0.1" } = {}) {
  return {
    host,
    allowedHosts: allowedHostsText
      ? [...new Set([...DEFAULT_ALLOWED_HOSTS, ...allowedHostsText.split(",").map((entry) => entry.trim()).filter(Boolean)])]
      : DEFAULT_ALLOWED_HOSTS,
  };
}
