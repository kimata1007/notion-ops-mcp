import { describe, expect, it } from "vitest";

import { loadRuntimeConfig } from "../src/config.js";

describe("loadRuntimeConfig", () => {
  it("uses the official hosted Notion MCP endpoint by default", () => {
    expect(loadRuntimeConfig({}).upstreamEndpoint.toString()).toBe("https://mcp.notion.com/mcp");
  });

  it.each([
    "not a URL",
    "http://mcp.notion.com/mcp",
    "https://user:pass@mcp.notion.com/mcp",
    "https://mcp.notion.com/mcp#fragment",
  ])("rejects an unsafe upstream endpoint: %s", (endpoint) => {
    expect(() => loadRuntimeConfig({ NOTION_MCP_URL: endpoint })).toThrow();
  });
});
