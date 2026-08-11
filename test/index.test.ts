import { describe, expect, it } from "vitest";

import { PACKAGE_NAME, PACKAGE_VERSION } from "../src/index.js";
import packageMetadata from "../package.json" with { type: "json" };

describe("package metadata", () => {
  it("exposes the executable package identity", () => {
    expect(PACKAGE_NAME).toBe("notion-ops-mcp");
    expect(PACKAGE_NAME).toBe(packageMetadata.name);
    expect(PACKAGE_VERSION).toBe(packageMetadata.version);
  });
});
