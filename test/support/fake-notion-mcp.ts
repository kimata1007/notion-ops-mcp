import { randomUUID } from "node:crypto";

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";

import type { JsonObject } from "../../src/upstream/types.js";

export interface FakePage {
  id: string;
  url: string;
  title: string;
  markdown: string;
  last_edited_time: string;
}

export interface FakeCall {
  name: string;
  arguments: JsonObject;
}

function jsonResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

function occurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const index = haystack.indexOf(needle, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + needle.length;
  }
}

export class FakeNotionMcp {
  readonly pages = new Map<string, FakePage>();
  readonly calls: FakeCall[] = [];
  asyncWrites = false;
  beforeCall?: (call: FakeCall, fake: FakeNotionMcp) => void | Promise<void>;
  #clock = 0;
  readonly #tasks = new Map<string, unknown>();

  addPage(input: { id?: string; title: string; markdown: string; url?: string }): FakePage {
    const id = input.id ?? randomUUID();
    const page = {
      id,
      url: input.url ?? `https://www.notion.so/${id.replaceAll("-", "")}`,
      title: input.title,
      markdown: input.markdown,
      last_edited_time: this.#nextEditedTime(),
    };
    this.pages.set(id, page);
    return page;
  }

  editPage(id: string, edit: (markdown: string) => string): void {
    const page = this.pages.get(id);
    if (!page) throw new Error(`unknown fake page: ${id}`);
    page.markdown = edit(page.markdown);
    page.last_edited_time = this.#nextEditedTime();
  }

  transportFactory = async (): Promise<Transport> => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = this.#createServer();
    await server.connect(serverTransport as unknown as Transport);
    return clientTransport as unknown as Transport;
  };

  #createServer(): McpServer {
    const server = new McpServer({ name: "fake-notion-mcp", version: "1.0.0" });

    server.registerTool(
      "notion-search",
      { inputSchema: z.object({ query: z.string() }).strict() },
      async ({ query }) => {
        await this.#record("notion-search", { query });
        const normalized = query.toLocaleLowerCase();
        const results = [...this.pages.values()]
          .filter(
            (page) =>
              page.title.toLocaleLowerCase().includes(normalized) ||
              page.markdown.toLocaleLowerCase().includes(normalized),
          )
          .slice(0, 25)
          .map((page) => ({
            id: page.id,
            title: page.title,
            url: page.url,
            type: "page",
          }));
        return jsonResult({ results });
      },
    );

    server.registerTool(
      "notion-fetch",
      { inputSchema: z.object({ id: z.string() }).strict() },
      async ({ id }) => {
        await this.#record("notion-fetch", { id });
        const page = [...this.pages.values()].find(
          (candidate) => candidate.id === id || candidate.url === id,
        );
        if (!page) {
          return jsonResult({ status: 404, code: "object_not_found" }, true);
        }
        return jsonResult({
          metadata: { type: "page" },
          title: page.title,
          url: page.url,
          text: page.markdown,
          page: { id: page.id, last_edited_time: page.last_edited_time },
        });
      },
    );

    server.registerTool(
      "notion-create-pages",
      {
        inputSchema: z
          .object({
            parent: z.record(z.string(), z.string()),
            pages: z.array(
              z
                .object({
                  properties: z.object({ title: z.string() }).passthrough(),
                  content: z.string(),
                })
                .passthrough(),
            ),
            allow_async: z.boolean().optional(),
          })
          .strict(),
      },
      async ({ parent, pages, allow_async }) => {
        await this.#record("notion-create-pages", { parent, pages, allow_async });
        const created = pages.map((input) =>
          this.addPage({
            title: input.properties.title,
            markdown: input.content,
          }),
        );
        const result = {
          pages: created.map((page) => ({ id: page.id, url: page.url })),
        };
        return this.#writeResult(result, allow_async);
      },
    );

    server.registerTool(
      "notion-update-page",
      {
        inputSchema: z
          .object({
            page_id: z.string(),
            command: z.enum(["update_content", "replace_content", "insert_content"]),
            content_updates: z
              .array(z.object({ old_str: z.string(), new_str: z.string() }).strict())
              .optional(),
            new_str: z.string().optional(),
            content: z.string().optional(),
            position: z
              .object({ type: z.enum(["start", "end"]) })
              .strict()
              .optional(),
            allow_async: z.boolean().optional(),
          })
          .strict(),
      },
      async (input) => {
        await this.#record("notion-update-page", input as JsonObject);
        const page = this.pages.get(input.page_id);
        if (!page) return jsonResult({ status: 404, code: "object_not_found" }, true);

        if (input.command === "update_content") {
          for (const update of input.content_updates ?? []) {
            if (occurrences(page.markdown, update.old_str) !== 1) {
              return jsonResult({ status: 400, code: "validation_error" }, true);
            }
            page.markdown = page.markdown.replace(update.old_str, update.new_str);
          }
        } else if (input.command === "replace_content") {
          if (input.new_str === undefined) {
            return jsonResult({ status: 400, code: "validation_error" }, true);
          }
          page.markdown = input.new_str;
        } else {
          if (input.content === undefined) {
            return jsonResult({ status: 400, code: "validation_error" }, true);
          }
          page.markdown =
            input.position?.type === "start"
              ? `${input.content}\n\n${page.markdown}`
              : `${page.markdown}\n\n${input.content}`;
        }
        page.last_edited_time = this.#nextEditedTime();
        return this.#writeResult({ id: page.id, url: page.url }, input.allow_async);
      },
    );

    server.registerTool(
      "notion-get-async-task",
      { inputSchema: z.object({ task_id: z.string() }).strict() },
      async ({ task_id }) => {
        await this.#record("notion-get-async-task", { task_id });
        const result = this.#tasks.get(task_id);
        return result === undefined
          ? jsonResult({ object: "async_task", id: task_id, status: "failed" })
          : jsonResult({ object: "async_task", id: task_id, status: "succeeded", result });
      },
    );
    return server;
  }

  async #record(name: string, arguments_: JsonObject): Promise<void> {
    const call = { name, arguments: arguments_ };
    this.calls.push(call);
    await this.beforeCall?.(call, this);
  }

  #writeResult(result: unknown, allowAsync: boolean | undefined) {
    if (!this.asyncWrites || !allowAsync) return jsonResult(result);
    const taskId = `task_${this.#tasks.size + 1}`;
    this.#tasks.set(taskId, result);
    return jsonResult({
      object: "async_task",
      id: taskId,
      status: "queued",
      poll_after_seconds: 0,
    });
  }

  #nextEditedTime(): string {
    this.#clock += 1;
    return new Date(Date.UTC(2026, 0, 1, 0, 0, this.#clock)).toISOString();
  }
}
