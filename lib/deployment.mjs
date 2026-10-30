export const isContainer = (env = process.env) => env.AO_CONTAINER === "1";

export function deploymentCapabilities(env = process.env) {
  const container = isContainer(env);
  return {
    flavor: container ? "docker" : "native",
    localImport: !container,
    lifecycle: container ? "docker" : "native",
  };
}

export function assertLocalImport(env = process.env) {
  if (isContainer(env))
    throw Object.assign(
      new Error("Local directory import is unavailable in Docker. Clone a Git repository instead."),
      { statusCode: 403 },
    );
}

export function assertRemoteRepository(ref, env = process.env) {
  if (!isContainer(env)) return;
  let url;
  try {
    url = new URL(ref);
  } catch {}
  if (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password)
    throw Object.assign(
      new Error("Docker sources require an HTTP(S) Git URL without embedded credentials."),
      { statusCode: 400 },
    );
}
