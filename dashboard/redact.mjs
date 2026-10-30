const SECRET_KEYS = new Set(["ANYTHINGLLM_API_KEY", "GIT_PASSWORD", "MCP_AUTH_TOKEN", "lanToken"]);
const SECRET_KEY_PATTERN = "ANYTHINGLLM_API_KEY|GIT_PASSWORD|MCP_AUTH_TOKEN|lanToken";

export function redactSecretsText(value, secrets = []) {
  let text = String(value);
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join("[redacted]");
  return text
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/\bBearer\s+[^\s\"']+/gi, "Bearer [redacted]")
    .replace(
      new RegExp(`([\"'])(${SECRET_KEY_PATTERN})\\1(\\s*:\\s*)\\1(?:[^\\\\\"']|\\\\.)*\\1`, "g"),
      (_match, quote, key, separator) =>
        `${quote}${key}${quote}${separator}${quote}[redacted]${quote}`,
    )
    .replace(
      new RegExp(`\\b(${SECRET_KEY_PATTERN})(\\s*=\\s*|\\s*:\\s*)([^\\s\\r\\n,}\\]]+)`, "g"),
      "$1$2[redacted]",
    );
}

export function redactSecretsObject(value) {
  if (Array.isArray(value)) return value.map((item) => redactSecretsObject(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_KEYS.has(key) ? "[redacted]" : redactSecretsObject(item),
      ]),
    );
  }
  if (typeof value === "string") return redactSecretsText(value);
  return value;
}
