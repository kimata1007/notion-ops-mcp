import { Buffer } from "node:buffer";

import {
  BATCH_CONCURRENCY,
  MAX_BATCH_PUBLISH_TOOL_CALLS,
  MAX_REBASE_ATTEMPTS,
} from "../constants.js";
import {
  planEdit,
  verifyEdit,
  type ConflictReason as EditConflictReason,
  type EditPlan,
} from "../domain/edit.js";
import {
  planEditSequence,
  sequenceCommands,
  verifyEditSequence,
  type EditSequencePlan,
} from "../domain/edit-sequence.js";
import { contentEqual, createRevision, type Revision } from "../domain/revision.js";
import { isOpsError, OpsError } from "../errors.js";
import {
  normalizeFetchResult,
  normalizeSearchResult,
  type PageSnapshot,
  type SearchCandidate,
} from "../notion/normalize.js";
import { pageIdFromUrl } from "../notion/url.js";
import { OperationContext } from "../upstream/context.js";
import type { McpUpstreamClient } from "../upstream/mcp-client.js";
import type { JsonObject, UpstreamToolNames } from "../upstream/types.js";
import {
  PublishDocumentInputSchema,
  type PublishDocumentInput,
  type PublishOperation,
} from "./schemas.js";

const ASYNC_MARKDOWN_THRESHOLD_BYTES = 128 * 1024;

type ExecutedOperation = PublishOperation["type"] | "create" | "batch" | "create_batch";

type ConflictReason =
  | EditConflictReason
  | "base_revision_changed"
  | "same_region_changed"
  | "replace_document_changed"
  | "concurrent_change"
  | "incomplete_page"
  | "verification_failed";

interface PublishSummary {
  operation: "publish";
  executed_operation: ExecutedOperation;
  operation_count: number;
  created: boolean;
  auto_rebased: boolean;
  verification: "verified" | "not_run" | "failed";
  upstream_tool_calls: number;
  retries: number;
  wall_time_ms: number;
  target?: { id: string; url: string };
}

interface PublishedResult {
  status: "success" | "already_applied";
  page_id: string;
  url: string;
  created: boolean;
  operation: ExecutedOperation;
  operations?: PublishOperation["type"][];
  auto_rebased: boolean;
  verification: "verified";
  revision: Revision;
  summary: PublishSummary;
}

export type PublishDocumentResult =
  | PublishedResult
  | {
      status: "success" | "partial";
      pages: Array<
        | {
            status: "verified";
            page_id: string;
            url: string;
            title: string;
            revision: Revision;
          }
        | {
            status: "verification_failed";
            page_id: string;
            url?: string;
            title: string;
            reason: string;
          }
      >;
      created_count: number;
      verified_count: number;
      operation: "create_batch";
      summary: PublishSummary;
    }
  | {
      status: "dry_run";
      plan: {
        operation: ExecutedOperation;
        target?: { id?: string; url?: string; title?: string; parent?: JsonObject };
        targets?: Array<{ title: string; parent: JsonObject }>;
        operations?: PublishOperation["type"][];
        added_bytes: number;
        removed_bytes: number;
        current_revision?: Revision;
      };
      summary: PublishSummary;
    }
  | { status: "not_found"; summary: PublishSummary }
  | {
      status: "ambiguous";
      candidates: SearchCandidate[];
      candidate_count: number;
      summary: PublishSummary;
    }
  | {
      status: "conflict";
      reason: ConflictReason;
      operation_index?: number;
      summary: PublishSummary;
    }
  | {
      status: "auth_required" | "rate_limited" | "failed";
      reason: string;
      retry_after_ms?: number;
      authorization_url?: string;
      summary: PublishSummary;
    };

type CreateInput = Extract<PublishDocumentInput, { markdown: string }>;
type BatchCreateInput = Extract<PublishDocumentInput, { pages: unknown[] }>;
type UpdateInput = Extract<PublishDocumentInput, { operation: PublishOperation }>;
type BatchUpdateInput = Extract<PublishDocumentInput, { operations: PublishOperation[] }>;
type ExistingInput = UpdateInput | BatchUpdateInput;

