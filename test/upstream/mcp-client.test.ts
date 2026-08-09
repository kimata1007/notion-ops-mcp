import { afterEach, describe, expect, it, vi } from "vitest";

import type { OpsError } from "../../src/errors.js";
import { OperationContext } from "../../src/upstream/context.js";
import { McpUpstreamClient } from "../../src/upstream/mcp-client.js";
import { FakeNotionMcp } from "../support/fake-notion-mcp.js";

const clients: McpUpstreamClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

function createClient(fake: FakeNotionMcp, token = "fake-token"): McpUpstreamClient {
  const client = new McpUpstreamClient({
    endpoint: new URL("http://127.0.0.1/mcp"),
    tokenSource: { getAccessToken: async () => token || undefined },
    transportFactory: fake.transportFactory,
  });
  clients.push(client);
  return client;
}

describe("McpUpstreamClient", () => {
  it("warms the connection using only an already available token", async () => {
    const fake = new FakeNotionMcp();
    const getAccessToken = vi.fn(async () => {
      throw new Error("interactive authentication must not start");
    });
    const getAccessTokenIfAvailable = vi.fn(async () => "fake-token");
    let transports = 0;
    const client = new McpUpstreamClient({
      endpoint: new URL("http://127.0.0.1/mcp"),
      tokenSource: { getAccessToken, getAccessTokenIfAvailable },
      transportFactory: async () => {
        transports += 1;
        return fake.transportFactory();
      },
    });
    clients.push(client);

    await expect(client.warm(new OperationContext("read"))).resolves.toBe(true);
    await expect(client.catalog(new OperationContext("read"))).resolves.toBeDefined();
    expect(getAccessTokenIfAvailable).toHaveBeenCalledOnce();
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(transports).toBe(1);
  });

  it("skips warm-up without an existing token or upstream connection", async () => {
    const fake = new FakeNotionMcp();
    const getAccessToken = vi.fn(async () => "interactive-token");
    const client = new McpUpstreamClient({
      endpoint: new URL("http://127.0.0.1/mcp"),
      tokenSource: {
        getAccessToken,
        getAccessTokenIfAvailable: async () => undefined,
      },
      transportFactory: fake.transportFactory,
    });
    clients.push(client);

    await expect(client.warm(new OperationContext("read"))).resolves.toBe(false);
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fake.calls).toHaveLength(0);
  });

  it("uses MCP initialize, tools/list and tools/call against the fake server", async () => {
    const fake = new FakeNotionMcp();
    const page = fake.addPage({ title: "Runbook", markdown: "# Runbook\n\nSafe steps" });
    const client = createClient(fake);
    const context = new OperationContext("read");

    const names = (await client.catalog(context)).resolve({ requireWrite: true });
    const search = await client.callTool(names.search, { query: "Runbook" }, "read", context);
    const fetch = await client.callTool(names.fetch, { id: page.id }, "read", context);

    expect(search.value).toMatchObject({ results: [{ id: page.id }] });
    expect(fetch.value).toMatchObject({ text: page.markdown, page: { id: page.id } });
    expect(context.metrics.upstreamToolCalls).toBe(2);
    expect(fake.calls.map((call) => call.name)).toEqual(["notion-search", "notion-fetch"]);
  });

  it("returns auth_required without opening a transport", async () => {
    const fake = new FakeNotionMcp();
    const client = createClient(fake, "");
    const context = new OperationContext("read");

    await expect(client.catalog(context)).rejects.toMatchObject({
      code: "auth_required",
    } satisfies Partial<OpsError>);
    expect(context.metrics.upstreamToolCalls).toBe(0);
    expect(fake.calls).toHaveLength(0);
  });
});
