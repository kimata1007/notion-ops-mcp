export type ErrorCode =
  | "auth_required"
  | "rate_limited"
  | "timeout"
  | "cancelled"
  | "upstream_incompatible"
  | "not_found"
  | "ambiguous"
  | "conflict"
  | "failed";

export class OpsError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      retryAfterMs?: number;
      details?: Readonly<Record<string, unknown>>;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "OpsError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    if (options.details !== undefined) this.details = options.details;
  }
}

export function isOpsError(error: unknown): error is OpsError {
  return error instanceof OpsError;
}
