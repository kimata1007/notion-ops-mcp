import { describe, expect, it } from "vitest";

import {
  contentEqual,
  contentSha256,
  createRevision,
  revisionsEqual,
} from "../../src/domain/revision.js";

describe("revision", () => {
  const edited = "2026-01-01T00:00:00.000Z";

  it("combines a timestamp with a content hash without retaining content", () => {
    const revision = createRevision("private body", edited);

    expect(revision).toEqual({
      version: 1,
      last_edited_time: edited,
      content_sha256: contentSha256("private body"),
    });
    expect(JSON.stringify(revision)).not.toContain("private body");
  });

  it("distinguishes full revision equality from content equality", () => {
    const first = createRevision("same", edited);
    const observedLater = createRevision("same", "2026-01-01T00:01:00.000Z");

    expect(revisionsEqual(first, observedLater)).toBe(false);
    expect(contentEqual(first, observedLater)).toBe(true);
  });
});
