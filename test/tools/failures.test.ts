import { afterEach, describe, expect, it, vi } from "vitest";

import { PublishDocumentService } from "../../src/tools/publish-document.js";
import { ReadDocumentService } from "../../src/tools/read-document.js";
import { McpUpstreamClient, type AccessTokenSource } from "../../src/upstream/mcp-client.js";
import { FakeNotionMcp } from "../support/fake-notion-mcp.js";

const PARENT_ID = "11111111-1111-4111-8111-111111111111";
const clients: McpUpstreamClient[] = [];

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
});

function createServices(fake: FakeNotionMcp, tokenSource?: AccessTokenSource) {
  const client = new McpUpstreamClient({
    endpoint: new URL("http://127.0.0.1/mcp"),
    tokenSource: tokenSource ?? { getAccessToken: async () => "fake-token" },
    transportFactory: fake.transportFactory,
  });
  clients.push(client);
  return {
    read: new ReadDocumentService(client),
    publish: new PublishDocumentService(client),
  };
}

describe("upstream failure integration", () => {
  it("retries a rate-limited read once through the MCP boundary", async () => {
    const fake = new FakeNotionMcp();
    const page = fake.addPage({ title: "Runbook", markdown: "body" });
    fake.queueError("notion-fetch", { status: 429, code: "rate_limited", retry_after: 0 });

    const result = await createServices(fake).read.execute({
      source: { type: "page_id", page_id: page.id },
    });

    expect(result).toMatchObject({
      status: "success",
      summary: { upstream_tool_calls: 2, retries: 1 },
    });
  });

  it("normalizes 401 and invalidates the local OAuth credential", async () => {
    const fake = new FakeNotionMcp();
    const page = fake.addPage({ title: "Private", markdown: "secret body" });
    fake.queueError("notion-fetch", { status: 401, code: "unauthorized" });
    const handleUnauthorized = vi.fn(async () => undefined);
    const tokenSource = { getAccessToken: async () => "fake-token", handleUnauthorized };

    const result = await createServices(fake, tokenSource).read.execute({
      source: { type: "page_id", page_id: page.id },
    });

    expect(result).toMatchObject({ status: "auth_required", reason: "auth_required" });
    expect(handleUnauthorized).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("secret body");
  });

  it("stops an upstream call at the request deadline", async () => {
    const fake = new FakeNotionMcp();
    const page = fake.addPage({ title: "Slow", markdown: "body" });
    fake.beforeCall = async (call) => {
      if (call.name === "notion-fetch") {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };

    const result = await createServices(fake).read.execute({
      source: { type: "page_id", page_id: page.id },
      timeout_ms: 10,
    });

    expect(result).toMatchObject({ status: "failed", reason: "timeout" });
  });

  it("propagates caller cancellation to an upstream call", async () => {
    const fake = new FakeNotionMcp();
    const page = fake.addPage({ title: "Cancelled", markdown: "body" });
    fake.beforeCall = async (call) => {
      if (call.name === "notion-fetch") {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    const result = await createServices(fake).read.execute(
      { source: { type: "page_id", page_id: page.id } },
      controller.signal,
    );

    expect(result).toMatchObject({ status: "failed", reason: "cancelled" });
  });

  it("fails closed when a required upstream tool is missing", async () => {
    const fake = new FakeNotionMcp();
    fake.omittedTools.add("notion-fetch");

    const result = await createServices(fake).read.execute({
      source: { type: "search", query: "anything" },
    });

    expect(result).toMatchObject({ status: "failed", reason: "upstream_incompatible" });
    expect(fake.calls).toHaveLength(0);
  });

  it("does not report success when an official async task fails", async () => {
    const fake = new FakeNotionMcp();
    fake.asyncWrites = true;
    fake.asyncTasksFail = true;
    const markdown = `# Large\n\n${"x".repeat(130 * 1024)}`;

    const result = await createServices(fake).publish.execute({
      target: {
        type: "create",
        parent: { type: "page_id", page_id: PARENT_ID },
        title: "Large failure",
      },
      markdown,
    });

    expect(result).toMatchObject({ status: "failed", reason: "failed" });
    expect(fake.calls.map((call) => call.name)).toEqual([
      "notion-create-pages",
      "notion-get-async-task",
    ]);
  });

  it("bounds rebasing when concurrent edits never converge", async () => {
    const fake = new FakeNotionMcp();
    const page = fake.addPage({ title: "Guide", markdown: "# Target\n\nBody" });
    let updateCount = 0;
    fake.beforeCall = (call, state) => {
      if (call.name !== "notion-update-page") return;
      updateCount += 1;
      state.editPage(page.id, (markdown) =>
        updateCount % 2 === 1
          ? markdown.replace("# Target", "#  Target")
          : markdown.replace("#  Target", "# Target"),
      );
    };

    const result = await createServices(fake).publish.execute({
      target: { type: "page_id", page_id: page.id },
      operation: {
        type: "insert_after",
        anchor: { kind: "heading", text: "Target" },
        markdown: "Inserted",
      },
      conflict_policy: "auto_rebase",
    });

    expect(result).toMatchObject({
      status: "conflict",
      reason: "concurrent_change",
      summary: { auto_rebased: true },
    });
    expect(updateCount).toBe(3);
    expect(fake.pages.get(page.id)?.markdown).not.toContain("Inserted");
  });
});
