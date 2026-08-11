import { describe, expect, it } from "vitest";

import {
  canonicalizeNotionMarkdown,
  notionCreateContentEquivalent,
  notionMarkdownEquivalent,
} from "../../src/notion/markdown.js";

describe("Notion Markdown normalization", () => {
  it("treats hosted MCP block spacing as equivalent", () => {
    expect(
      notionMarkdownEquivalent(
        "Body\n## Wrapper append\nVerified append.",
        "Body\n\n## Wrapper append\n\nVerified append.",
      ),
    ).toBe(true);
  });

  it("preserves blank lines inside fenced code", () => {
    expect(canonicalizeNotionMarkdown("```text\na\n\nb\n```\n\nTail")).toBe(
      "```text\na\n\nb\n```\nTail",
    );
    expect(notionMarkdownEquivalent("```text\na\n\nb\n```", "```text\na\nb\n```")).toBe(false);
  });

  it("accepts the leading H1 consumed by hosted page creation", () => {
    expect(
      notionCreateContentEquivalent(
        "Created by notion-ops-mcp.",
        "# Acceptance fixture\n\nCreated by notion-ops-mcp.",
      ),
    ).toBe(true);
    expect(notionCreateContentEquivalent("Different", "# Acceptance fixture\n\nExpected")).toBe(
      false,
    );
  });
});
