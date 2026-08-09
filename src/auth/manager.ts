import { timingSafeEqual } from "node:crypto";

import { DEFAULT_REQUEST_TIMEOUT_MS } from "../constants.js";
import { OpsError } from "../errors.js";
import type { SafeLogger } from "../logger.js";
import type { AccessTokenSource } from "../upstream/mcp-client.js";
import { FileCredentialStore } from "./file-store.js";
import {
  createLoopbackListener,
  type LoopbackFactory,
  type LoopbackListener,
  type LoopbackRequest,
  type LoopbackResponse,
} from "./loopback.js";
import {
  generateOAuthState,
  generatePkce,
  NotionOAuthClient,
  OAuthProtocolError,
} from "./oauth-client.js";
import type {
  CredentialStore,
  OAuthClientRegistration,
  OAuthMetadata,
  OAuthTokenResponse,
  StoredCredential,
} from "./types.js";

const CALLBACK_PATH = "/oauth/callback";
const AUTH_FLOW_TTL_MS = 10 * 60 * 1_000;
const REFRESH_EARLY_MS = 5 * 60 * 1_000;

interface PendingFlow {
  listener: LoopbackListener;
  state: string;
  verifier: string;
  redirectUri: string;
  authorizationUrl: string;
  metadata: OAuthMetadata;
  client: OAuthClientRegistration;
  expiresAt: number;
  timeout: NodeJS.Timeout;
}

export interface AuthManagerOptions {
  endpoint: URL;
  store?: CredentialStore;
  oauthClient?: NotionOAuthClient;
  environment?: NodeJS.ProcessEnv;
  logger?: SafeLogger;
  now?: () => number;
  loopbackFactory?: LoopbackFactory;
}

function safeStateEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function isLoopback(remoteAddress: string | undefined): boolean {
  return (
    remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1"
  );
}

function storedTokens(
  endpoint: URL,
  metadata: OAuthMetadata,
  client: OAuthClientRegistration,
  tokens: OAuthTokenResponse,
  now: number,
  previous?: StoredCredential,
): StoredCredential {
  return {
    version: 1,
    server_url: endpoint.toString(),
    metadata,
    client,
    tokens: {
      access_token: tokens.access_token,
      token_type: tokens.token_type,
      ...((tokens.refresh_token ?? previous?.tokens.refresh_token)
        ? { refresh_token: tokens.refresh_token ?? previous?.tokens.refresh_token }
        : {}),
      ...(tokens.expires_in ? { expires_at: now + Math.round(tokens.expires_in * 1_000) } : {}),
      ...((tokens.scope ?? previous?.tokens.scope)
        ? { scope: tokens.scope ?? previous?.tokens.scope }
        : {}),
      ...((tokens.user_id ?? previous?.tokens.user_id)
        ? { user_id: tokens.user_id ?? previous?.tokens.user_id }
        : {}),
      ...((tokens.workspace_id ?? previous?.tokens.workspace_id)
        ? { workspace_id: tokens.workspace_id ?? previous?.tokens.workspace_id }
        : {}),
      ...((tokens.email_domain ?? previous?.tokens.email_domain)
        ? { email_domain: tokens.email_domain ?? previous?.tokens.email_domain }
        : {}),
    },
  };
}

export class AuthManager implements AccessTokenSource {
  readonly #endpoint: URL;
  readonly #store: CredentialStore;
  readonly #oauth: NotionOAuthClient;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #logger?: SafeLogger;
  readonly #now: () => number;
  readonly #loopbackFactory: LoopbackFactory;
  #pending: PendingFlow | undefined;
  #starting: Promise<PendingFlow> | undefined;
  #refreshing: Promise<string> | undefined;

  constructor(options: AuthManagerOptions) {
    this.#endpoint = options.endpoint;
    this.#store = options.store ?? new FileCredentialStore();
    this.#oauth = options.oauthClient ?? new NotionOAuthClient();
    this.#environment = options.environment ?? process.env;
    if (options.logger) this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
    this.#loopbackFactory = options.loopbackFactory ?? createLoopbackListener;
  }

  async getAccessToken(signal: AbortSignal): Promise<string | undefined> {
    const personalAccessToken = this.#environment["NOTION_TOKEN"]?.trim();
    if (personalAccessToken) return personalAccessToken;

    const credential = await this.#store.load();
    if (credential?.server_url === this.#endpoint.toString()) {
      if (
        credential.tokens.expires_at === undefined ||
        credential.tokens.expires_at > this.#now() + REFRESH_EARLY_MS
      ) {
        return credential.tokens.access_token;
      }
      if (credential.tokens.refresh_token) {
        try {
          return await this.#refreshOnce(credential, signal);
        } catch (error) {
          if (!(error instanceof OAuthProtocolError) || error.oauthCode !== "invalid_grant") {
            throw new OpsError("failed", "OAuth token refresh failed", { cause: error });
          }
          await this.#store.clear();
          this.#logger?.info("oauth_reauthentication_required", { reason: "invalid_grant" });
        }
      }
    }

    const pending = await this.#startOnce(signal);
    throw new OpsError("auth_required", "Notion authorization is required", {
      details: { authorizationUrl: pending.authorizationUrl, expiresAt: pending.expiresAt },
    });
  }

