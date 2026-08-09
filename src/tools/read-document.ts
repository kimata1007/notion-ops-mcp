import { DEFAULT_OUTPUT_BYTES, DEFAULT_SEARCH_CANDIDATES } from "../constants.js";
import { createRevision, type Revision } from "../domain/revision.js";
import { truncateUtf8 } from "../domain/utf8.js";
import { isOpsError, OpsError } from "../errors.js";
import {
  normalizeFetchResult,
  normalizeSearchResult,
  type PageSnapshot,
  type SearchCandidate,
} from "../notion/normalize.js";
import { OperationContext } from "../upstream/context.js";
import type { McpUpstreamClient } from "../upstream/mcp-client.js";
import { ReadDocumentInputSchema, type ReadDocumentInput } from "./schemas.js";

interface Summary {
  operation: "read";
  upstream_tool_calls: number;
  retries: number;
  wall_time_ms: number;
  target?: { id: string; url: string };
}

export type ReadDocumentResult =
  | {
      status: "success";
      page: {
        id: string;
        url: string;
        title: string;
        markdown: string;
        truncated: boolean;
        upstream_truncated: boolean;
        original_bytes: number;
      };
      revision: Revision & { last_edited_time_source: "page" | "snapshot" };
      summary: Summary;
    }
  | { status: "not_found"; summary: Summary }
  | {
      status: "ambiguous";
      candidates: SearchCandidate[];
      candidate_count: number;
      summary: Summary;
    }
  | {
      status: "auth_required" | "rate_limited" | "failed";
      reason: string;
      retry_after_ms?: number;
      authorization_url?: string;
      summary: Summary;
    };

export class ReadDocumentService {
  readonly #upstream: McpUpstreamClient;

  constructor(upstream: McpUpstreamClient) {
    this.#upstream = upstream;
  }

  async execute(inputValue: unknown, signal?: AbortSignal): Promise<ReadDocumentResult> {
    const parsed = ReadDocumentInputSchema.safeParse(inputValue);
    if (!parsed.success) {
      return {
        status: "failed",
        reason: "invalid_input",
        summary: this.#summary(new OperationContext("read", { timeoutMs: 1 })),
      };
    }
    const input = parsed.data;
    const context = new OperationContext("read", {
      ...(input.timeout_ms === undefined ? {} : { timeoutMs: input.timeout_ms }),
      ...(signal ? { signal } : {}),
    });

    try {
      const names = (await this.#upstream.catalog(context)).resolve({ requireWrite: false });
      let target: { id: string; url?: string };
      if (input.source.type === "search") {
        const searched = await this.#upstream.callTool(
          names.search,
          { query: input.source.query },
          "read",
          context,
        );
        const candidates = normalizeSearchResult(searched.value, DEFAULT_SEARCH_CANDIDATES);
        if (candidates.length === 0)
          return { status: "not_found", summary: this.#summary(context) };
        if (candidates.length > 1) {
          return {
            status: "ambiguous",
            candidates,
            candidate_count: candidates.length,
            summary: this.#summary(context),
          };
        }
        const candidate = candidates[0];
        if (!candidate) throw new OpsError("failed", "resolved search candidate disappeared");
        target = candidate;
      } else if (input.source.type === "page_id") {
        target = { id: input.source.page_id };
      } else {
        target = { id: input.source.url, url: input.source.url };
      }

      const fetched = await this.#upstream.callTool(
        names.fetch,
        { id: target.url ?? target.id },
        "read",
        context,
      );
      const page = normalizeFetchResult(fetched.value);
      return this.#success(page, input, context);
    } catch (error) {
      return this.#failure(error, context);
    }
  }

  #success(
    page: PageSnapshot,
    input: ReadDocumentInput,
    context: OperationContext,
  ): ReadDocumentResult {
    const limited = truncateUtf8(page.markdown, input.max_output_bytes ?? DEFAULT_OUTPUT_BYTES);
    const revision = createRevision(page.markdown, page.lastEditedTime);
    return {
      status: "success",
      page: {
        id: page.id,
        url: page.url,
        title: page.title,
        markdown: limited.text,
        truncated: limited.truncated,
        upstream_truncated: page.upstreamTruncated,
        original_bytes: limited.originalBytes,
      },
      revision: { ...revision, last_edited_time_source: page.lastEditedTimeSource },
      summary: this.#summary(context, page),
    };
  }

  #failure(error: unknown, context: OperationContext): ReadDocumentResult {
    const normalized = isOpsError(error) ? error : new OpsError("failed", "read operation failed");
    if (normalized.code === "not_found") {
      return { status: "not_found", summary: this.#summary(context) };
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
      summary: this.#summary(context),
    };
  }

  #summary(context: OperationContext, page?: PageSnapshot): Summary {
    return {
      operation: "read",
      upstream_tool_calls: context.metrics.upstreamToolCalls,
      retries: context.metrics.retries,
      wall_time_ms: context.wallTimeMs(),
      ...(page ? { target: { id: page.id, url: page.url } } : {}),
    };
  }
}
