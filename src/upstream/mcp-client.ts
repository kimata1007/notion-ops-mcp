import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

import { MAX_READ_RETRIES } from "../constants.js";
import { OpsError } from "../errors.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../package.js";
import type { OperationContext, OperationKind } from "./context.js";
import { normalizeThrownError, parseToolResult } from "./result.js";
import { UpstreamToolCatalog } from "./tool-catalog.js";
import type { JsonObject, UpstreamCallResult, UpstreamToolDefinition } from "./types.js";

export interface AccessTokenSource {
  getAccessToken(signal: AbortSignal): Promise<string | undefined>;
  getAccessTokenIfAvailable?(signal: AbortSignal): Promise<string | undefined>;
  handleUnauthorized?(): Promise<void>;
}

export type UpstreamTransportFactory = (
  endpoint: URL,
  accessToken: string,
  signal: AbortSignal,
) => Promise<Transport> | Transport;

export interface McpUpstreamClientOptions {
  readonly endpoint: URL;
  readonly tokenSource: AccessTokenSource;
  readonly transportFactory?: UpstreamTransportFactory;
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function defaultTransportFactory(endpoint: URL, accessToken: string): Transport {
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": `${PACKAGE_NAME}/${PACKAGE_VERSION}`,
      },
    },
    reconnectionOptions: {
      initialReconnectionDelay: 250,
      maxReconnectionDelay: 2_000,
      reconnectionDelayGrowFactor: 2,
      maxRetries: 2,
    },
  });
  // SDK 1.30's concrete class and Transport interface differ only in how an optional
  // sessionId is expressed when exactOptionalPropertyTypes is enabled.
  return transport as unknown as Transport;
}

export class McpUpstreamClient {
  readonly #endpoint: URL;
  readonly #tokenSource: AccessTokenSource;
  readonly #transportFactory: UpstreamTransportFactory;
  #client: Client | undefined;
  #catalog: UpstreamToolCatalog | undefined;
  #connecting: Promise<void> | undefined;

  constructor(options: McpUpstreamClientOptions) {
    this.#endpoint = options.endpoint;
    this.#tokenSource = options.tokenSource;
    this.#transportFactory = options.transportFactory ?? defaultTransportFactory;
  }

  async connect(context: OperationContext): Promise<void> {
    if (this.#client && this.#catalog) return;
    if (this.#connecting) return this.#connecting;
    this.#connecting = this.#connect(context);
    try {
      await this.#connecting;
    } finally {
      this.#connecting = undefined;
    }
  }

  async warm(context: OperationContext): Promise<boolean> {
    if (this.#client && this.#catalog) return true;
    const getAvailable = this.#tokenSource.getAccessTokenIfAvailable;
    if (!getAvailable) return false;
    const accessToken = await getAvailable.call(this.#tokenSource, context.signal);
    if (!accessToken) return false;
    if (this.#client && this.#catalog) return true;
    if (this.#connecting) {
      await this.#connecting;
      return true;
    }
    this.#connecting = this.#connect(context, accessToken);
    try {
      await this.#connecting;
      return true;
    } finally {
      this.#connecting = undefined;
    }
  }

  async reconnect(context: OperationContext): Promise<void> {
    await this.close();
    await this.connect(context);
  }

  catalog(context: OperationContext): Promise<UpstreamToolCatalog> {
    return this.#getCatalog(context);
  }

  async callTool(
    name: string,
    arguments_: JsonObject,
    kind: OperationKind,
    context: OperationContext,
  ): Promise<UpstreamCallResult> {
    let attempt = 0;
    while (true) {
      try {
        await this.connect(context);
        const client = this.#client;
        if (!client) throw new OpsError("failed", "upstream client is not connected");
        const remainingMs = context.remainingMs();
        if (remainingMs === 0) throw context.abortError();
        context.consumeToolCall();
        const result = await client.callTool(
          { name, arguments: arguments_ },
          CallToolResultSchema,
          {
            signal: context.signal,
            timeout: remainingMs,
            maxTotalTimeout: remainingMs,
          },
        );
        const parsedResult = CallToolResultSchema.safeParse(result);
        if (!parsedResult.success) {
          throw new OpsError("upstream_incompatible", "unexpected task-augmented tool result");
        }
        return parseToolResult(parsedResult.data);
      } catch (error) {
        const normalized = normalizeThrownError(error, context.signal);
        if (normalized.code === "auth_required") {
          await this.#tokenSource.handleUnauthorized?.();
          await this.close().catch(() => undefined);
        }
        const retryableRead =
          kind === "read" &&
          normalized.retryable &&
          attempt < MAX_READ_RETRIES &&
          !context.signal.aborted;
        if (!retryableRead) throw normalized;
        attempt += 1;
        context.recordRetry();
        const backoffMs = normalized.retryAfterMs ?? 100 * 2 ** (attempt - 1);
        if (backoffMs >= context.remainingMs()) throw normalized;
        await abortableDelay(backoffMs, context.signal);
      }
    }
  }

  async close(): Promise<void> {
    const client = this.#client;
    this.#client = undefined;
    this.#catalog = undefined;
    if (client) await client.close();
  }

  async #connect(context: OperationContext, availableAccessToken?: string): Promise<void> {
    const accessToken =
      availableAccessToken ?? (await this.#tokenSource.getAccessToken(context.signal));
    if (!accessToken) throw new OpsError("auth_required", "Notion authentication is required");
    const transport = await this.#transportFactory(this.#endpoint, accessToken, context.signal);
    const client = new Client(
      { name: PACKAGE_NAME, version: PACKAGE_VERSION },
      { capabilities: {} },
    );
    try {
      const remainingMs = context.remainingMs();
      await client.connect(transport, {
        signal: context.signal,
        timeout: remainingMs,
        maxTotalTimeout: remainingMs,
      });
      const listed = await client.listTools(undefined, {
        signal: context.signal,
        timeout: context.remainingMs(),
        maxTotalTimeout: context.remainingMs(),
      });
      this.#client = client;
      this.#catalog = new UpstreamToolCatalog(listed.tools as UpstreamToolDefinition[]);
    } catch (error) {
      await client.close().catch(() => undefined);
      const normalized = normalizeThrownError(error, context.signal);
      if (normalized.code === "auth_required") {
        await this.#tokenSource.handleUnauthorized?.();
      }
      throw normalized;
    }
  }

  async #getCatalog(context: OperationContext): Promise<UpstreamToolCatalog> {
    await this.connect(context);
    if (!this.#catalog) throw new OpsError("failed", "upstream tool catalog is unavailable");
    return this.#catalog;
  }
}
