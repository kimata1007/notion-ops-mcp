import { describe, expect, it } from "vitest";

import { UpstreamToolCatalog } from "../../src/upstream/tool-catalog.js";
import type { UpstreamToolDefinition } from "../../src/upstream/types.js";

function tool(name: string, properties: readonly string[]): UpstreamToolDefinition {
  return {
    name,
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(properties.map((property) => [property, { type: "string" }])),
    },
  };
}

describe("UpstreamToolCatalog", () => {
  it("resolves official tools only after checking their schemas", () => {
    const catalog = new UpstreamToolCatalog([
      tool("notion-search", ["query"]),
      tool("notion-fetch", ["id"]),
      tool("notion-create-pages", ["parent", "pages"]),
      tool("notion-update-page", ["page_id", "command"]),
    ]);

    expect(catalog.resolve({ requireWrite: true })).toEqual({
      search: "notion-search",
      fetch: "notion-fetch",
      createPages: "notion-create-pages",
      updatePage: "notion-update-page",
    });
  });

  it("rejects an incompatible upstream before a write", () => {
    const catalog = new UpstreamToolCatalog([
      tool("notion-search", ["query"]),
      tool("notion-fetch", ["id"]),
      tool("notion-create-pages", ["pages"]),
      tool("notion-update-page", ["page_id"]),
    ]);

    expect(() => catalog.resolve({ requireWrite: true })).toThrow(/schema is incompatible/);
  });
});
