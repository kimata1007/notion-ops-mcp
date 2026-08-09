import { Buffer } from "node:buffer";

import type { PublishOperation } from "../tools/schemas.js";
import type { JsonObject } from "../upstream/types.js";

export type ConflictReason =
  | "anchor_missing"
  | "anchor_ambiguous"
  | "old_text_missing"
  | "old_text_ambiguous"
  | "requested_content_already_exists_elsewhere";

export type EditPlan =
  | { state: "already_applied"; expectedMarkdown: string }
  | { state: "conflict"; reason: ConflictReason }
  | {
      state: "ready";
      expectedMarkdown: string;
      upstreamArguments: JsonObject;
      addedBytes: number;
      removedBytes: number;
      oldFragment?: string;
      newFragment?: string;
    };

export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const index = haystack.indexOf(needle, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + needle.length;
  }
}

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function join(first: string, second: string): string {
  if (!first) return second;
  if (!second) return first;
  return `${first.replace(/\s+$/u, "")}\n\n${second.replace(/^\s+/u, "")}`;
}

function resolveHeading(markdown: string, anchorText: string): string[] {
  const requested = anchorText.trim();
  return markdown.split(/\r?\n/u).filter((line) => {
    const match = line.match(/^(#{1,4})\s+(.+?)\s*$/u);
    if (!match) return false;
    return requested.startsWith("#") ? line.trim() === requested : match[2]?.trim() === requested;
  });
}

function resolveAnchor(
  markdown: string,
  operation: Extract<PublishOperation, { type: "insert_after" | "insert_before" }>,
): { state: "ok"; fragment: string } | { state: "conflict"; reason: ConflictReason } {
  if (operation.anchor.kind === "heading") {
    const matches = resolveHeading(markdown, operation.anchor.text);
    if (matches.length === 0) return { state: "conflict", reason: "anchor_missing" };
    if (matches.length > 1) return { state: "conflict", reason: "anchor_ambiguous" };
    const fragment = matches[0];
    return fragment ? { state: "ok", fragment } : { state: "conflict", reason: "anchor_missing" };
  }
  const count = countOccurrences(markdown, operation.anchor.text);
  if (count === 0) return { state: "conflict", reason: "anchor_missing" };
  if (count > 1) return { state: "conflict", reason: "anchor_ambiguous" };
  return { state: "ok", fragment: operation.anchor.text };
}

function targetedPlan(
  markdown: string,
  oldFragment: string,
  newFragment: string,
  content: string,
): EditPlan {
  if (countOccurrences(markdown, newFragment) === 1) {
    return { state: "already_applied", expectedMarkdown: markdown };
  }
  if (content && countOccurrences(markdown, content) > 0) {
    return { state: "conflict", reason: "requested_content_already_exists_elsewhere" };
  }
  const expectedMarkdown = markdown.replace(oldFragment, newFragment);
  return {
    state: "ready",
    expectedMarkdown,
    upstreamArguments: {
      command: "update_content",
      content_updates: [{ old_str: oldFragment, new_str: newFragment }],
    },
    addedBytes: Math.max(0, bytes(newFragment) - bytes(oldFragment)),
    removedBytes: Math.max(0, bytes(oldFragment) - bytes(newFragment)),
    oldFragment,
    newFragment,
  };
}

export function planEdit(markdown: string, operation: PublishOperation): EditPlan {
  switch (operation.type) {
    case "append": {
      const expectedMarkdown = join(markdown, operation.markdown);
      if (expectedMarkdown === markdown)
        return { state: "already_applied", expectedMarkdown: markdown };
      const suffix = operation.markdown.replace(/^\s+/u, "");
      if (markdown.endsWith(suffix))
        return { state: "already_applied", expectedMarkdown: markdown };
      if (countOccurrences(markdown, operation.markdown) > 0) {
        return { state: "conflict", reason: "requested_content_already_exists_elsewhere" };
      }
      return {
        state: "ready",
        expectedMarkdown,
        upstreamArguments: { command: "insert_content", content: operation.markdown },
        addedBytes: bytes(expectedMarkdown) - bytes(markdown),
        removedBytes: 0,
      };
    }
    case "prepend": {
      const expectedMarkdown = join(operation.markdown, markdown);
      if (expectedMarkdown === markdown)
        return { state: "already_applied", expectedMarkdown: markdown };
      const prefix = operation.markdown.replace(/\s+$/u, "");
      if (markdown.startsWith(prefix))
        return { state: "already_applied", expectedMarkdown: markdown };
      if (countOccurrences(markdown, operation.markdown) > 0) {
        return { state: "conflict", reason: "requested_content_already_exists_elsewhere" };
      }
      return {
        state: "ready",
        expectedMarkdown,
        upstreamArguments: {
          command: "insert_content",
          content: operation.markdown,
          position: { type: "start" },
        },
        addedBytes: bytes(expectedMarkdown) - bytes(markdown),
        removedBytes: 0,
      };
    }
    case "insert_after":
    case "insert_before": {
      const resolved = resolveAnchor(markdown, operation);
      if (resolved.state === "conflict") return resolved;
      const newFragment =
        operation.type === "insert_after"
          ? join(resolved.fragment, operation.markdown)
          : join(operation.markdown, resolved.fragment);
      return targetedPlan(markdown, resolved.fragment, newFragment, operation.markdown);
    }
    case "replace_text": {
      const oldCount = countOccurrences(markdown, operation.old_text);
      const newCount = countOccurrences(markdown, operation.new_text);
      if (operation.old_text === operation.new_text && oldCount === 1) {
        return { state: "already_applied", expectedMarkdown: markdown };
      }
      if (oldCount === 0 && newCount === 1) {
        return { state: "already_applied", expectedMarkdown: markdown };
      }
      if (oldCount === 0) return { state: "conflict", reason: "old_text_missing" };
      if (oldCount > 1 || newCount > 0) {
        return { state: "conflict", reason: "old_text_ambiguous" };
      }
      return targetedPlan(markdown, operation.old_text, operation.new_text, operation.new_text);
    }
    case "replace_document":
      if (markdown === operation.markdown) {
        return { state: "already_applied", expectedMarkdown: markdown };
      }
      return {
        state: "ready",
        expectedMarkdown: operation.markdown,
        upstreamArguments: { command: "replace_content", new_str: operation.markdown },
        addedBytes: bytes(operation.markdown),
        removedBytes: bytes(markdown),
      };
  }
}

function isSubsequence(expected: string, actual: string): boolean {
  let cursor = 0;
  for (const character of actual) {
    if (character === expected[cursor]) cursor += 1;
    if (cursor === expected.length) return true;
  }
  return expected.length === 0;
}

export function verifyEdit(
  before: string,
  after: string,
  operation: PublishOperation,
  plan: Extract<EditPlan, { state: "ready" }>,
): boolean {
  if (after === plan.expectedMarkdown) return true;
  if (operation.type === "replace_document") return false;

  if (operation.type === "append") {
    const suffix = operation.markdown.replace(/^\s+/u, "");
    if (!after.endsWith(suffix) || countOccurrences(after, operation.markdown) !== 1) return false;
    return isSubsequence(before, after.slice(0, -suffix.length));
  }
  if (operation.type === "prepend") {
    const prefix = operation.markdown.replace(/\s+$/u, "");
    if (!after.startsWith(prefix) || countOccurrences(after, operation.markdown) !== 1)
      return false;
    return isSubsequence(before, after.slice(prefix.length));
  }

  if (!plan.oldFragment || plan.newFragment === undefined) return false;
  if (countOccurrences(after, plan.newFragment) !== 1) return false;
  const reverted = after.replace(plan.newFragment, plan.oldFragment);
  return isSubsequence(before, reverted);
}