type ResolvedTarget =
  | { state: "page"; page: PageSnapshot }
  | { state: "not_found" }
  | { state: "ambiguous"; candidates: SearchCandidate[] };

function isCreateInput(input: PublishDocumentInput): input is CreateInput {
  return input.target.type === "create" && "markdown" in input;
}

function isBatchCreateInput(input: PublishDocumentInput): input is BatchCreateInput {
  return input.target.type === "create_batch" && "pages" in input;
}

function isBatchUpdateInput(input: PublishDocumentInput): input is BatchUpdateInput {
  return "operations" in input;
}

function operationLabel(input: PublishDocumentInput): ExecutedOperation {
  if (isCreateInput(input)) return "create";
  if (isBatchCreateInput(input)) return "create_batch";
  return isBatchUpdateInput(input) ? "batch" : input.operation.type;
}

function operationCount(input: PublishDocumentInput): number {
  if (isBatchCreateInput(input)) return input.pages.length;
  if (isBatchUpdateInput(input)) return input.operations.length;
  return 1;
}

function payloadBytes(input: PublishDocumentInput): number {
  if (isCreateInput(input)) return Buffer.byteLength(input.markdown, "utf8");
  if (isBatchCreateInput(input)) {
    return input.pages.reduce((total, page) => total + Buffer.byteLength(page.markdown, "utf8"), 0);
  }
  const operations = isBatchUpdateInput(input) ? input.operations : [input.operation];
  return operations.reduce(
    (total, operation) =>
      total +
      Buffer.byteLength(
        operation.type === "replace_text" ? operation.new_text : operation.markdown,
        "utf8",
      ),
    0,
  );
}

function currentRevision(page: PageSnapshot): Revision {
  return {
    ...createRevision(page.markdown, page.lastEditedTime),
    last_edited_time_source: page.lastEditedTimeSource,
  };
}

function revisionChanged(base: Revision, current: Revision): boolean {
  if (!contentEqual(base, current)) return true;
  if (
    base.last_edited_time_source === "snapshot" ||
    current.last_edited_time_source === "snapshot"
  ) {
    return false;
  }
  return base.last_edited_time !== current.last_edited_time;
}

function isWholeLineMatch(markdown: string, text: string): boolean {
  return markdown.split(/\r?\n/u).filter((line) => line === text).length === 1;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asyncTaskFrom(value: unknown): Record<string, unknown> | undefined {
  const root = asRecord(value);
  if (!root) return undefined;
  if (root["object"] === "async_task") return root;
  return asRecord(root["async_task"]);
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value !== undefined) results[index] = await worker(value, index);
    }
  });
  await Promise.all(runners);
  return results;
}

export class PublishDocumentService {
  readonly #upstream: McpUpstreamClient;

  constructor(upstream: McpUpstreamClient) {
    this.#upstream = upstream;
  }

