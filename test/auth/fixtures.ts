import type { OAuthMetadata, StoredCredential } from "../../src/auth/types.js";

export const oauthMetadata: OAuthMetadata = {
  issuer: "https://auth.test",
  authorization_endpoint: "https://auth.test/authorize",
  token_endpoint: "https://auth.test/token",
  registration_endpoint: "https://auth.test/register",
  code_challenge_methods_supported: ["S256"],
};

export function credential(overrides: Partial<StoredCredential["tokens"]> = {}): StoredCredential {
  return {
    version: 1,
    server_url: "https://mcp.notion.com/mcp",
    metadata: oauthMetadata,
    client: { client_id: "client-id" },
    tokens: {
      access_token: "access-old",
      refresh_token: "refresh-old",
      token_type: "Bearer",
      expires_at: 1_900_000_000_000,
      ...overrides,
    },
  };
}
