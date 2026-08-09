import { Buffer } from "node:buffer";

import { MAX_REBASE_ATTEMPTS } from "../constants.js";
import {
  planEdit,
  verifyEdit,
  type ConflictReason as EditConflictReason,
  type EditPlan,
} from "../domain/edit.js";
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
  executed_operation: PublishOperation["type"] | "create";
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
  operation: PublishOperation["type"] | "create";
  auto_rebased: boolean;
  verification: "verified";
  revision: Revision;
  summary: PublishSummary;
}

export type PublishDocumentResult =
  | PublishedResult
  | {
      status: "dry_run";
      plan: {
        operation: PublishOperation["type"] | "create";
        target: { id?: string; url?: string; title?: string; parent?: JsonObject };
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
  | { status: "conflict"; reason: ConflictReason; summary: PublishSummary }
  | {
      status: "auth_required" | "rate_limited" | "failed";
      reason: string;
      retry_after_ms?: number;
      authorization_url?: string;
      summary: PublishSummary;
    };

type UpdateInput = Extract<PublishDocumentInput, { operation: PublishOperation }>;

type ResolvedTarget =
  | { state: "page"; page: PageSnapshot }
  | { state: "not_found" }
  | { state: "ambiguous"; candidates: SearchCandidate[] };

function isCreateInput(
  input: PublishDocumentInput,
): input is Extract<PublishDocumentInput, { markdown: string }> {
  return input.target.type === "create" && "markdown" in input;
}

function payloadBytes(input: PublishDocumentInput): number {
  if (isCreateInput(input)) return Buffer.byteLength(input.markdown, "utf8");
  const operation = input.operation;
  switch (operation.type) {
    case "replace_text":
      return Buffer.byteLength(operation.new_text, "utf8");
    default:
      return Buffer.byteLength(operation.markdown, "utf8");
  }
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

export class PublishDocumentService {
  readonly #upstream: McpUpstreamClient;

  constructor(upstream: McpUpstreamClient) {
    this.#upstream = upstream;
  }

  async execute(inputValue: unknown, signal?: AbortSignal): Promise<PublishDocumentResult> {
    const parsed = PublishDocumentInputSchema.safeParse(inputValue);
    if (!parsed.success) return this.#invalidInput();
    const input = parsed.data;
    const context = new OperationContext("write", {
      ...(input.timeout_ms === undefined ? {} : { timeoutMs: input.timeout_ms }),
      ...(signal ? { signal } : {}),
    });
    const wantsAsync = payloadBytes(input) >= ASYNC_MARKDOWN_THRESHOLD_BYTES;

    try {
      if (isCreateInput(input) && input.dry_run) return this.#dryRunCreate(input, context);
      const names = (await this.#upstream.catalog(context)).resolve({
        requireWrite: true,
        requireAsync: wantsAsync,
      });
      return isCreateInput(input)
        ? await this.#create(input, names, context, wantsAsync)
        : await this.#update(input, names, context, wantsAsync);
    } catch (error) {
      return this.#failure(error, context, isCreateInput(input) ? "create" : input.operation.type);
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
    input: UpdateInput,
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

  #createdReference(value: unknown): { id: string; url?: string } {
    const root = asRecord(value);
    const firstPage = Array.isArray(root?.["pages"])
      ? asRecord((root?.["pages"] as unknown[])[0])
      : undefined;
    const page = firstPage ?? asRecord(root?.["page"]) ?? root;
    const url = typeof page?.["url"] === "string" ? page["url"] : undefined;
    const idValue = page?.["id"] ?? page?.["page_id"];
    const id = typeof idValue === "string" ? idValue : url ? pageIdFromUrl(url) : undefined;
    if (!id) throw new OpsError("upstream_incompatible", "create result has no page reference");
    return { id, ...(url ? { url } : {}) };
  }

  #parentArguments(
    parent: Extract<PublishDocumentInput, { markdown: string }>["target"]["parent"],
  ): JsonObject {
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

  #published(
    status: "success" | "already_applied",
    page: PageSnapshot,
    operation: PublishOperation["type"] | "create",
    created: boolean,
    autoRebased: boolean,
    context: OperationContext,
  ): PublishedResult {
    return {
      status,
      page_id: page.id,
      url: page.url,
      created,
      operation,
      auto_rebased: autoRebased,
      verification: "verified",
      revision: currentRevision(page),
      summary: this.#summary(context, operation, created, autoRebased, "verified", page),
    };
  }

  #failure(
    error: unknown,
    context: OperationContext,
    operation: PublishOperation["type"] | "create",
  ): PublishDocumentResult {
    const normalized = isOpsError(error)
      ? error
      : new OpsError("failed", "publish operation failed");
    if (normalized.code === "not_found") {
      return {
        status: "not_found",
        summary: this.#summary(context, operation, false, false, "not_run"),
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
      summary: this.#summary(context, operation, false, false, "not_run"),
    };
  }

  #invalidInput(): PublishDocumentResult {
    return {
      status: "failed",
      reason: "invalid_input",
      summary: {
        operation: "publish",
        executed_operation: "create",
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
    operation: PublishOperation["type"] | "create",
    created: boolean,
    autoRebased: boolean,
    verification: "verified" | "not_run" | "failed",
    page?: PageSnapshot,
  ): PublishSummary {
    return {
      operation: "publish",
      executed_operation: operation,
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
