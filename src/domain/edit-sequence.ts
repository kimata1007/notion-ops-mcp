import {
  countOccurrences,
  planEdit,
  verifyEdit,
  type ConflictReason,
  type EditPlan,
} from "./edit.js";
import { canonicalizeNotionMarkdown, notionMarkdownEquivalent } from "../notion/markdown.js";
import type { PublishOperation } from "../tools/schemas.js";
import type { JsonObject } from "../upstream/types.js";

export interface EditSequenceStep {
  index: number;
  operation: PublishOperation;
  beforeMarkdown: string;
  plan: Exclude<EditPlan, { state: "conflict" }>;
}

interface PlannedEditSequence {
  expectedMarkdown: string;
  steps: EditSequenceStep[];
  addedBytes: number;
  removedBytes: number;
}

export type EditSequencePlan =
  | { state: "conflict"; reason: ConflictReason; operationIndex: number }
  | ({ state: "already_applied" } & PlannedEditSequence)
  | ({ state: "ready" } & PlannedEditSequence);

interface TargetedUpdate {
  oldFragment: string;
  newFragment: string;
  index: number;
}

export function planEditSequence(
  markdown: string,
  operations: readonly PublishOperation[],
): EditSequencePlan {
  let current = markdown;
  let addedBytes = 0;
  let removedBytes = 0;
  let hasReadyStep = false;
  const steps: EditSequenceStep[] = [];

  for (const [index, operation] of operations.entries()) {
    const plan = planEdit(current, operation);
    if (plan.state === "conflict") {
      return { state: "conflict", reason: plan.reason, operationIndex: index };
    }
    steps.push({ index, operation, beforeMarkdown: current, plan });
    if (plan.state === "ready") {
      hasReadyStep = true;
      current = plan.expectedMarkdown;
      addedBytes += plan.addedBytes;
      removedBytes += plan.removedBytes;
    }
  }

  return {
    state: hasReadyStep ? "ready" : "already_applied",
    expectedMarkdown: current,
    steps,
    addedBytes,
    removedBytes,
  };
}

function targetedUpdates(
  initialMarkdown: string,
  plan: Extract<EditSequencePlan, { state: "ready" }>,
): TargetedUpdate[] | undefined {
  const updates: TargetedUpdate[] = [];
  for (const step of plan.steps) {
    if (step.plan.state !== "ready") continue;
    const { oldFragment, newFragment } = step.plan;
    if (
      oldFragment === undefined ||
      newFragment === undefined ||
      countOccurrences(initialMarkdown, oldFragment) !== 1
    ) {
      return undefined;
    }
    updates.push({
      oldFragment,
      newFragment,
      index: initialMarkdown.indexOf(oldFragment),
    });
  }

  for (const [leftIndex, left] of updates.entries()) {
    const leftEnd = left.index + left.oldFragment.length;
    for (const [rightIndex, right] of updates.entries()) {
      if (leftIndex === rightIndex) continue;
      const rightEnd = right.index + right.oldFragment.length;
      if (left.index < rightEnd && right.index < leftEnd) return undefined;
      if (left.newFragment.includes(right.oldFragment)) return undefined;
    }
  }

  let combined = initialMarkdown;
  for (const update of [...updates].sort((left, right) => right.index - left.index)) {
    combined =
      combined.slice(0, update.index) +
      update.newFragment +
      combined.slice(update.index + update.oldFragment.length);
  }
  return combined === plan.expectedMarkdown ? updates : undefined;
}

export function sequenceCommands(
  initialMarkdown: string,
  plan: Extract<EditSequencePlan, { state: "ready" }>,
): JsonObject[] {
  const targeted = targetedUpdates(initialMarkdown, plan);
  if (targeted && targeted.length > 0) {
    return [
      {
        command: "update_content",
        content_updates: targeted.map((update) => ({
          old_str: update.oldFragment,
          new_str: update.newFragment,
        })),
      },
    ];
  }
  return plan.steps.flatMap((step) =>
    step.plan.state === "ready" ? [step.plan.upstreamArguments] : [],
  );
}

export function verifyEditSequence(
  before: string,
  after: string,
  plan: Extract<EditSequencePlan, { state: "ready" }>,
): boolean {
  if (notionMarkdownEquivalent(after, plan.expectedMarkdown)) return true;
  const readySteps = plan.steps.filter(
    (step): step is EditSequenceStep & { plan: Extract<EditPlan, { state: "ready" }> } =>
      step.plan.state === "ready",
  );
  if (
    readySteps.every(
      (step) => step.plan.oldFragment !== undefined && step.plan.newFragment !== undefined,
    )
  ) {
    let reverted = canonicalizeNotionMarkdown(after);
    for (const step of [...readySteps].reverse()) {
      const oldFragment =
        step.plan.oldFragment === undefined
          ? undefined
          : canonicalizeNotionMarkdown(step.plan.oldFragment);
      const newFragment =
        step.plan.newFragment === undefined
          ? undefined
          : canonicalizeNotionMarkdown(step.plan.newFragment);
      if (
        oldFragment === undefined ||
        newFragment === undefined ||
        countOccurrences(reverted, newFragment) !== 1
      ) {
        return false;
      }
      reverted = reverted.replace(newFragment, oldFragment);
    }
    const canonicalBefore = canonicalizeNotionMarkdown(before);
    let cursor = 0;
    for (const character of reverted) {
      if (character === canonicalBefore[cursor]) cursor += 1;
      if (cursor === canonicalBefore.length) return true;
    }
    return canonicalBefore.length === 0;
  }
  return plan.steps.every((step) =>
    step.plan.state === "ready"
      ? verifyEdit(step.beforeMarkdown, after, step.operation, step.plan)
      : planEdit(after, step.operation).state === "already_applied",
  );
}
