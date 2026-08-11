import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SafeLogger } from "../src/logger.js";
import { createNotionOpsServer, SERVER_INSTRUCTIONS } from "../src/server.js";

const closeables: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.allSettled(closeables.splice(0).map((item) => item.close()));
});

describe("notion-ops MCP server", () => {
  it("initializes, exposes only two composite tools, and returns one compact result", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const logs: string[] = [];
    const readDocument = vi.fn(async (_input: unknown, _signal?: AbortSignal) => ({
      status: "not_found" as const,
      summary: {
        operation: "read" as const,
        upstream_tool_calls: 1,
        retries: 0,
        wall_time_ms: 3,
      },
    }));
    const publishDocument = vi.fn(async (_input: unknown, _signal?: AbortSignal) => ({
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
    }));
    const server = createNotionOpsServer(
      {
        readDocument: { execute: readDocument },
        publishDocument: { execute: publishDocument },
      },
      new SafeLogger((line) => logs.push(line)),
    );
    const client = new Client({ name: "test-client", version: "1.0.0" });
    closeables.push(server, client);

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    expect(client.getInstructions()?.slice(0, 512)).toContain("instead of raw Notion tools");
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "notion_read_document",
      "notion_publish_document",
    ]);
    const readSchema = listed.tools.find((tool) => tool.name === "notion_read_document")
      ?.inputSchema as { properties?: Record<string, unknown> };
    const publishSchema = listed.tools.find((tool) => tool.name === "notion_publish_document")
      ?.inputSchema as { properties?: Record<string, unknown> };
    expect(Object.keys(readSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["source", "sources", "max_output_bytes", "timeout_ms"]),
    );
    expect(Object.keys(publishSchema.properties ?? {})).toEqual(
      expect.arrayContaining([
        "target",
        "markdown",
        "pages",
        "operation",
        "operations",
        "base_revision",
        "conflict_policy",
        "dry_run",
        "timeout_ms",
      ]),
    );
    expect(readSchema.properties?.["source"]).toMatchObject({ anyOf: expect.any(Array) });
    const sourceAlternatives = (
      readSchema.properties?.["source"] as { anyOf?: Array<{ required?: string[] }> }
    ).anyOf;
    expect(sourceAlternatives).toHaveLength(3);
    expect(
      sourceAlternatives?.every((alternative) => !alternative.required?.includes("type")),
    ).toBe(true);
    expect(publishSchema.properties?.["target"]).toMatchObject({ anyOf: expect.any(Array) });
    expect(publishSchema.properties?.["operation"]).toMatchObject({
      anyOf: expect.any(Array),
    });

    const result = await client.callTool({
      name: "notion_read_document",
      arguments: {
        source: { page_id: "11111111-1111-4111-8111-111111111111" },
      },
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
    expect(readDocument.mock.calls[0]?.[0]).toEqual({
      source: {
        type: "page_id",
        page_id: "11111111-1111-4111-8111-111111111111",
      },
    });

    const published = await client.callTool({
      name: "notion_publish_document",
      arguments: {
        target: {
          page_id: "11111111-1111-4111-8111-111111111111",
        },
        operation: { type: "append", markdown: "requested" },
      },
    });
    expect(published.isError).not.toBe(true);
    expect(publishDocument).toHaveBeenCalledOnce();
    expect(publishDocument.mock.calls[0]?.[0]).toEqual({
      target: {
        type: "page_id",
        page_id: "11111111-1111-4111-8111-111111111111",
      },
      operation: { type: "append", markdown: "requested" },
    });
    expect(logs).toHaveLength(2);
    expect(logs.join("\n")).not.toContain("missing");
    expect(logs.join("\n")).not.toContain("requested");
  });
});
