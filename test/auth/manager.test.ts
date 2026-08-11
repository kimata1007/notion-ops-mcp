import { describe, expect, it } from "vitest";

import { AuthManager } from "../../src/auth/manager.js";
import type {
  LoopbackFactory,
  LoopbackHandler,
  LoopbackResponse,
} from "../../src/auth/loopback.js";
import { NotionOAuthClient } from "../../src/auth/oauth-client.js";
import type { CredentialStore, StoredCredential } from "../../src/auth/types.js";
import { OpsError } from "../../src/errors.js";
import { credential, oauthMetadata } from "./fixtures.js";

class MemoryStore implements CredentialStore {
  value: StoredCredential | undefined;
  saves = 0;
  clears = 0;

  constructor(value?: StoredCredential) {
    this.value = value;
  }

  async load(): Promise<StoredCredential | undefined> {
    return this.value;
  }

  async save(value: StoredCredential): Promise<void> {
    this.value = structuredClone(value);
    this.saves += 1;
  }

  async clear(): Promise<void> {
    this.value = undefined;
    this.clears += 1;
  }
}

class MemoryLoopback {
  handler: LoopbackHandler | undefined;
  closed = false;
  readonly redirectUri = "http://127.0.0.1:43123/oauth/callback";

  factory: LoopbackFactory = async (_path, handler) => {
    this.handler = handler;
    return {
      redirectUri: this.redirectUri,
      close: () => {
        this.closed = true;
      },
    };
  };

  async request(url: string): Promise<LoopbackResponse> {
    if (!this.handler) throw new Error("loopback handler is unavailable");
    const parsed = new URL(url);
    return this.handler({
      method: "GET",
      url: `${parsed.pathname}${parsed.search}`,
      host: parsed.host,
      remoteAddress: "127.0.0.1",
    });
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("AuthManager", () => {
  it("checks existing authentication without starting OAuth", async () => {
    const store = new MemoryStore();
    const loopback = new MemoryLoopback();
    const manager = new AuthManager({
      endpoint: new URL("https://mcp.notion.com/mcp"),
      store,
      environment: {},
      loopbackFactory: loopback.factory,
    });

    await expect(
      manager.getAccessTokenIfAvailable(AbortSignal.timeout(1_000)),
    ).resolves.toBeUndefined();
    expect(loopback.handler).toBeUndefined();
    await manager.close();
  });

  it("gives NOTION_TOKEN priority and never opens OAuth", async () => {
    const store = new MemoryStore(credential({ expires_at: 1 }));
    const manager = new AuthManager({
      endpoint: new URL("https://mcp.notion.com/mcp"),
      store,
      environment: { NOTION_TOKEN: "pat-value" },
    });

    await expect(manager.getAccessToken(AbortSignal.timeout(1_000))).resolves.toBe("pat-value");
    await manager.handleUnauthorized();
    expect(store.saves).toBe(0);
    expect(store.clears).toBe(0);
    await manager.close();
  });

  it("serializes refresh and persists rotated tokens before returning", async () => {
    const store = new MemoryStore(credential({ expires_at: 1 }));
    let refreshCalls = 0;
    const oauth = new NotionOAuthClient((async () => {
      refreshCalls += 1;
      return json({
        access_token: "access-new",
        refresh_token: "refresh-new",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }) as typeof fetch);
    const manager = new AuthManager({
      endpoint: new URL("https://mcp.notion.com/mcp"),
      store,
      oauthClient: oauth,
      environment: {},
      now: () => 2_000_000_000_000,
    });

    const tokens = await Promise.all([
      manager.getAccessToken(AbortSignal.timeout(1_000)),
      manager.getAccessToken(AbortSignal.timeout(1_000)),
    ]);

    expect(tokens).toEqual(["access-new", "access-new"]);
    expect(refreshCalls).toBe(1);
    expect(store.value?.tokens).toMatchObject({
      access_token: "access-new",
      refresh_token: "refresh-new",
    });
    expect(store.saves).toBe(1);
    await manager.close();
  });

  it("returns an auth URL, validates callback state, and stores exchanged tokens", async () => {
    const store = new MemoryStore();
    const loopback = new MemoryLoopback();
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://mcp.notion.com/.well-known/oauth-protected-resource") {
        return json({ authorization_servers: ["https://auth.test"] });
      }
      if (url.endsWith("/.well-known/oauth-authorization-server")) return json(oauthMetadata);
      if (url === "https://auth.test/register") return json({ client_id: "registered" });
      if (url === "https://auth.test/token") {
        expect(new URLSearchParams(String(init?.body)).get("code_verifier")).toBeTruthy();
        return json({
          access_token: "access-complete",
          refresh_token: "refresh-complete",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      throw new Error(`unexpected URL ${url}`);
    }) as typeof fetch;
    const manager = new AuthManager({
      endpoint: new URL("https://mcp.notion.com/mcp"),
      store,
      oauthClient: new NotionOAuthClient(fakeFetch),
      environment: {},
      loopbackFactory: loopback.factory,
    });

    let authError: OpsError | undefined;
    try {
      await manager.getAccessToken(AbortSignal.timeout(5_000));
    } catch (error) {
      if (error instanceof OpsError) authError = error;
      else throw error;
    }
    expect(authError?.code).toBe("auth_required");
    const authorizationUrl = String(authError?.details?.["authorizationUrl"]);
    const authorization = new URL(authorizationUrl);
    const redirectUri = authorization.searchParams.get("redirect_uri");
    const state = authorization.searchParams.get("state");
    if (!redirectUri || !state) throw new Error("auth URL is incomplete");

    const invalid = await loopback.request(`${redirectUri}?code=ignored&state=wrong`);
    expect(invalid.status).toBe(400);
    const completed = await loopback.request(`${redirectUri}?code=accepted&state=${state}`);
    expect(completed.status).toBe(200);
    await expect(manager.getAccessToken(AbortSignal.timeout(1_000))).resolves.toBe(
      "access-complete",
    );
    expect(store.value?.tokens.refresh_token).toBe("refresh-complete");
    expect(loopback.closed).toBe(true);
    await manager.close();
  });

  it("treats invalid_grant as terminal and starts reauthorization without retrying refresh", async () => {
    const store = new MemoryStore(credential({ expires_at: 1 }));
    const loopback = new MemoryLoopback();
    let refreshCalls = 0;
    const fakeFetch = (async (input: string | URL | Request) => {
      const url = input.toString();
      if (url === "https://auth.test/token") {
        refreshCalls += 1;
        return json({ error: "invalid_grant" }, 400);
      }
      if (url === "https://mcp.notion.com/.well-known/oauth-protected-resource") {
        return json({ authorization_servers: ["https://auth.test"] });
      }
      if (url.endsWith("/.well-known/oauth-authorization-server")) return json(oauthMetadata);
      if (url === "https://auth.test/register") return json({ client_id: "registered-again" });
      throw new Error(`unexpected URL ${url}`);
    }) as typeof fetch;
    const manager = new AuthManager({
      endpoint: new URL("https://mcp.notion.com/mcp"),
      store,
      oauthClient: new NotionOAuthClient(fakeFetch),
      environment: {},
      loopbackFactory: loopback.factory,
      now: () => 2_000_000_000_000,
    });

    await expect(manager.getAccessToken(AbortSignal.timeout(1_000))).rejects.toMatchObject({
      code: "auth_required",
    });
    expect(refreshCalls).toBe(1);
    expect(store.clears).toBe(1);
    await manager.close();
  });
});
