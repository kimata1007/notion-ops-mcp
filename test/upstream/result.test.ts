import { describe, expect, it } from "vitest";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { normalizeThrownError, parseToolResult } from "../../src/upstream/result.js";

function errorResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    isError: true,
  };
}

describe("upstream error normalization", () => {
  it("normalizes 429 and honors retry_after seconds", () => {
    expect(() =>
      parseToolResult(errorResult({ status: 429, code: "rate_limited", retry_after: 2 })),
    ).toThrow(
      expect.objectContaining({
        code: "rate_limited",
        retryable: true,
        retryAfterMs: 2_000,
      }),
    );
  });

  it("normalizes authentication without exposing an upstream body", () => {
    expect(() =>
      parseToolResult(
        errorResult({
          status: 401,
          code: "unauthorized",
          access_token: "ntn_do_not_copy",
        }),
      ),
    ).toThrow(
      expect.objectContaining({
        code: "auth_required",
        message: "upstream authentication is required",
      }),
    );
  });

  it("marks transport and server failures retryable but not validation failures", () => {
    const signal = new AbortController().signal;
    expect(normalizeThrownError(new TypeError("fetch failed"), signal)).toMatchObject({
      code: "failed",
      retryable: true,
    });
    expect(
      normalizeThrownError(Object.assign(new Error("server"), { status: 503 }), signal),
    ).toMatchObject({ code: "failed", retryable: true });
    expect(normalizeThrownError(new Error("invalid input"), signal)).toMatchObject({
      code: "failed",
      retryable: false,
    });
  });

  it("distinguishes cancellation from timeout", () => {
    const cancelled = new AbortController();
    cancelled.abort(new DOMException("cancelled", "AbortError"));
    expect(normalizeThrownError(new Error("ignored"), cancelled.signal).code).toBe("cancelled");

    const timedOut = new AbortController();
    timedOut.abort(new DOMException("expired", "TimeoutError"));
    expect(normalizeThrownError(new Error("ignored"), timedOut.signal).code).toBe("timeout");
  });
});