  async handleUnauthorized(): Promise<void> {
    if (this.#environment["NOTION_TOKEN"]?.trim()) return;
    await this.#store.clear();
    this.#logger?.info("oauth_credential_invalidated", { reason: "upstream_unauthorized" });
  }

  async close(): Promise<void> {
    this.#closePending();
  }

  async #refreshOnce(credential: StoredCredential, signal: AbortSignal): Promise<string> {
    if (this.#refreshing) return this.#refreshing;
    this.#refreshing = this.#refresh(credential, signal);
    try {
      return await this.#refreshing;
    } finally {
      this.#refreshing = undefined;
    }
  }

  async #refresh(credential: StoredCredential, signal: AbortSignal): Promise<string> {
    const refreshToken = credential.tokens.refresh_token;
    if (!refreshToken)
      throw new OAuthProtocolError("refresh token is unavailable", "invalid_grant");
    const tokens = await this.#oauth.refresh(
      credential.metadata,
      credential.client,
      refreshToken,
      signal,
    );
    const rotated = storedTokens(
      this.#endpoint,
      credential.metadata,
      credential.client,
      tokens,
      this.#now(),
      credential,
    );
    await this.#store.save(rotated);
    this.#logger?.info("oauth_token_refreshed", { rotated: Boolean(tokens.refresh_token) });
    return rotated.tokens.access_token;
  }

  async #startOnce(signal: AbortSignal): Promise<PendingFlow> {
    if (this.#pending && this.#pending.expiresAt > this.#now()) return this.#pending;
    if (this.#starting) return this.#starting;
    this.#starting = this.#startAuthorization(signal);
    try {
      return await this.#starting;
    } finally {
      this.#starting = undefined;
    }
  }

  async #startAuthorization(signal: AbortSignal): Promise<PendingFlow> {
    this.#closePending();
    let flow: PendingFlow | undefined;
    let listener: LoopbackListener | undefined;
    try {
      listener = await this.#loopbackFactory(
        CALLBACK_PATH,
        async (request) =>
          flow
            ? this.#handleCallback(flow, request)
            : {
                status: 503,
                contentType: "text/plain; charset=utf-8",
                body: "Authorization is not ready.",
              },
        signal,
      );
      const redirectUri = listener.redirectUri;
      const discoverySignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS),
      ]);
      const metadata = await this.#oauth.discover(this.#endpoint, discoverySignal);
      const client = await this.#oauth.register(metadata, redirectUri, discoverySignal);
      const pkce = generatePkce();
      const state = generateOAuthState();
      const expiresAt = this.#now() + AUTH_FLOW_TTL_MS;
      const timeout = setTimeout(() => this.#closePending(), AUTH_FLOW_TTL_MS);
      timeout.unref();
      flow = {
        listener,
        state,
        verifier: pkce.verifier,
        redirectUri,
        authorizationUrl: this.#oauth.authorizationUrl(
          metadata,
          client,
          redirectUri,
          pkce.challenge,
          state,
        ),
        metadata,
        client,
        expiresAt,
        timeout,
      };
      this.#pending = flow;
      this.#logger?.info("oauth_authorization_started", { expiresAt });
      return flow;
    } catch (error) {
      listener?.close();
      throw error;
    }
  }

  async #handleCallback(flow: PendingFlow, request: LoopbackRequest): Promise<LoopbackResponse> {
    const expectedHost = new URL(flow.redirectUri).host;
    const requestUrl = new URL(request.url, flow.redirectUri);
    if (
      request.method !== "GET" ||
      requestUrl.pathname !== CALLBACK_PATH ||
      request.host !== expectedHost ||
      !isLoopback(request.remoteAddress)
    ) {
      return { status: 404, contentType: "text/plain; charset=utf-8", body: "Not found." };
    }
    const state = requestUrl.searchParams.get("state") ?? "";
    if (!safeStateEqual(state, flow.state) || this.#now() >= flow.expiresAt) {
      return {
        status: 400,
        contentType: "text/plain; charset=utf-8",
        body: "Authorization state is invalid or expired.",
      };
    }
    const code = requestUrl.searchParams.get("code");
    if (!code || requestUrl.searchParams.has("error")) {
      this.#closePending();
      return {
        status: 400,
        contentType: "text/plain; charset=utf-8",
        body: "Authorization was not completed.",
      };
    }
    try {
      const tokens = await this.#oauth.exchangeCode(
        flow.metadata,
        flow.client,
        code,
        flow.verifier,
        flow.redirectUri,
        AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS),
      );
      await this.#store.save(
        storedTokens(this.#endpoint, flow.metadata, flow.client, tokens, this.#now()),
      );
      this.#logger?.info("oauth_authorization_completed");
      this.#closePending();
      return {
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: "<!doctype html><title>Notion authorized</title><p>Authorization complete. You may close this window.</p>",
        noStore: true,
      };
    } catch {
      this.#closePending();
      return {
        status: 502,
        contentType: "text/plain; charset=utf-8",
        body: "Authorization could not be completed. Return to the MCP client and retry.",
        noStore: true,
      };
    }
  }

  #closePending(): void {
    const pending = this.#pending;
    this.#pending = undefined;
    if (!pending) return;
    clearTimeout(pending.timeout);
    pending.listener.close();
    pending.state = "";
    pending.verifier = "";
  }
}
