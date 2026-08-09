const SENSITIVE_KEY =
  /^(authorization|token|access_token|refresh_token|client_secret|code|code_verifier|content|markdown|query|text)$/i;
const TOKEN_VALUE = /\b(?:Bearer\s+)?(?:ntn_|secret_)[A-Za-z0-9._~-]+\b/gi;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/gi;

export function redactString(value: string): string {
  return value.replace(TOKEN_VALUE, "[REDACTED]").replace(BEARER_VALUE, "Bearer [REDACTED]");
}

export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((entry) => redact(entry, seen));

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(entry, seen);
  }
  return result;
}
