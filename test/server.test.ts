import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SafeLogger } from "../src/logger.js";
import { createNotionOpsServer } from "../src/server.js";

const closeables: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.allSettled(closeables.splice(0).map((item) => item.close()));
});

describe("notion-ops MCP server", () => {
  it("initializes, exposes only two composite tools, and returns one compact result", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const logs: string[] = [];
    const readDocument = vi.fn(async () => ({
      status: "not_found" as const,
      summary: {
        operation: "read" as const,
        upstream_tool_calls: 1,
        retries: 0,
        wall_time_ms: 3,
      },
    }));
    const server = createNotionOpsServer(
      {
        readDocument: { execute: readDocument },
        publishDocument: {
          execute: vi.fn(async () => ({
            status: "not_found" as const,
            summary: {
              operation: "publish" as const,
              executed_operation: "append" as const,
              operation_count: 1,
              created: false,
              auto_rebased: false,
              verification: "not_run" as const,
              upstream_tool_calls: 1,
              retries: 0,
              wall_time_ms: 2,
            },
          })),
        },
      },
      new SafeLogger((line) => logs.push(line)),
    );
    const client = new Client({ name: "test-client", version: "1.0.0" });
    closeables.push(server, client);

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "notion_read_document",
      "notion_publish_document",
    ]);

    const result = await client.callTool({
      name: "notion_read_document",
      arguments: { source: { type: "search", query: "missing" } },
    });
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          status: "not_found",
          summary: { operation: "read", upstream_tool_calls: 1, retries: 0, wall_time_ms: 3 },
        }),
      },
    ]);
    expect(result.structuredContent).toBeUndefined();
    expect(readDocument).toHaveBeenCalledOnce();
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toContain("missing");
  });
});
