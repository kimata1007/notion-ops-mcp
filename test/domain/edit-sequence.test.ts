import { describe, expect, it } from "vitest";

import {
  planEditSequence,
  sequenceCommands,
  verifyEditSequence,
} from "../../src/domain/edit-sequence.js";

describe("edit sequences", () => {
  it("combines independent targeted edits into one update_content command", () => {
    const markdown = "# Doc\n\nFirst\n\n## Target\n\nLast";
    const plan = planEditSequence(markdown, [
      { type: "replace_text", old_text: "First", new_text: "Updated" },
      {
        type: "insert_after",
        anchor: { kind: "heading", text: "Target" },
        markdown: "Inserted",
      },
    ]);

    expect(plan.state).toBe("ready");
    if (plan.state !== "ready") throw new Error("expected ready sequence");
    expect(sequenceCommands(markdown, plan)).toEqual([
      {
        command: "update_content",
        content_updates: [
          { old_str: "First", new_str: "Updated" },
          { old_str: "## Target", new_str: "## Target\n\nInserted" },
        ],
      },
    ]);
    expect(plan.expectedMarkdown).toBe("# Doc\n\nUpdated\n\n## Target\n\nInserted\n\nLast");
  });

  it("keeps dependent edits as ordered commands", () => {
    const markdown = "# Doc\n\nFirst";
    const plan = planEditSequence(markdown, [
      { type: "replace_text", old_text: "First", new_text: "Middle" },
      { type: "replace_text", old_text: "Middle", new_text: "Last" },
    ]);

    if (plan.state !== "ready") throw new Error("expected ready sequence");
    expect(sequenceCommands(markdown, plan)).toHaveLength(2);
    expect(plan.expectedMarkdown).toBe("# Doc\n\nLast");
  });

  it("reports the exact conflicting operation", () => {
    const plan = planEditSequence("# Doc\n\nBody", [
      { type: "append", markdown: "Footer" },
      { type: "replace_text", old_text: "Missing", new_text: "New" },
    ]);

    expect(plan).toEqual({ state: "conflict", reason: "old_text_missing", operationIndex: 1 });
  });

  it("recognizes a fully applied sequence", () => {
    const plan = planEditSequence("Header\n\nBody\n\nFooter", [
      { type: "prepend", markdown: "Header" },
      { type: "append", markdown: "Footer" },
    ]);

    expect(plan.state).toBe("already_applied");
  });

  it("verifies targeted edits while preserving a concurrent prefix", () => {
    const before = "# Doc\n\nFirst\n\nSecond";
    const plan = planEditSequence(before, [
      { type: "replace_text", old_text: "First", new_text: "Updated" },
      { type: "replace_text", old_text: "Second", new_text: "Changed" },
    ]);

    if (plan.state !== "ready") throw new Error("expected ready sequence");
    expect(verifyEditSequence(before, `User prefix\n\n${plan.expectedMarkdown}`, plan)).toBe(true);
  });
});
