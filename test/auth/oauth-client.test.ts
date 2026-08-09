import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  generateOAuthState,
  generatePkce,
  NotionOAuthClient,
  OAuthProtocolError,
} from "../../src/auth/oauth-client.js";
import { oauthMetadata } from "./fixtures.js";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("NotionOAuthClient", () => {
  it("generates valid PKCE and state entropy", () => {
    const pkce = generatePkce();
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pkce.challenge).toBe(createHash("sha256").update(pkce.verifier).digest("base64url"));
    expect(generateOAuthState()).toMatch(/^[a-f0-9]{64}$/);
  });

  it("performs protected-resource discovery and dynamic registration", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      requests.push({ url, ...(init ? { init } : {}) });
      if (url.endsWith("/mcp/.well-known/oauth-protected-resource")) {
        return json({ authorization_servers: ["https://auth.test"] });
      }
      if (url.endsWith("/.well-known/oauth-authorization-server")) return json(oauthMetadata);
      if (url === "https://auth.test/register") return json({ client_id: "registered" });
      throw new Error(`unexpected URL: ${url}`);
    }) as typeof fetch;
    const client = new NotionOAuthClient(fakeFetch);
    const signal = AbortSignal.timeout(1_000);

    const metadata = await client.discover(new URL("https://mcp.notion.com/mcp"), signal);
    const registration = await client.register(
      metadata,
      "http://127.0.0.1:1234/oauth/callback",
      signal,
    );

    expect(registration.client_id).toBe("registered");
    expect(requests.map((request) => request.url)).toEqual([
      "https://mcp.notion.com/mcp/.well-known/oauth-protected-resource",
      "https://auth.test/.well-known/oauth-authorization-server",
      "https://auth.test/register",
    ]);
    expect(JSON.parse(String(requests[2]?.init?.body))).toMatchObject({
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    });
  });

  it("exchanges PKCE codes and atomically supports refresh-token rotation", async () => {
    const bodies: string[] = [];
    const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return bodies.length === 1
        ? json({
            access_token: "access-1",
            refresh_token: "refresh-1",
            token_type: "Bearer",
            expires_in: 3600,
          })
        : json({
            access_token: "access-2",
            refresh_token: "refresh-2",
            token_type: "Bearer",
            expires_in: 3600,
          });
    }) as typeof fetch;
    const client = new NotionOAuthClient(fakeFetch);
    const signal = AbortSignal.timeout(1_000);

    await client.exchangeCode(
      oauthMetadata,
      { client_id: "client" },
      "code",
      "verifier",
      "http://127.0.0.1:1234/oauth/callback",
      signal,
    );
    const refreshed = await client.refresh(
      oauthMetadata,
      { client_id: "client" },
      "refresh-1",
      signal,
    );

    expect(new URLSearchParams(bodies[0]).get("code_verifier")).toBe("verifier");
    expect(new URLSearchParams(bodies[1]).get("refresh_token")).toBe("refresh-1");
    expect(refreshed.refresh_token).toBe("refresh-2");
  });

  it("never copies a token-bearing OAuth response body into an exception", async () => {
    const client = new NotionOAuthClient((async () =>
      json({ error: "invalid_grant", access_token: "ntn_must_not_leak" }, 400)) as typeof fetch);
    let caught: unknown;
    try {
      await client.refresh(
        oauthMetadata,
        { client_id: "client" },
        "refresh",
        AbortSignal.timeout(1_000),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OAuthProtocolError);
    expect(caught).toMatchObject({ oauthCode: "invalid_grant" });
    expect(String(caught)).not.toContain("ntn_must_not_leak");
  });
});
