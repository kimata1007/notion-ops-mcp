import { describe, expect, it } from "vitest";

import { SafeLogger } from "../../src/logger.js";
import { redact } from "../../src/security/redact.js";

describe("redaction", () => {
  it("removes tokens and content recursively", () => {
    expect(
      redact({
        Authorization: "Bearer ntn_supersecret",
        nested: { refresh_token: "rotate-me", message: "token secret_abcdef leaked" },
        markdown: "private page",
      }),
    ).toEqual({
      Authorization: "[REDACTED]",
      nested: { refresh_token: "[REDACTED]", message: "token [REDACTED] leaked" },
      markdown: "[REDACTED]",
    });
  });

  it("keeps stdout untouched and writes safe JSON to the configured sink", () => {
    const lines: string[] = [];
    const logger = new SafeLogger((line) => lines.push(line));
    logger.info("tool_completed", { token: "ntn_secret", status: "success" });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("ntn_secret");
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      event: "tool_completed",
      status: "success",
      token: "[REDACTED]",
    });
  });
});
