export function stripTrailingSlash(value) {
  return String(value ?? "").replace(/\/+$/, "");
}

export function joinUrl(baseUrl, pathname) {
  return `${stripTrailingSlash(baseUrl)}${pathname.startsWith("/") ? "" : "/"}${pathname}`;
}
