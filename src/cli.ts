#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { AuthManager } from "./auth/manager.js";
import { loadRuntimeConfig } from "./config.js";
import { SafeLogger } from "./logger.js";
import { createNotionOpsServer } from "./server.js";
import { PublishDocumentService } from "./tools/publish-document.js";
import { ReadDocumentService } from "./tools/read-document.js";
import { OperationContext } from "./upstream/context.js";
import { McpUpstreamClient } from "./upstream/mcp-client.js";

async function main(): Promise<void> {
  const logger = new SafeLogger();
  if (process.argv.length > 2) {
    logger.error("invalid_cli_arguments", { count: process.argv.length - 2 });
    process.exitCode = 2;
    return;
  }

  const { upstreamEndpoint } = loadRuntimeConfig();
  const auth = new AuthManager({ endpoint: upstreamEndpoint, logger });
  const upstream = new McpUpstreamClient({ endpoint: upstreamEndpoint, tokenSource: auth });
  const server = createNotionOpsServer(
    {
      readDocument: new ReadDocumentService(upstream),
      publishDocument: new PublishDocumentService(upstream),
    },
    logger,
  );
  const transport = new StdioServerTransport();
  let closing: Promise<void> | undefined;

  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = Promise.allSettled([server.close(), upstream.close(), auth.close()]).then(
      () => undefined,
    );
    return closing;
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void close().finally(() => {
        process.exitCode = 0;
      });
    });
  }
  process.stdin.once("end", () => void close());

  await server.connect(transport);
  logger.info("server_started", { transport: "stdio" });
  const warmContext = new OperationContext("read");
  void upstream
    .warm(warmContext)
    .then((warmed) => {
      logger.info("upstream_warmup_completed", { warmed });
    })
    .catch((error: unknown) => {
      logger.error("upstream_warmup_failed", {
        error_type: error instanceof Error ? error.name : "unknown",
      });
    });
}

main().catch((error: unknown) => {
  const logger = new SafeLogger();
  logger.error("server_failed", {
    error_type: error instanceof Error ? error.name : "unknown",
  });
  process.exitCode = 1;
});
