import { createHash, randomBytes } from "node:crypto";

import { OpsError } from "../errors.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../package.js";
import {
  OAuthClientRegistrationSchema,
  OAuthMetadataSchema,
  OAuthTokenResponseSchema,
  type OAuthClientRegistration,
  type OAuthMetadata,
  type OAuthTokenResponse,
} from "./types.js";

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export class OAuthProtocolError extends Error {
  readonly oauthCode?: string;

  constructor(message: string, oauthCode?: string) {
    super(message);
    this.name = "OAuthProtocolError";
    if (oauthCode !== undefined) this.oauthCode = oauthCode;
  }
}

export function generatePkce(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function generateOAuthState(): string {
  return randomBytes(32).toString("hex");
}

function assertSecureUrl(value: string, allowLoopbackHttp = false): URL {
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(allowLoopbackHttp && url.protocol === "http:" && loopback)) {
    throw new OpsError("failed", "OAuth endpoint must use HTTPS");
  }
  if (url.username || url.password)
    throw new OpsError("failed", "OAuth endpoint contains userinfo");
  return url;
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new OAuthProtocolError("OAuth endpoint returned invalid JSON");
  }
}

async function oauthError(response: Response): Promise<OAuthProtocolError> {
  let code: string | undefined;
  try {
    const value = (await response.json()) as Record<string, unknown>;
    if (typeof value["error"] === "string") code = value["error"];
  } catch {
    // Response bodies are deliberately not copied into exceptions.
  }
  return new OAuthProtocolError(`OAuth request failed with status ${response.status}`, code);
}

export class NotionOAuthClient {
  readonly #fetch: typeof fetch;

  constructor(fetchImplementation: typeof fetch = fetch) {
    this.#fetch = fetchImplementation;
  }

  async discover(resourceEndpoint: URL, signal: AbortSignal): Promise<OAuthMetadata> {
    assertSecureUrl(resourceEndpoint.toString(), true);
    const resourcePaths = [
      `${resourceEndpoint.pathname.replace(/\/$/u, "")}/.well-known/oauth-protected-resource`,
      "/.well-known/oauth-protected-resource",
    ];
    let protectedResource: Record<string, unknown> | undefined;
    for (const path of [...new Set(resourcePaths)]) {
      const response = await this.#fetch(new URL(path, resourceEndpoint.origin), {
        headers: { Accept: "application/json" },
        signal,
      });
      if (response.ok) {
        protectedResource = (await parseJson(response)) as Record<string, unknown>;
        break;
      }
      if (response.status !== 404) throw await oauthError(response);
    }
    const authorizationServers = protectedResource?.["authorization_servers"];
    const authorizationServer = Array.isArray(authorizationServers)
      ? authorizationServers[0]
      : undefined;
    if (typeof authorizationServer !== "string") {
      throw new OAuthProtocolError("protected resource metadata has no authorization server");
    }
    const authorizationServerUrl = assertSecureUrl(authorizationServer, true);
    const metadataUrl = new URL(
      `${authorizationServerUrl.pathname.replace(/\/$/u, "")}/.well-known/oauth-authorization-server`,
      authorizationServerUrl.origin,
    );
    const response = await this.#fetch(metadataUrl, {
      headers: { Accept: "application/json" },
      signal,
    });
    if (!response.ok) throw await oauthError(response);
    const metadata = OAuthMetadataSchema.safeParse(await parseJson(response));
    if (!metadata.success) throw new OAuthProtocolError("authorization server metadata is invalid");
    assertSecureUrl(metadata.data.authorization_endpoint, true);
    assertSecureUrl(metadata.data.token_endpoint, true);
    assertSecureUrl(metadata.data.registration_endpoint, true);
    if (!metadata.data.code_challenge_methods_supported?.includes("S256")) {
      throw new OAuthProtocolError("authorization server does not advertise S256 PKCE");
    }
    return metadata.data;
  }

  async register(
    metadata: OAuthMetadata,
    redirectUri: string,
    signal: AbortSignal,
  ): Promise<OAuthClientRegistration> {
    const response = await this.#fetch(assertSecureUrl(metadata.registration_endpoint, true), {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: PACKAGE_NAME,
        client_uri: "https://github.com/kimata1007/notion-ops-mcp",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
      signal,
    });
    if (!response.ok) throw await oauthError(response);
    const client = OAuthClientRegistrationSchema.safeParse(await parseJson(response));
    if (!client.success) throw new OAuthProtocolError("dynamic client registration is invalid");
    return client.data;
  }

  authorizationUrl(
    metadata: OAuthMetadata,
    client: OAuthClientRegistration,
    redirectUri: string,
    challenge: string,
    state: string,
  ): string {
    const url = assertSecureUrl(metadata.authorization_endpoint, true);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "consent",
    }).toString();
    return url.toString();
  }

  exchangeCode(
    metadata: OAuthMetadata,
    client: OAuthClientRegistration,
    code: string,
    verifier: string,
    redirectUri: string,
    signal: AbortSignal,
  ): Promise<OAuthTokenResponse> {
    return this.#tokenRequest(
      metadata,
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        ...(client.client_secret ? { client_secret: client.client_secret } : {}),
      }),
      signal,
    );
  }

  refresh(
    metadata: OAuthMetadata,
    client: OAuthClientRegistration,
    refreshToken: string,
    signal: AbortSignal,
  ): Promise<OAuthTokenResponse> {
    return this.#tokenRequest(
      metadata,
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: client.client_id,
        ...(client.client_secret ? { client_secret: client.client_secret } : {}),
      }),
      signal,
    );
  }

  async #tokenRequest(
    metadata: OAuthMetadata,
    body: URLSearchParams,
    signal: AbortSignal,
  ): Promise<OAuthTokenResponse> {
    const response = await this.#fetch(assertSecureUrl(metadata.token_endpoint, true), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": `${PACKAGE_NAME}/${PACKAGE_VERSION}`,
      },
      body,
      signal,
    });
    if (!response.ok) throw await oauthError(response);
    const tokens = OAuthTokenResponseSchema.safeParse(await parseJson(response));
    if (!tokens.success || tokens.data.token_type.toLowerCase() !== "bearer") {
      throw new OAuthProtocolError("OAuth token response is invalid");
    }
    return tokens.data;
  }
}
