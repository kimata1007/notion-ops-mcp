import { describe, expect, it } from "vitest";

import { PACKAGE_NAME, PACKAGE_VERSION } from "../src/index.js";

describe("package metadata", () => {
  it("exposes the executable package identity", () => {
    expect(PACKAGE_NAME).toBe("notion-ops-mcp");
    expect(PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
