import {
  MAX_BATCH_PUBLISH_TOOL_CALLS,
  MAX_BATCH_READ_TOOL_CALLS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_PUBLISH_TOOL_CALLS,
  MAX_READ_TOOL_CALLS,
  MAX_REQUEST_TIMEOUT_MS,
} from "../constants.js";
import { OpsError } from "../errors.js";

export type OperationKind = "read" | "write";

export interface OperationMetrics {
  readonly kind: OperationKind;
  upstreamToolCalls: number;
  retries: number;
  startedAt: number;
}

export class OperationContext {
  readonly kind: OperationKind;
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  readonly metrics: OperationMetrics;
  readonly #toolCallLimit: number;

  constructor(
    kind: OperationKind,
    options: {
      timeoutMs?: number;
      signal?: AbortSignal;
      now?: number;
      toolCallLimit?: number;
    } = {},
  ) {
    const now = options.now ?? Date.now();
    const requestedTimeout = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(requestedTimeout) || requestedTimeout <= 0) {
      throw new OpsError("failed", "timeoutMs must be a positive integer");
    }
    const timeoutMs = Math.min(requestedTimeout, MAX_REQUEST_TIMEOUT_MS);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    this.signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
    this.kind = kind;
    this.deadlineAt = now + timeoutMs;
    const defaultToolCallLimit = kind === "read" ? MAX_READ_TOOL_CALLS : MAX_PUBLISH_TOOL_CALLS;
    const maximumToolCallLimit =
      kind === "read" ? MAX_BATCH_READ_TOOL_CALLS : MAX_BATCH_PUBLISH_TOOL_CALLS;
    const requestedToolCallLimit = options.toolCallLimit ?? defaultToolCallLimit;
    if (
      !Number.isSafeInteger(requestedToolCallLimit) ||
      requestedToolCallLimit <= 0 ||
      requestedToolCallLimit > maximumToolCallLimit
    ) {
      throw new OpsError("failed", "toolCallLimit is outside the allowed range");
    }
    this.#toolCallLimit = requestedToolCallLimit;
    this.metrics = { kind, upstreamToolCalls: 0, retries: 0, startedAt: now };
  }

  consumeToolCall(): void {
    if (this.signal.aborted) throw this.abortError();
    if (this.metrics.upstreamToolCalls >= this.#toolCallLimit) {
      throw new OpsError("failed", "upstream tool call limit exceeded");
    }
    this.metrics.upstreamToolCalls += 1;
  }

  recordRetry(): void {
    this.metrics.retries += 1;
  }

  remainingMs(): number {
    return Math.max(0, this.deadlineAt - Date.now());
  }

  wallTimeMs(): number {
    return Math.max(0, Date.now() - this.metrics.startedAt);
  }

  abortError(): OpsError {
    const timedOut = Date.now() >= this.deadlineAt || this.signal.reason?.name === "TimeoutError";
    return new OpsError(
      timedOut ? "timeout" : "cancelled",
      timedOut ? "request timed out" : "request cancelled",
    );
  }
}
