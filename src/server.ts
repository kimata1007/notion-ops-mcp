import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { SafeLogger } from "./logger.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./package.js";
import type { PublishDocumentResult, PublishDocumentService } from "./tools/publish-document.js";
import type { ReadDocumentResult, ReadDocumentService } from "./tools/read-document.js";
import { PublishDocumentToolInputSchema, ReadDocumentToolInputSchema } from "./tools/schemas.js";

export const SERVER_INSTRUCTIONS =
  "Use this server's notion_read_document and notion_publish_document tools for Notion page operations instead of raw Notion tools or a generic Notion plugin. Each tool completes target resolution and its dependent upstream calls without returning control to the model. For page selectors, pass exactly one of page_id, url, or query; type is optional and inferred. Read before updates and pass the returned base_revision when concurrent edits matter. Never guess among ambiguous search results. Batch independent work whenever possible.";

export interface NotionOpsServices {
  readDocument: Pick<ReadDocumentService, "execute">;
  publishDocument: Pick<PublishDocumentService, "execute">;
}

function compactResult(result: ReadDocumentResult | PublishDocumentResult): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
  };
}

function logCompletion(
  logger: SafeLogger | undefined,
  tool: string,
  result: ReadDocumentResult | PublishDocumentResult,
): void {
  logger?.info("tool_completed", {
    tool,
    status: result.status,
    operation: result.summary.operation,
    upstream_tool_calls: result.summary.upstream_tool_calls,
    retries: result.summary.retries,
    wall_time_ms: result.summary.wall_time_ms,
  });
}

export function createNotionOpsServer(services: NotionOpsServices, logger?: SafeLogger): McpServer {
  const server = new McpServer(
    { name: PACKAGE_NAME, version: PACKAGE_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    "notion_read_document",
    {
      title: "Read Notion document",
      description:
        "Resolve and fetch one or up to eight Notion pages by page_id, url, or unambiguous query, returning Markdown and revisions in one model-facing operation. Selector type is optional when its key is unambiguous.",
      inputSchema: ReadDocumentToolInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input, extra) => {
      const result = await services.readDocument.execute(input, extra.signal);
      logCompletion(logger, "notion_read_document", result);
      return compactResult(result);
    },
  );

  server.registerTool(
    "notion_publish_document",
    {
      title: "Publish Notion document",
      description:
        "Create one or more Notion documents, or conflict-safely apply one or more edits to a document with bounded rebasing and post-write verification in one model-facing operation. Selector type is optional when its key is unambiguous.",
      inputSchema: PublishDocumentToolInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input, extra) => {
      const result = await services.publishDocument.execute(input, extra.signal);
      logCompletion(logger, "notion_publish_document", result);
      return compactResult(result);
    },
  );

  return server;
}
