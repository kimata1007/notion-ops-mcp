import { afterEach, describe, expect, it } from "vitest";

import { ReadDocumentService } from "../../src/tools/read-document.js";
import { McpUpstreamClient } from "../../src/upstream/mcp-client.js";
import { FakeNotionMcp } from "../support/fake-notion-mcp.js";

const clients: McpUpstreamClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

function service(fake: FakeNotionMcp): ReadDocumentService {
  const client = new McpUpstreamClient({
    endpoint: new URL("http://127.0.0.1/mcp"),
    tokenSource: { getAccessToken: async () => "fake-token" },
    transportFactory: fake.transportFactory,
  });
  clients.push(client);
  return new ReadDocumentService(client);
}

describe("notion_read_document", () => {
  it("fetches an ID directly without an unnecessary search", async () => {
    const fake = new FakeNotionMcp();
    const page = fake.addPage({ title: "Runbook", markdown: "# Runbook\n\nSafe steps" });

    const result = await service(fake).execute({
      source: { type: "page_id", page_id: page.id },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.page).toMatchObject({
      id: page.id,
      title: page.title,
      markdown: page.markdown,
      truncated: false,
    });
    expect(result.revision.content_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.summary.upstream_tool_calls).toBe(1);
    expect(fake.calls.map((call) => call.name)).toEqual(["notion-fetch"]);
  });

  it("infers a page ID selector type when the model omits it", async () => {
    const fake = new FakeNotionMcp();
    const page = fake.addPage({ title: "Runbook", markdown: "Safe steps" });

    const result = await service(fake).execute({ source: { page_id: page.id } });

    expect(result.status).toBe("success");
    expect(fake.calls.map((call) => call.name)).toEqual(["notion-fetch"]);
  });

  it("rejects a selector whose explicit type conflicts with its key", async () => {
    const fake = new FakeNotionMcp();

    const result = await service(fake).execute({
      source: { type: "url", page_id: "11111111-1111-4111-8111-111111111111" },
    });

    expect(result).toMatchObject({ status: "failed", reason: "invalid_input" });
    expect(fake.calls).toHaveLength(0);
  });

  it("combines a unique search and fetch in one operation", async () => {
    const fake = new FakeNotionMcp();
    const page = fake.addPage({ title: "Unique handbook", markdown: "Welcome" });

    const result = await service(fake).execute({
      source: { type: "search", query: "Unique handbook" },
    });

    expect(result.status).toBe("success");
    expect(result.summary.upstream_tool_calls).toBe(2);
    expect(fake.calls.map((call) => call.name)).toEqual(["notion-search", "notion-fetch"]);
    if (result.status === "success") expect(result.page.id).toBe(page.id);
  });

  it("prefers one exact title over additional fuzzy search candidates", async () => {
    const fake = new FakeNotionMcp();
    const exact = fake.addPage({ title: "Release plan", markdown: "Current" });
    fake.addPage({ title: "Release plan archive", markdown: "Archived" });

    const result = await service(fake).execute({ source: { query: "Release plan" } });

    expect(result.status).toBe("success");
    if (result.status === "success") expect(result.page.id).toBe(exact.id);
    expect(fake.calls.map((call) => call.name)).toEqual(["notion-search", "notion-fetch"]);
  });

  it("does not fetch or guess when search is ambiguous", async () => {
    const fake = new FakeNotionMcp();
    fake.addPage({ title: "Weekly notes A", markdown: "A" });
    fake.addPage({ title: "Weekly notes B", markdown: "B" });

    const result = await service(fake).execute({
      source: { type: "search", query: "Weekly notes" },
    });

    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") expect(result.candidates).toHaveLength(2);
    expect(fake.calls.map((call) => call.name)).toEqual(["notion-search"]);
  });

  it("returns not_found for zero candidates", async () => {
    const fake = new FakeNotionMcp();

    const result = await service(fake).execute({
      source: { type: "search", query: "missing" },
    });

    expect(result.status).toBe("not_found");
    expect(fake.calls.map((call) => call.name)).toEqual(["notion-search"]);
  });

  it("truncates at a valid UTF-8 boundary and reports original bytes", async () => {
    const fake = new FakeNotionMcp();
    const markdown = "文".repeat(600);
    const page = fake.addPage({ title: "Large", markdown });

    const result = await service(fake).execute({
      source: { type: "page_id", page_id: page.id },
      max_output_bytes: 1024,
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(Buffer.byteLength(result.page.markdown, "utf8")).toBeLessThanOrEqual(1024);
    expect(result.page.markdown).not.toContain("�");
    expect(result.page).toMatchObject({ truncated: true, original_bytes: 1800 });
  });

  it("strictly rejects unknown input fields before calling upstream", async () => {
    const fake = new FakeNotionMcp();
    const result = await service(fake).execute({
      source: { type: "search", query: "anything", extra: true },
    });

    expect(result).toMatchObject({ status: "failed", reason: "invalid_input" });
    expect(fake.calls).toHaveLength(0);
  });

  it("reads multiple explicit documents in one model-facing call", async () => {
    const fake = new FakeNotionMcp();
    const first = fake.addPage({ title: "First", markdown: "first body" });
    const second = fake.addPage({ title: "Second", markdown: "second body" });

    const result = await service(fake).execute({
      sources: [
        { type: "page_id", page_id: first.id },
        { type: "url", url: second.url },
      ],
    });

    expect(result.status).toBe("batch");
    if (result.status !== "batch") throw new Error("expected batch result");
    expect(result.results.map(({ result: item }) => item.status)).toEqual(["success", "success"]);
    expect(result.summary).toMatchObject({
      requested_count: 2,
      success_count: 2,
      upstream_tool_calls: 2,
    });
    expect(fake.calls.map((call) => call.name)).toEqual(["notion-fetch", "notion-fetch"]);
  });

  it("keeps batch order and reports ambiguous and missing items independently", async () => {
    const fake = new FakeNotionMcp();
    fake.addPage({ title: "Plan A", markdown: "A" });
    fake.addPage({ title: "Plan B", markdown: "B" });

    const result = await service(fake).execute({
      sources: [
        { type: "search", query: "Plan" },
        { type: "search", query: "Missing" },
      ],
    });

    expect(result.status).toBe("batch");
    if (result.status !== "batch") throw new Error("expected batch result");
    expect(result.results.map(({ result: item }) => item.status)).toEqual([
      "ambiguous",
      "not_found",
    ]);
    expect(result.summary).toMatchObject({ ambiguous_count: 1, not_found_count: 1 });
  });

  it("shares the total output budget fairly across a batch", async () => {
    const fake = new FakeNotionMcp();
    const first = fake.addPage({ title: "First", markdown: "文".repeat(400) });
    const second = fake.addPage({ title: "Second", markdown: "字".repeat(400) });

    const result = await service(fake).execute({
      sources: [
        { type: "page_id", page_id: first.id },
        { type: "page_id", page_id: second.id },
      ],
      max_output_bytes: 1024,
    });

    if (result.status !== "batch") throw new Error("expected batch result");
    const outputBytes = result.results.reduce(
      (total, { result: item }) =>
        total + (item.status === "success" ? Buffer.byteLength(item.page.markdown, "utf8") : 0),
      0,
    );
    expect(outputBytes).toBeLessThanOrEqual(1024);
  });
});
