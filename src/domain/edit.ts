import { Buffer } from "node:buffer";

import { canonicalizeNotionMarkdown, notionMarkdownEquivalent } from "../notion/markdown.js";
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
  const canonicalMarkdown = canonicalizeNotionMarkdown(markdown);
  const canonicalNewFragment = canonicalizeNotionMarkdown(newFragment);
  if (countOccurrences(canonicalMarkdown, canonicalNewFragment) === 1) {
    return { state: "already_applied", expectedMarkdown: markdown };
  }
  if (content && countOccurrences(canonicalMarkdown, canonicalizeNotionMarkdown(content)) > 0) {
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
      if (notionMarkdownEquivalent(expectedMarkdown, markdown))
        return { state: "already_applied", expectedMarkdown: markdown };
      const canonicalMarkdown = canonicalizeNotionMarkdown(markdown);
      const suffix = canonicalizeNotionMarkdown(operation.markdown);
      if (canonicalMarkdown.endsWith(suffix) && countOccurrences(canonicalMarkdown, suffix) === 1)
        return { state: "already_applied", expectedMarkdown: markdown };
      if (countOccurrences(canonicalMarkdown, suffix) > 0) {
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
      if (notionMarkdownEquivalent(expectedMarkdown, markdown))
        return { state: "already_applied", expectedMarkdown: markdown };
      const canonicalMarkdown = canonicalizeNotionMarkdown(markdown);
      const prefix = canonicalizeNotionMarkdown(operation.markdown);
      if (canonicalMarkdown.startsWith(prefix) && countOccurrences(canonicalMarkdown, prefix) === 1)
        return { state: "already_applied", expectedMarkdown: markdown };
      if (countOccurrences(canonicalMarkdown, prefix) > 0) {
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
      if (notionMarkdownEquivalent(markdown, operation.markdown)) {
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
  if (notionMarkdownEquivalent(after, plan.expectedMarkdown)) return true;
  if (operation.type === "replace_document") return false;

  const canonicalBefore = canonicalizeNotionMarkdown(before);
  const canonicalAfter = canonicalizeNotionMarkdown(after);

  if (operation.type === "append") {
    const suffix = canonicalizeNotionMarkdown(operation.markdown);
    if (!canonicalAfter.endsWith(suffix) || countOccurrences(canonicalAfter, suffix) !== 1)
      return false;
    return isSubsequence(canonicalBefore, canonicalAfter.slice(0, -suffix.length));
  }
  if (operation.type === "prepend") {
    const prefix = canonicalizeNotionMarkdown(operation.markdown);
    if (!canonicalAfter.startsWith(prefix) || countOccurrences(canonicalAfter, prefix) !== 1)
      return false;
    return isSubsequence(canonicalBefore, canonicalAfter.slice(prefix.length));
  }

  if (!plan.oldFragment || plan.newFragment === undefined) return false;
  const oldFragment = canonicalizeNotionMarkdown(plan.oldFragment);
  const newFragment = canonicalizeNotionMarkdown(plan.newFragment);
  if (countOccurrences(canonicalAfter, newFragment) !== 1) return false;
  const reverted = canonicalAfter.replace(newFragment, oldFragment);
  return isSubsequence(canonicalBefore, reverted);
}
