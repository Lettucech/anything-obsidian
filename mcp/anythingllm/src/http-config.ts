const DEFAULT_ALLOWED_HOSTS = ["localhost", "127.0.0.1", "mcp", "anything-obsidian-mcp"];

export function mcpHttpOptions(allowedHostsText?: string) {
  return {
    host: "0.0.0.0",
    allowedHosts: allowedHostsText
      ? [...new Set([...DEFAULT_ALLOWED_HOSTS, ...allowedHostsText.split(",").map((host) => host.trim()).filter(Boolean)])]
      : DEFAULT_ALLOWED_HOSTS,
  };
}
