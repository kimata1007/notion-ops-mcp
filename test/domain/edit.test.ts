import { describe, expect, it } from "vitest";

import { planEdit, verifyEdit } from "../../src/domain/edit.js";

describe("deterministic edits", () => {
  it("resolves a unique heading and inserts after it", () => {
    const before = "# Doc\n\n## Target\n\nOld body\n\n## Other\n\nKeep";
    const operation = {
      type: "insert_after" as const,
      anchor: { kind: "heading" as const, text: "Target" },
      markdown: "Inserted",
    };
    const plan = planEdit(before, operation);

    expect(plan).toMatchObject({
      state: "ready",
      upstreamArguments: {
        command: "update_content",
        content_updates: [{ old_str: "## Target", new_str: "## Target\n\nInserted" }],
      },
    });
    if (plan.state !== "ready") throw new Error("expected ready plan");
    expect(verifyEdit(before, plan.expectedMarkdown, operation, plan)).toBe(true);
  });

  it("refuses missing and repeated anchors", () => {
    expect(
      planEdit("# Doc", {
        type: "insert_before",
        anchor: { kind: "context", text: "missing" },
        markdown: "new",
      }),
    ).toMatchObject({ state: "conflict", reason: "anchor_missing" });
    expect(
      planEdit("same and same", {
        type: "insert_before",
        anchor: { kind: "context", text: "same" },
        markdown: "new",
      }),
    ).toMatchObject({ state: "conflict", reason: "anchor_ambiguous" });
  });

  it("requires replace_text to match exactly once", () => {
    expect(
      planEdit("old / old", { type: "replace_text", old_text: "old", new_text: "new" }),
    ).toMatchObject({ state: "conflict", reason: "old_text_ambiguous" });
    expect(
      planEdit("already new", { type: "replace_text", old_text: "old", new_text: "new" }),
    ).toMatchObject({ state: "already_applied" });
  });

  it("uses atomic edge insertion for append and prepend", () => {
    expect(planEdit("body", { type: "append", markdown: "tail" })).toMatchObject({
      state: "ready",
      upstreamArguments: { command: "insert_content", content: "tail" },
    });
    expect(planEdit("body", { type: "prepend", markdown: "head" })).toMatchObject({
      state: "ready",
      upstreamArguments: {
        command: "insert_content",
        content: "head",
        position: { type: "start" },
      },
    });
  });

  it("verifies that concurrent insertions are preserved", () => {
    const before = "original";
    const operation = { type: "append" as const, markdown: "requested" };
    const plan = planEdit(before, operation);
    if (plan.state !== "ready") throw new Error("expected ready plan");

    expect(verifyEdit(before, "original\nuser edit\nrequested", operation, plan)).toBe(true);
    expect(verifyEdit(before, "user replaced it\nrequested", operation, plan)).toBe(false);
  });
});
