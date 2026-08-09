import { Buffer } from "node:buffer";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { OpsError } from "../errors.js";
import type { UpstreamCallResult } from "./types.js";

function parseRetryAfter(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.round(value * 1000);
  }
  if (typeof value !== "string") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function errorFromPayload(payload: unknown): OpsError {
  const record =
    payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const nested =
    record["error"] !== null && typeof record["error"] === "object"
      ? (record["error"] as Record<string, unknown>)
      : record;
  const status = Number(nested["status"] ?? record["status"]);
  const code = String(nested["code"] ?? record["code"] ?? "").toLowerCase();
  const retryAfterMs = parseRetryAfter(
    nested["retry_after"] ?? nested["retryAfter"] ?? record["retry_after"],
  );

  if (status === 401 || code.includes("unauth") || code === "invalid_token") {
    return new OpsError("auth_required", "upstream authentication is required");
  }
  if (status === 429 || code.includes("rate_limit")) {
    return new OpsError("rate_limited", "upstream rate limit reached", {
      retryable: true,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
  if (status === 404 || code === "object_not_found") {
    return new OpsError("not_found", "upstream object was not found");
  }
  return new OpsError("failed", "upstream tool call failed", {
    ...(code ? { details: { upstreamCode: code } } : {}),
  });
}

export function parseToolResult(result: CallToolResult): UpstreamCallResult {
  const textBlocks = result.content.filter(
    (block): block is Extract<(typeof result.content)[number], { type: "text" }> =>
      block.type === "text",
  );
  if (textBlocks.length !== 1) {
    throw new OpsError("upstream_incompatible", "upstream result must contain one JSON text block");
  }
  const text = textBlocks[0]?.text;
  if (text === undefined) {
    throw new OpsError("upstream_incompatible", "upstream result text is missing");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new OpsError("upstream_incompatible", "upstream result text is not JSON");
  }
  if (result.isError) throw errorFromPayload(value);
  return { value, rawTextBytes: Buffer.byteLength(text, "utf8") };
}

export function normalizeThrownError(error: unknown, signal: AbortSignal): OpsError {
  if (error instanceof OpsError) return error;
  if (signal.aborted) {
    const timedOut = signal.reason?.name === "TimeoutError";
    return new OpsError(
      timedOut ? "timeout" : "cancelled",
      timedOut ? "request timed out" : "request cancelled",
    );
  }

  const record =
    error !== null && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const status = Number(record["status"] ?? record["code"]);
  const name = String(record["name"] ?? "").toLowerCase();
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (status === 401 || name.includes("unauthorized") || message.includes("unauthorized")) {
    return new OpsError("auth_required", "upstream authentication is required");
  }
  if (status === 429 || message.includes("429") || message.includes("rate limit")) {
    return new OpsError("rate_limited", "upstream rate limit reached", { retryable: true });
  }
  if (
    name.includes("abort") ||
    message.includes("requesttimeout") ||
    message.includes("timed out")
  ) {
    return new OpsError("timeout", "upstream request timed out", { retryable: true });
  }
  const systemCode = String(record["code"] ?? "");
  if (
    error instanceof TypeError ||
    status >= 500 ||
    ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ENETUNREACH", "EAI_AGAIN"].includes(systemCode)
  ) {
    return new OpsError("failed", "transient upstream request failed", {
      retryable: true,
      cause: error,
    });
  }
  return new OpsError("failed", "upstream request failed", { cause: error });
}
