import { describe, expect, it } from "vitest";

import { normalizeFetchResult } from "../../src/notion/normalize.js";
import { normalizeNotionPageUrl, normalizePageId } from "../../src/notion/url.js";

describe("Notion normalization", () => {
  it("parses the hosted notion-fetch text envelope", () => {
    const result = normalizeFetchResult({
      metadata: { type: "page" },
      title: "Project Overview",
      url: "https://www.notion.so/30702dc59a3b8106b51bed6d1bfeeed4",
      text: [
        'Here is the result of "view" for the Page with URL https://www.notion.so/30702dc59a3b8106b51bed6d1bfeeed4 as of 2026-02-14T22:56:21.276Z:',
        '<page url="https://www.notion.so/30702dc59a3b8106b51bed6d1bfeeed4">',
        "<properties>",
        '{"title":"Project Overview"}',
        "</properties>",
        "<content>",
        "# Project Overview",
        "",
        "This document outlines the project goals.",
        "</content>",
        "</page>",
      ].join("\n"),
    });

    expect(result).toMatchObject({
      id: "30702dc5-9a3b-8106-b51b-ed6d1bfeeed4",
      title: "Project Overview",
      markdown: "# Project Overview\n\nThis document outlines the project goals.",
      lastEditedTime: "2026-02-14T22:56:21.276Z",
      lastEditedTimeSource: "snapshot",
    });
  });

  it("validates page IDs and first-party page URLs", () => {
    expect(normalizePageId("30702dc59a3b8106b51bed6d1bfeeed4")).toBe(
      "30702dc5-9a3b-8106-b51b-ed6d1bfeeed4",
    );
    expect(
      normalizeNotionPageUrl(
        "https://notion.com/workspace/Project-30702dc59a3b8106b51bed6d1bfeeed4?pvs=4",
      ),
    ).toContain("notion.com/workspace/Project-");
    expect(() =>
      normalizeNotionPageUrl(
        "https://evil.example/workspace/Project-30702dc59a3b8106b51bed6d1bfeeed4",
      ),
    ).toThrow(/not allowed/);
  });
});