  async execute(inputValue: unknown, signal?: AbortSignal): Promise<PublishDocumentResult> {
    const parsed = PublishDocumentInputSchema.safeParse(inputValue);
    if (!parsed.success) return this.#invalidInput();
    const input = parsed.data;
    const batch = isBatchCreateInput(input) || isBatchUpdateInput(input);
    const context = new OperationContext("write", {
      ...(input.timeout_ms === undefined ? {} : { timeoutMs: input.timeout_ms }),
      ...(signal ? { signal } : {}),
      ...(batch ? { toolCallLimit: MAX_BATCH_PUBLISH_TOOL_CALLS } : {}),
    });
    const wantsAsync = payloadBytes(input) >= ASYNC_MARKDOWN_THRESHOLD_BYTES;

    try {
      if (isCreateInput(input) && input.dry_run) return this.#dryRunCreate(input, context);
      if (isBatchCreateInput(input) && input.dry_run) {
        return this.#dryRunBatchCreate(input, context);
      }
      const names = (await this.#upstream.catalog(context)).resolve({
        requireWrite: true,
        requireAsync: wantsAsync,
      });
      if (isCreateInput(input)) return await this.#create(input, names, context, wantsAsync);
      if (isBatchCreateInput(input)) {
        return await this.#createBatch(input, names, context, wantsAsync);
      }
      return isBatchUpdateInput(input)
        ? await this.#updateBatch(input, names, context, wantsAsync)
        : await this.#update(input, names, context, wantsAsync);
    } catch (error) {
      return this.#failure(error, context, operationLabel(input), operationCount(input));
    }
  }

  #dryRunCreate(
    input: Extract<PublishDocumentInput, { markdown: string }>,
    context: OperationContext,
  ): PublishDocumentResult {
    const parent = this.#parentArguments(input.target.parent);
    return {
      status: "dry_run",
      plan: {
        operation: "create",
        target: { title: input.target.title, parent },
        added_bytes: Buffer.byteLength(input.markdown, "utf8"),
        removed_bytes: 0,
      },
      summary: this.#summary(context, "create", true, false, "not_run"),
    };
  }

  #dryRunBatchCreate(input: BatchCreateInput, context: OperationContext): PublishDocumentResult {
    const parent = this.#parentArguments(input.target.parent);
    return {
      status: "dry_run",
      plan: {
        operation: "create_batch",
        targets: input.pages.map((page) => ({ title: page.title, parent })),
        added_bytes: payloadBytes(input),
        removed_bytes: 0,
      },
      summary: this.#summary(
        context,
        "create_batch",
        true,
        false,
        "not_run",
        undefined,
        input.pages.length,
      ),
    };
  }

  async #create(
    input: Extract<PublishDocumentInput, { markdown: string }>,
    names: UpstreamToolNames,
    context: OperationContext,
    wantsAsync: boolean,
  ): Promise<PublishDocumentResult> {
    const createdResult = await this.#upstream.callTool(
      names.createPages,
      {
        parent: this.#parentArguments(input.target.parent),
        pages: [{ properties: { title: input.target.title }, content: input.markdown }],
        ...(wantsAsync ? { allow_async: true } : {}),
      },
      "write",
      context,
    );
    const completed = await this.#awaitAsync(createdResult.value, names, context);
    const reference = this.#createdReference(completed);
    const fetched = await this.#upstream.callTool(
      names.fetch,
      { id: reference.url ?? reference.id },
      "read",
      context,
    );
    const page = normalizeFetchResult(fetched.value);
    if (
      page.upstreamTruncated ||
      page.title !== input.target.title ||
      page.markdown !== input.markdown
    ) {
      return {
        status: "conflict",
        reason: "verification_failed",
        summary: this.#summary(context, "create", true, false, "failed", page),
      };
    }
    return this.#published("success", page, "create", true, false, context);
  }

  async #createBatch(
    input: BatchCreateInput,
    names: UpstreamToolNames,
    context: OperationContext,
    wantsAsync: boolean,
  ): Promise<PublishDocumentResult> {
    const createdResult = await this.#upstream.callTool(
      names.createPages,
      {
        parent: this.#parentArguments(input.target.parent),
        pages: input.pages.map((page) => ({
          properties: { title: page.title },
          content: page.markdown,
        })),
        ...(wantsAsync ? { allow_async: true } : {}),
      },
      "write",
      context,
    );
    const completed = await this.#awaitAsync(createdResult.value, names, context);
    const references = this.#createdReferences(completed);
    if (references.length !== input.pages.length) {
      throw new OpsError(
        "upstream_incompatible",
        "batch create result does not match the requested page count",
      );
    }

    const pages = await mapConcurrent(references, BATCH_CONCURRENCY, async (reference, index) => {
      const requested = input.pages[index];
      if (!requested) {
        throw new OpsError("upstream_incompatible", "batch create result order is invalid");
      }
      try {
        const page = await this.#fetchPage(reference.url ?? reference.id, names, context);
        if (
          page.upstreamTruncated ||
          page.title !== requested.title ||
          page.markdown !== requested.markdown
        ) {
          return {
            status: "verification_failed" as const,
            page_id: reference.id,
            ...(reference.url ? { url: reference.url } : {}),
            title: requested.title,
            reason: "content_mismatch",
          };
        }
        return {
          status: "verified" as const,
          page_id: page.id,
          url: page.url,
          title: page.title,
          revision: currentRevision(page),
        };
      } catch (error) {
        return {
          status: "verification_failed" as const,
          page_id: reference.id,
          ...(reference.url ? { url: reference.url } : {}),
          title: requested.title,
          reason: isOpsError(error) ? error.code : "verification_failed",
        };
      }
    });
    const verifiedCount = pages.filter((page) => page.status === "verified").length;
    return {
      status: verifiedCount === pages.length ? "success" : "partial",
      pages,
      created_count: references.length,
      verified_count: verifiedCount,
      operation: "create_batch",
      summary: this.#summary(
        context,
        "create_batch",
        true,
        false,
        verifiedCount === pages.length ? "verified" : "failed",
        undefined,
        input.pages.length,
      ),
    };
  }

  async #update(
    input: UpdateInput,
    names: UpstreamToolNames,
    context: OperationContext,
    wantsAsync: boolean,
  ): Promise<PublishDocumentResult> {
    const resolved = await this.#resolveTarget(input, names, context);
    if (resolved.state === "not_found") {
      return {
        status: "not_found",
        summary: this.#summary(context, input.operation.type, false, false, "not_run"),
      };
    }
    if (resolved.state === "ambiguous") {
      return {
        status: "ambiguous",
        candidates: resolved.candidates,
        candidate_count: resolved.candidates.length,
        summary: this.#summary(context, input.operation.type, false, false, "not_run"),
      };
    }

    let page = resolved.page;
    if (page.upstreamTruncated) {
      return this.#conflict("incomplete_page", input, context, page, false);
    }
    const revision = currentRevision(page);
    const changed = input.base_revision ? revisionChanged(input.base_revision, revision) : false;
    let autoRebased = false;
    if (changed) {
      if (input.operation.type === "replace_document") {
        return this.#conflict("replace_document_changed", input, context, page, false);
      }
      if (input.conflict_policy === "fail_on_change") {
        return this.#conflict("base_revision_changed", input, context, page, false);
      }
      if (
        input.operation.type === "replace_text" &&
        !isWholeLineMatch(page.markdown, input.operation.old_text)
      ) {
        return this.#conflict("same_region_changed", input, context, page, false);
      }
      autoRebased = true;
    }

    let plan = planEdit(page.markdown, input.operation);
    if (plan.state === "conflict") {
      return this.#conflict(plan.reason, input, context, page, autoRebased);
    }
    if (input.dry_run) return this.#dryRunUpdate(input, plan, page, context, autoRebased);
    if (plan.state === "already_applied") {
      return this.#published(
        "already_applied",
        page,
        input.operation.type,
        false,
        autoRebased,
        context,
      );
    }

    let rebaseAttempts = 0;
    while (true) {
      try {
        const update = await this.#upstream.callTool(
          names.updatePage,
          {
            page_id: page.id,
            ...plan.upstreamArguments,
            ...(wantsAsync ? { allow_async: true } : {}),
          },
          "write",
          context,
        );
        await this.#awaitAsync(update.value, names, context);
        break;
      } catch (error) {
        const normalized = isOpsError(error) ? error : new OpsError("failed", "write failed");
        const validationRejected = normalized.details?.["upstreamCode"] === "validation_error";
        if (
          !validationRejected ||
          input.conflict_policy !== "auto_rebase" ||
          rebaseAttempts >= MAX_REBASE_ATTEMPTS
        ) {
          return await this.#verifyUnknownWrite(
            error,
            input,
            plan,
            page,
            names,
            context,
            autoRebased,
          );
        }
        rebaseAttempts += 1;
        autoRebased = true;
        const refreshed = await this.#fetchPage(page.id, names, context);
        if (refreshed.upstreamTruncated) {
          return this.#conflict("incomplete_page", input, context, refreshed, true);
        }
        const refreshedPlan = planEdit(refreshed.markdown, input.operation);
        if (refreshedPlan.state === "already_applied") {
          return this.#published(
            "already_applied",
            refreshed,
            input.operation.type,
            false,
            true,
            context,
          );
        }
        if (refreshedPlan.state === "conflict") {
          return this.#conflict(refreshedPlan.reason, input, context, refreshed, true);
        }
        page = refreshed;
        plan = refreshedPlan;
      }
    }

    const verified = await this.#fetchPage(page.id, names, context);
    if (
      verified.upstreamTruncated ||
      !verifyEdit(page.markdown, verified.markdown, input.operation, plan)
    ) {
      return this.#conflict("verification_failed", input, context, verified, autoRebased, "failed");
    }
    return this.#published("success", verified, input.operation.type, false, autoRebased, context);
  }

  async #updateBatch(
    input: BatchUpdateInput,
    names: UpstreamToolNames,
    context: OperationContext,
    wantsAsync: boolean,
  ): Promise<PublishDocumentResult> {
    const resolved = await this.#resolveTarget(input, names, context);
    if (resolved.state === "not_found") {
      return {
        status: "not_found",
        summary: this.#summary(
          context,
          "batch",
          false,
          false,
          "not_run",
          undefined,
          input.operations.length,
        ),
      };
    }
    if (resolved.state === "ambiguous") {
      return {
        status: "ambiguous",
        candidates: resolved.candidates,
        candidate_count: resolved.candidates.length,
        summary: this.#summary(
          context,
          "batch",
          false,
          false,
          "not_run",
          undefined,
          input.operations.length,
        ),
      };
    }

    let page = resolved.page;
    if (page.upstreamTruncated) {
      return this.#sequenceConflict("incomplete_page", input, context, page, false);
    }
    const revision = currentRevision(page);
    const changed = input.base_revision ? revisionChanged(input.base_revision, revision) : false;
    let autoRebased = false;
    if (changed) {
      const replacementIndex = input.operations.findIndex(
        (operation) => operation.type === "replace_document",
      );
      if (replacementIndex >= 0) {
        return this.#sequenceConflict(
          "replace_document_changed",
          input,
          context,
          page,
          false,
          replacementIndex,
        );
      }
      if (input.conflict_policy === "fail_on_change") {
        return this.#sequenceConflict("base_revision_changed", input, context, page, false);
      }
      const changedReplacementIndex = input.operations.findIndex(
        (operation) =>
          operation.type === "replace_text" && !isWholeLineMatch(page.markdown, operation.old_text),
      );
      if (changedReplacementIndex >= 0) {
        return this.#sequenceConflict(
          "same_region_changed",
          input,
          context,
          page,
          false,
          changedReplacementIndex,
        );
      }
      autoRebased = true;
    }

    let plan = planEditSequence(page.markdown, input.operations);
    if (plan.state === "conflict") {
      return this.#sequenceConflict(
        plan.reason,
        input,
        context,
        page,
        autoRebased,
        plan.operationIndex,
      );
    }
    if (input.dry_run) {
      return this.#dryRunSequence(input, plan, page, context, autoRebased);
    }
    if (plan.state === "already_applied") {
      return this.#published(
        "already_applied",
        page,
        "batch",
        false,
        autoRebased,
        context,
        input.operations,
      );
    }

    let rebaseAttempts = 0;
    while (true) {
      try {
        for (const command of sequenceCommands(page.markdown, plan)) {
          const update = await this.#upstream.callTool(
            names.updatePage,
            {
              page_id: page.id,
              ...command,
              ...(wantsAsync ? { allow_async: true } : {}),
            },
            "write",
            context,
          );
          await this.#awaitAsync(update.value, names, context);
        }
        break;
      } catch (error) {
        const normalized = isOpsError(error) ? error : new OpsError("failed", "write failed");
        const validationRejected = normalized.details?.["upstreamCode"] === "validation_error";
        if (
          !validationRejected ||
          input.conflict_policy !== "auto_rebase" ||
          rebaseAttempts >= MAX_REBASE_ATTEMPTS
        ) {
          return await this.#verifyUnknownSequence(
            error,
            input,
            plan,
            page,
            names,
            context,
            autoRebased,
          );
        }
        rebaseAttempts += 1;
        autoRebased = true;
        const refreshed = await this.#fetchPage(page.id, names, context);
        if (refreshed.upstreamTruncated) {
          return this.#sequenceConflict("incomplete_page", input, context, refreshed, true);
        }
        const refreshedPlan = planEditSequence(refreshed.markdown, input.operations);
        if (refreshedPlan.state === "already_applied") {
          return this.#published(
            "already_applied",
            refreshed,
            "batch",
            false,
            true,
            context,
            input.operations,
          );
        }
        if (refreshedPlan.state === "conflict") {
          return this.#sequenceConflict(
            refreshedPlan.reason,
            input,
            context,
            refreshed,
            true,
            refreshedPlan.operationIndex,
          );
        }
        page = refreshed;
        plan = refreshedPlan;
      }
    }

    const verified = await this.#fetchPage(page.id, names, context);
    if (verified.upstreamTruncated || !verifyEditSequence(page.markdown, verified.markdown, plan)) {
      return this.#sequenceConflict(
        "verification_failed",
        input,
        context,
        verified,
        autoRebased,
        undefined,
        "failed",
      );
    }
    return this.#published(
      "success",
      verified,
      "batch",
      false,
      autoRebased,
      context,
      input.operations,
    );
  }

  async #verifyUnknownSequence(
    error: unknown,
    input: BatchUpdateInput,
    plan: Extract<EditSequencePlan, { state: "ready" }>,
    before: PageSnapshot,
    names: UpstreamToolNames,
    context: OperationContext,
    autoRebased: boolean,
  ): Promise<PublishDocumentResult> {
    const normalized = isOpsError(error) ? error : new OpsError("failed", "write failed");
    try {
      const latest = await this.#fetchPage(before.id, names, context);
      if (!latest.upstreamTruncated && verifyEditSequence(before.markdown, latest.markdown, plan)) {
        return this.#published(
          "success",
          latest,
          "batch",
          false,
          autoRebased,
          context,
          input.operations,
        );
      }
      if (normalized.details?.["upstreamCode"] === "validation_error") {
        const latestPlan = planEditSequence(latest.markdown, input.operations);
        if (latestPlan.state === "already_applied") {
          return this.#published(
            "already_applied",
            latest,
            "batch",
            false,
            autoRebased,
            context,
            input.operations,
          );
        }
        return this.#sequenceConflict(
          latestPlan.state === "conflict" ? latestPlan.reason : "concurrent_change",
          input,
          context,
          latest,
          autoRebased,
          latestPlan.state === "conflict" ? latestPlan.operationIndex : undefined,
        );
      }
    } catch {
      // Preserve the original safe error classification below.
    }
    return this.#failure(error, context, "batch", input.operations.length);
  }

  async #verifyUnknownWrite(
    error: unknown,
    input: UpdateInput,
    plan: Extract<EditPlan, { state: "ready" }>,
    before: PageSnapshot,
    names: UpstreamToolNames,
    context: OperationContext,
    autoRebased: boolean,
  ): Promise<PublishDocumentResult> {
    const normalized = isOpsError(error) ? error : new OpsError("failed", "write failed");
    try {
      const latest = await this.#fetchPage(before.id, names, context);
      if (
        !latest.upstreamTruncated &&
        verifyEdit(before.markdown, latest.markdown, input.operation, plan)
      ) {
        return this.#published(
          "success",
          latest,
          input.operation.type,
          false,
          autoRebased,
          context,
        );
      }
      if (normalized.details?.["upstreamCode"] === "validation_error") {
        const latestPlan = planEdit(latest.markdown, input.operation);
        if (latestPlan.state === "already_applied") {
          return this.#published(
            "already_applied",
            latest,
            input.operation.type,
            false,
            autoRebased,
            context,
          );
        }
        return this.#conflict(
          latestPlan.state === "conflict" ? latestPlan.reason : "concurrent_change",
          input,
          context,
          latest,
          autoRebased,
        );
      }
    } catch {
      // Preserve the original safe error classification below.
    }
    return this.#failure(error, context, input.operation.type);
  }

  async #resolveTarget(
    input: ExistingInput,
    names: UpstreamToolNames,
    context: OperationContext,
  ): Promise<ResolvedTarget> {
    let id: string;
    if (input.target.type === "search") {
      const searched = await this.#upstream.callTool(
        names.search,
        { query: input.target.query },
        "read",
        context,
      );
      const candidates = normalizeSearchResult(searched.value, 10);
      if (candidates.length === 0) return { state: "not_found" };
      if (candidates.length > 1) return { state: "ambiguous", candidates };
      const candidate = candidates[0];
      if (!candidate) return { state: "not_found" };
      id = candidate.url;
    } else {
      id = input.target.type === "url" ? input.target.url : input.target.page_id;
    }
    return { state: "page", page: await this.#fetchPage(id, names, context) };
  }

  async #fetchPage(
    id: string,
    names: UpstreamToolNames,
    context: OperationContext,
  ): Promise<PageSnapshot> {
    const result = await this.#upstream.callTool(names.fetch, { id }, "read", context);
    return normalizeFetchResult(result.value);
  }

  async #awaitAsync(
    value: unknown,
    names: UpstreamToolNames,
    context: OperationContext,
  ): Promise<unknown> {
    let task = asyncTaskFrom(value);
    if (!task) return value;
    if (!names.getAsyncTask) {
      throw new OpsError("upstream_incompatible", "async task tool is unavailable");
    }
    while (true) {
      const status = String(task["status"] ?? "");
      if (status === "succeeded") return task["result"] ?? task;
      if (status === "failed") throw new OpsError("failed", "upstream async task failed");
      if (!["queued", "running", "retrying"].includes(status)) {
        throw new OpsError("upstream_incompatible", "unknown upstream async task status");
      }
      const taskId = task["id"];
      if (typeof taskId !== "string") {
        throw new OpsError("upstream_incompatible", "async task has no ID");
      }
      const seconds = Number(task["poll_after_seconds"] ?? 1);
      const waitMs = Math.max(
        0,
        Math.min(Number.isFinite(seconds) ? seconds * 1_000 : 1_000, 5_000),
      );
      if (waitMs >= context.remainingMs()) throw context.abortError();
      await abortableDelay(waitMs, context.signal);
      const polled = await this.#upstream.callTool(
        names.getAsyncTask,
        { task_id: taskId },
        "read",
        context,
      );
      task = asyncTaskFrom(polled.value);
      if (!task) throw new OpsError("upstream_incompatible", "async status result is invalid");
    }
  }

  #dryRunUpdate(
    input: UpdateInput,
    plan: Exclude<EditPlan, { state: "conflict" }>,
    page: PageSnapshot,
    context: OperationContext,
    autoRebased: boolean,
  ): PublishDocumentResult {
    const ready = plan.state === "ready" ? plan : undefined;
    return {
      status: "dry_run",
      plan: {
        operation: input.operation.type,
        target: { id: page.id, url: page.url, title: page.title },
        added_bytes: ready?.addedBytes ?? 0,
        removed_bytes: ready?.removedBytes ?? 0,
        current_revision: currentRevision(page),
      },
      summary: this.#summary(context, input.operation.type, false, autoRebased, "not_run", page),
    };
  }

  #dryRunSequence(
    input: BatchUpdateInput,
    plan: Exclude<EditSequencePlan, { state: "conflict" }>,
    page: PageSnapshot,
    context: OperationContext,
    autoRebased: boolean,
  ): PublishDocumentResult {
    return {
      status: "dry_run",
      plan: {
        operation: "batch",
        operations: input.operations.map((operation) => operation.type),
        target: { id: page.id, url: page.url, title: page.title },
        added_bytes: plan.addedBytes,
        removed_bytes: plan.removedBytes,
        current_revision: currentRevision(page),
      },
      summary: this.#summary(
        context,
        "batch",
        false,
        autoRebased,
        "not_run",
        page,
        input.operations.length,
      ),
    };
  }

  #createdReference(value: unknown): { id: string; url?: string } {
    const reference = this.#createdReferences(value)[0];
    if (!reference) {
      throw new OpsError("upstream_incompatible", "create result has no page reference");
    }
    return reference;
  }

  #createdReferences(value: unknown): Array<{ id: string; url?: string }> {
    const root = asRecord(value);
    const values = Array.isArray(root?.["pages"])
      ? (root["pages"] as unknown[])
      : [asRecord(root?.["page"]) ?? root];
    const references = values.flatMap((value) => {
      const page = asRecord(value);
      const url = typeof page?.["url"] === "string" ? page["url"] : undefined;
      const idValue = page?.["id"] ?? page?.["page_id"];
      const id = typeof idValue === "string" ? idValue : url ? pageIdFromUrl(url) : undefined;
      return id ? [{ id, ...(url ? { url } : {}) }] : [];
    });
    if (references.length === 0) {
      throw new OpsError("upstream_incompatible", "create result has no page reference");
    }
    return references;
  }

  #parentArguments(parent: CreateInput["target"]["parent"]): JsonObject {
    return parent.type === "page_id"
      ? { page_id: parent.page_id }
      : { data_source_id: parent.data_source_id.replace(/^collection:\/\//i, "") };
  }

  #conflict(
    reason: ConflictReason,
    input: UpdateInput,
    context: OperationContext,
    page: PageSnapshot,
    autoRebased: boolean,
    verification: "not_run" | "failed" = "not_run",
  ): PublishDocumentResult {
    return {
      status: "conflict",
      reason,
      summary: this.#summary(context, input.operation.type, false, autoRebased, verification, page),
    };
  }

  #sequenceConflict(
    reason: ConflictReason,
    input: BatchUpdateInput,
    context: OperationContext,
    page: PageSnapshot,
    autoRebased: boolean,
    operationIndex?: number,
    verification: "not_run" | "failed" = "not_run",
  ): PublishDocumentResult {
    return {
      status: "conflict",
      reason,
      ...(operationIndex === undefined ? {} : { operation_index: operationIndex }),
      summary: this.#summary(
        context,
        "batch",
        false,
        autoRebased,
        verification,
        page,
        input.operations.length,
      ),
    };
  }

  #published(
    status: "success" | "already_applied",
    page: PageSnapshot,
    operation: ExecutedOperation,
    created: boolean,
    autoRebased: boolean,
    context: OperationContext,
    operations?: readonly PublishOperation[],
  ): PublishedResult {
    return {
      status,
      page_id: page.id,
      url: page.url,
      created,
      operation,
      ...(operations ? { operations: operations.map((item) => item.type) } : {}),
      auto_rebased: autoRebased,
      verification: "verified",
      revision: currentRevision(page),
      summary: this.#summary(
        context,
        operation,
        created,
        autoRebased,
        "verified",
        page,
        operations?.length ?? 1,
      ),
    };
  }

  #failure(
    error: unknown,
    context: OperationContext,
    operation: ExecutedOperation,
    count = 1,
  ): PublishDocumentResult {
    const normalized = isOpsError(error)
      ? error
      : new OpsError("failed", "publish operation failed");
    if (normalized.code === "not_found") {
      return {
        status: "not_found",
        summary: this.#summary(context, operation, false, false, "not_run", undefined, count),
      };
    }
    const status =
      normalized.code === "auth_required" || normalized.code === "rate_limited"
        ? normalized.code
        : "failed";
    const authorizationUrl = normalized.details?.["authorizationUrl"];
    return {
      status,
      reason: normalized.code,
      ...(normalized.retryAfterMs === undefined ? {} : { retry_after_ms: normalized.retryAfterMs }),
      ...(typeof authorizationUrl === "string" ? { authorization_url: authorizationUrl } : {}),
      summary: this.#summary(context, operation, false, false, "not_run", undefined, count),
    };
  }

  #invalidInput(): PublishDocumentResult {
    return {
      status: "failed",
      reason: "invalid_input",
      summary: {
        operation: "publish",
        executed_operation: "create",
        operation_count: 1,
        created: false,
        auto_rebased: false,
        verification: "not_run",
        upstream_tool_calls: 0,
        retries: 0,
        wall_time_ms: 0,
      },
    };
  }

  #summary(
    context: OperationContext,
    operation: ExecutedOperation,
    created: boolean,
    autoRebased: boolean,
    verification: "verified" | "not_run" | "failed",
    page?: PageSnapshot,
    count = 1,
  ): PublishSummary {
    return {
      operation: "publish",
      executed_operation: operation,
      operation_count: count,
      created,
      auto_rebased: autoRebased,
      verification,
      upstream_tool_calls: context.metrics.upstreamToolCalls,
      retries: context.metrics.retries,
      wall_time_ms: context.wallTimeMs(),
      ...(page ? { target: { id: page.id, url: page.url } } : {}),
    };
  }
}
