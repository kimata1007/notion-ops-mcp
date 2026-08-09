import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { SafeLogger } from "./logger.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./package.js";
import type { PublishDocumentResult, PublishDocumentService } from "./tools/publish-document.js";
import type { ReadDocumentResult, ReadDocumentService } from "./tools/read-document.js";
import { PublishDocumentToolInputSchema, ReadDocumentToolInputSchema } from "./tools/schemas.js";

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
  const server = new McpServer({ name: PACKAGE_NAME, version: PACKAGE_VERSION });

  server.registerTool(
    "notion_read_document",
    {
      title: "Read Notion document",
      description:
        "Resolve and fetch one or up to eight Notion pages by ID, URL, or unambiguous search, returning Markdown and revisions in one operation.",
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
        "Create one or more Notion documents, or conflict-safely apply one or more edits to a document with bounded rebasing and post-write verification.",
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
