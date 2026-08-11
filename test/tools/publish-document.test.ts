import { afterEach, describe, expect, it } from "vitest";

import { ReadDocumentService } from "../../src/tools/read-document.js";
import { PublishDocumentService } from "../../src/tools/publish-document.js";
import { McpUpstreamClient } from "../../src/upstream/mcp-client.js";
import { FakeNotionMcp } from "../support/fake-notion-mcp.js";

const PARENT_ID = "11111111-1111-4111-8111-111111111111";
const clients: McpUpstreamClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

function services(fake: FakeNotionMcp): {
  read: ReadDocumentService;
  publish: PublishDocumentService;
} {
  const client = new McpUpstreamClient({
    endpoint: new URL("http://127.0.0.1/mcp"),
    tokenSource: { getAccessToken: async () => "fake-token" },
    transportFactory: fake.transportFactory,
  });
  clients.push(client);
  return { read: new ReadDocumentService(client), publish: new PublishDocumentService(client) };
}

describe("notion_publish_document", () => {
  it("creates a page and verifies it by fetching the latest version", async () => {
    const fake = new FakeNotionMcp();
    const { publish } = services(fake);

    const result = await publish.execute({
      target: {
        type: "create",
        parent: { type: "page_id", page_id: PARENT_ID },
        title: "Release plan",
      },
      markdown: "# Release plan\n\nShip safely.",
    });

    expect(result).toMatchObject({
      status: "success",
      created: true,
      operation: "create",
      verification: "verified",
    });
    expect(fake.calls.map((call) => call.name)).toEqual(["notion-create-pages", "notion-fetch"]);
  });

  it("creates a private workspace page when parent is omitted", async () => {
    const fake = new FakeNotionMcp();
    const { publish } = services(fake);

    const result = await publish.execute({
      target: { type: "create", title: "Private acceptance page" },
      markdown: "# Private acceptance page\n\nSafe test content.",
    });

    expect(result).toMatchObject({ status: "success", created: true, verification: "verified" });
    expect(fake.calls[0]).toMatchObject({ name: "notion-create-pages" });
    expect(fake.calls[0]?.arguments).not.toHaveProperty("parent");
  });

  it("returns an explicit create dry-run without authenticating or writing", async () => {
    const fake = new FakeNotionMcp();
    const { publish } = services(fake);
    const result = await publish.execute({
      target: {
        type: "create",
        parent: { type: "page_id", page_id: PARENT_ID },
        title: "Preview",
      },
      markdown: "Preview body",
      dry_run: true,
    });

    expect(result).toMatchObject({
      status: "dry_run",
      plan: { operation: "create", added_bytes: 12, removed_bytes: 0 },
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("infers existing target and parent selector types", async () => {
    const fake = new FakeNotionMcp();
    const page = fake.addPage({ title: "Doc", markdown: "body" });
    const { publish } = services(fake);

    const updated = await publish.execute({
      target: { page_id: page.id },
      operation: { type: "append", markdown: "tail" },
      dry_run: true,
    });
    const created = await publish.execute({
      target: {
        type: "create",
        parent: { page_id: PARENT_ID },
        title: "Preview",
      },
      markdown: "body",
      dry_run: true,
    });

    expect(updated.status).toBe("dry_run");
    expect(created.status).toBe("dry_run");
    expect(fake.calls.map((call) => call.name)).toEqual(["notion-fetch"]);
  });

  it("creates multiple pages in one upstream write and verifies each page", async () => {
    const fake = new FakeNotionMcp();
    const { publish } = services(fake);

    const result = await publish.execute({
      target: {
        type: "create_batch",
        parent: { type: "page_id", page_id: PARENT_ID },
      },
      pages: [
        { title: "Plan A", markdown: "# Plan A\n\nAlpha" },
        { title: "Plan B", markdown: "# Plan B\n\nBeta" },
      ],
    });

    expect(result).toMatchObject({
      status: "success",
      operation: "create_batch",
      created_count: 2,
      verified_count: 2,
      summary: { operation_count: 2, upstream_tool_calls: 3 },
    });
    expect(fake.calls.map((call) => call.name)).toEqual([
      "notion-create-pages",
      "notion-fetch",
      "notion-fetch",
    ]);
    expect(fake.calls[0]?.arguments["pages"]).toHaveLength(2);
  });

  it("creates multiple private workspace pages when parent is omitted", async () => {
    const fake = new FakeNotionMcp();
    const { publish } = services(fake);

    const result = await publish.execute({
      target: { type: "create_batch" },
      pages: [
        { title: "Private A", markdown: "Alpha" },
        { title: "Private B", markdown: "Beta" },
      ],
    });

    expect(result).toMatchObject({ status: "success", created_count: 2, verified_count: 2 });
    expect(fake.calls[0]?.arguments).not.toHaveProperty("parent");
  });

  it("returns a batch create dry-run without authenticating or writing", async () => {
    const fake = new FakeNotionMcp();
    const { publish } = services(fake);

    const result = await publish.execute({
      target: {
        type: "create_batch",
        parent: { type: "page_id", page_id: PARENT_ID },
      },
      pages: [
        { title: "A", markdown: "Alpha" },
        { title: "B", markdown: "Beta" },
      ],
      dry_run: true,
    });

    expect(result).toMatchObject({
      status: "dry_run",
      plan: { operation: "create_batch", added_bytes: 9, removed_bytes: 0 },
      summary: { operation_count: 2 },
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("preserves a user prepend and auto-rebases a unique whole-line replacement", async () => {
    const fake = new FakeNotionMcp();
    const page = fake.addPage({
      title: "Runbook",
      markdown: "# Runbook\n\nTarget paragraph\n\n## Other\n\nKeep me",
    });
    const { read, publish } = services(fake);
    const readResult = await read.execute({ source: { type: "page_id", page_id: page.id } });
    if (readResult.status !== "success") throw new Error("expected read success");
    fake.editPage(page.id, (markdown) => `User preface\n\n${markdown}`);
    fake.calls.length = 0;

    const result = await publish.execute({
      target: { type: "page_id", page_id: page.id },
      operation: {
        type: "replace_text",
        old_text: "Target paragraph",
        new_text: "Updated paragraph",
      },
      base_revision: readResult.revision,
      conflict_policy: "auto_rebase",
    });

    expect(result).toMatchObject({
      status: "success",
      auto_rebased: true,
      verification: "verified",
    });
    expect(fake.pages.get(page.id)?.markdown).toBe(
      "User preface\n\n# Runbook\n\nUpdated paragraph\n\n## Other\n\nKeep me",
    );
  });

  it("stops on a changed base under fail_on_change without writing", async () => {
    const fake = new FakeNotionMcp();
    const page = fake.addPage({ title: "Doc", markdown: "old" });
    const { read, publish } = services(fake);
    const readResult = await read.execute({ source: { type: "page_id", page_id: page.id } });
    if (readResult.status !== "success") throw new Error("expected read success");
    fake.editPage(page.id, (markdown) => `${markdown}\nuser`);
    fake.calls.length = 0;

    const result = await publish.execute({
      target: { type: "page_id", page_id: page.id },
      operation: { type: "append", markdown: "requested" },
      base_revision: readResult.revision,
    });

    expect(result).toMatchObject({ status: "conflict", reason: "base_revision_changed" });
    expect(fake.calls.map((call) => call.name)).toEqual(["notion-fetch"]);
  });

  it("never rebases replace_document over a concurrent change", async () => {
    const fake = new FakeNotionMcp();
    const page = fake.addPage({ title: "Doc", markdown: "old" });
    const { read, publish } = services(fake);
    const readResult = await read.execute({ source: { type: "page_id", page_id: page.id } });
    if (readResult.status !== "success") throw new Error("expected read success");
    fake.editPage(page.id, () => "user changed this");
    fake.calls.length = 0;

    const result = await publish.execute({
      target: { type: "page_id", page_id: page.id },
      operation: {
        type: "replace_document",
        markdown: "replacement",
        confirm_replace_document: true,
      },
      base_revision: readResult.revision,
      conflict_policy: "auto_rebase",
    });

    expect(result).toMatchObject({ status: "conflict", reason: "replace_document_changed" });
    expect(fake.pages.get(page.id)?.markdown).toBe("user changed this");
  });

  it("refuses an ambiguous search before any fetch or write", async () => {
    const fake = new FakeNotionMcp();
    fake.addPage({ title: "Plan A", markdown: "A" });
    fake.addPage({ title: "Plan B", markdown: "B" });
    const { publish } = services(fake);

    const result = await publish.execute({
      target: { type: "search", query: "Plan" },
      operation: { type: "append", markdown: "new" },
    });

    expect(result.status).toBe("ambiguous");
    expect(fake.calls.map((call) => call.name)).toEqual(["notion-search"]);
  });

  it("reports already_applied and does not duplicate an append", async () => {
    const fake = new FakeNotionMcp();
    const page = fake.addPage({ title: "Doc", markdown: "body\n\nrequested" });
    const { publish } = services(fake);

    const result = await publish.execute({
      target: { type: "page_id", page_id: page.id },
      operation: { type: "append", markdown: "requested" },
      conflict_policy: "auto_rebase",
    });

    expect(result).toMatchObject({ status: "already_applied", verification: "verified" });
    expect(fake.calls.map((call) => call.name)).toEqual(["notion-fetch"]);
    expect(fake.pages.get(page.id)?.markdown.match(/requested/g)).toHaveLength(1);
  });

  it("combines independent edits into one upstream update", async () => {
    const fake = new FakeNotionMcp();
    const page = fake.addPage({
      title: "Doc",
      markdown: "# Doc\n\nFirst paragraph\n\nSecond paragraph",
    });
    const { publish } = services(fake);

    const result = await publish.execute({
      target: { type: "page_id", page_id: page.id },
      operations: [
        { type: "replace_text", old_text: "First paragraph", new_text: "First updated" },
        { type: "replace_text", old_text: "Second paragraph", new_text: "Second updated" },
      ],
      conflict_policy: "auto_rebase",
    });

    expect(result).toMatchObject({
      status: "success",
      operation: "batch",
      operations: ["replace_text", "replace_text"],
      summary: { operation_count: 2, upstream_tool_calls: 3 },
    });
    const updates = fake.calls.filter((call) => call.name === "notion-update-page");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.arguments["content_updates"]).toHaveLength(2);
    expect(fake.pages.get(page.id)?.markdown).toBe("# Doc\n\nFirst updated\n\nSecond updated");
  });

  it("keeps dependent edits ordered across upstream updates", async () => {
    const fake = new FakeNotionMcp();
    const page = fake.addPage({ title: "Doc", markdown: "First" });
    const { publish } = services(fake);

    const result = await publish.execute({
      target: { type: "page_id", page_id: page.id },
      operations: [
        { type: "replace_text", old_text: "First", new_text: "Middle" },
        { type: "replace_text", old_text: "Middle", new_text: "Last" },
      ],
      conflict_policy: "auto_rebase",
    });

    expect(result).toMatchObject({ status: "success", operation: "batch" });
    expect(fake.calls.filter((call) => call.name === "notion-update-page")).toHaveLength(2);
    expect(fake.pages.get(page.id)?.markdown).toBe("Last");
  });

  it("reports which operation conflicts before writing a sequence", async () => {
    const fake = new FakeNotionMcp();
    const page = fake.addPage({ title: "Doc", markdown: "# Doc\n\nBody" });
    const { publish } = services(fake);

    const result = await publish.execute({
      target: { type: "page_id", page_id: page.id },
      operations: [
        { type: "append", markdown: "Tail" },
        {
          type: "insert_after",
          anchor: { kind: "heading", text: "Missing" },
          markdown: "Unsafe",
        },
      ],
    });

    expect(result).toMatchObject({
      status: "conflict",
      reason: "anchor_missing",
      operation_index: 1,
      summary: { operation_count: 2 },
    });
    expect(fake.calls.filter((call) => call.name === "notion-update-page")).toHaveLength(0);
  });

  it("rejects a replace_document mixed with other operations", async () => {
    const fake = new FakeNotionMcp();
    const page = fake.addPage({ title: "Doc", markdown: "old" });
    const { publish } = services(fake);

    const result = await publish.execute({
      target: { type: "page_id", page_id: page.id },
      operations: [
        { type: "replace_document", markdown: "new", confirm_replace_document: true },
        { type: "append", markdown: "tail" },
      ],
    });

    expect(result).toMatchObject({ status: "failed", reason: "invalid_input" });
    expect(fake.calls).toHaveLength(0);
  });

  it("keeps a concurrent append when applying another append", async () => {
    const fake = new FakeNotionMcp();
    const page = fake.addPage({ title: "Log", markdown: "start" });
    const { publish } = services(fake);
    fake.beforeCall = (call, state) => {
      if (call.name === "notion-update-page") {
        state.editPage(page.id, (markdown) => `${markdown}\n\nuser append`);
      }
    };

    const result = await publish.execute({
      target: { type: "page_id", page_id: page.id },
      operation: { type: "append", markdown: "requested append" },
      conflict_policy: "auto_rebase",
    });

    expect(result.status).toBe("success");
    expect(fake.pages.get(page.id)?.markdown).toBe("start\n\nuser append\n\nrequested append");
  });

  it("classifies both-side edits to the replacement paragraph as a conflict", async () => {
    const fake = new FakeNotionMcp();
    const page = fake.addPage({ title: "Doc", markdown: "# Doc\n\nOriginal paragraph" });
    const { read, publish } = services(fake);
    const readResult = await read.execute({ source: { type: "page_id", page_id: page.id } });
    if (readResult.status !== "success") throw new Error("expected read success");
    fake.editPage(page.id, () => "# Doc\n\nUser changed the original paragraph");

    const result = await publish.execute({
      target: { type: "page_id", page_id: page.id },
      operation: {
        type: "replace_text",
        old_text: "Original paragraph",
        new_text: "Requested paragraph",
      },
      base_revision: readResult.revision,
      conflict_policy: "auto_rebase",
    });

    expect(result).toMatchObject({ status: "conflict", reason: "same_region_changed" });
    expect(fake.calls.filter((call) => call.name === "notion-update-page")).toHaveLength(0);
  });

  it("re-resolves an anchor on the latest version and preserves moved lines", async () => {
    const fake = new FakeNotionMcp();
    const page = fake.addPage({
      title: "Guide",
      markdown: "# Guide\n\n## Target\n\nBody\n\nMoved line",
    });
    const { read, publish } = services(fake);
    const readResult = await read.execute({ source: { type: "page_id", page_id: page.id } });
    if (readResult.status !== "success") throw new Error("expected read success");
    fake.editPage(page.id, () => "Moved line\n\n# Guide\n\n## Target\n\nBody");

    const result = await publish.execute({
      target: { type: "page_id", page_id: page.id },
      operation: {
        type: "insert_after",
        anchor: { kind: "heading", text: "Target" },
        markdown: "Inserted",
      },
      base_revision: readResult.revision,
      conflict_policy: "auto_rebase",
    });

    expect(result).toMatchObject({ status: "success", auto_rebased: true });
    expect(fake.pages.get(page.id)?.markdown).toContain("Moved line");
    expect(fake.pages.get(page.id)?.markdown).toContain("## Target\n\nInserted\n\nBody");
  });

  it("stops when a concurrent edit makes an anchor ambiguous", async () => {
    const fake = new FakeNotionMcp();
    const page = fake.addPage({ title: "Guide", markdown: "# Guide\n\n## Target\n\nBody" });
    const { publish } = services(fake);
    fake.beforeCall = (call, state) => {
      if (call.name === "notion-update-page") {
        state.editPage(page.id, (markdown) => `${markdown}\n\n## Target\n\nConcurrent`);
      }
    };

    const result = await publish.execute({
      target: { type: "page_id", page_id: page.id },
      operation: {
        type: "insert_after",
        anchor: { kind: "heading", text: "Target" },
        markdown: "Inserted",
      },
      conflict_policy: "auto_rebase",
    });

    expect(result).toMatchObject({ status: "conflict", reason: "anchor_ambiguous" });
    expect(fake.pages.get(page.id)?.markdown).not.toContain("Inserted");
  });

  it("polls an official async task for a large write before verification", async () => {
    const fake = new FakeNotionMcp();
    fake.asyncWrites = true;
    const { publish } = services(fake);
    const markdown = `# Large\n\n${"x".repeat(130 * 1024)}`;

    const result = await publish.execute({
      target: {
        type: "create",
        parent: { type: "page_id", page_id: PARENT_ID },
        title: "Large",
      },
      markdown,
    });

    expect(result.status).toBe("success");
    expect(fake.calls.map((call) => call.name)).toEqual([
      "notion-create-pages",
      "notion-get-async-task",
      "notion-fetch",
    ]);
  });

  it("requires explicit confirmation for replace_document", async () => {
    const fake = new FakeNotionMcp();
    const page = fake.addPage({ title: "Doc", markdown: "old" });
    const { publish } = services(fake);

    const result = await publish.execute({
      target: { type: "page_id", page_id: page.id },
      operation: { type: "replace_document", markdown: "new" },
    });

    expect(result).toMatchObject({ status: "failed", reason: "invalid_input" });
    expect(fake.calls).toHaveLength(0);
  });

  it("does not write when the upstream page snapshot is incomplete", async () => {
    const fake = new FakeNotionMcp();
    const page = fake.addPage({ title: "Large page", markdown: "partial" });
    fake.truncatedPages.add(page.id);
    const { publish } = services(fake);

    const result = await publish.execute({
      target: { type: "page_id", page_id: page.id },
      operation: { type: "append", markdown: "unsafe" },
    });

    expect(result).toMatchObject({ status: "conflict", reason: "incomplete_page" });
    expect(fake.calls.map((call) => call.name)).toEqual(["notion-fetch"]);
  });
});
