const SECRET_KEYS = new Set(["ANYTHINGLLM_API_KEY", "KB_GIT_AUTH_TOKEN", "GIT_PASSWORD"]);

export function redactSecretsText(value) {
  return String(value).replace(
    /\b(ANYTHINGLLM_API_KEY|KB_GIT_AUTH_TOKEN|GIT_PASSWORD)=([^\s\r\n]*)/g,
    "$1=[redacted]",
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
