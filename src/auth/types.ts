import { z } from "zod";

export const OAuthMetadataSchema = z
  .object({
    issuer: z.url(),
    authorization_endpoint: z.url(),
    token_endpoint: z.url(),
    registration_endpoint: z.url(),
    code_challenge_methods_supported: z.array(z.string()).optional(),
    scopes_supported: z.array(z.string()).optional(),
  })
  .passthrough();

export const OAuthClientRegistrationSchema = z
  .object({
    client_id: z.string().min(1),
    client_secret: z.string().min(1).optional(),
    client_id_issued_at: z.number().optional(),
    client_secret_expires_at: z.number().optional(),
  })
  .passthrough();

export const OAuthTokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    token_type: z.string().min(1),
    expires_in: z.number().positive().optional(),
    refresh_token: z.string().min(1).optional(),
    scope: z.string().optional(),
    user_id: z.string().optional(),
    workspace_id: z.string().optional(),
    email_domain: z.string().optional(),
  })
  .passthrough();

export const StoredCredentialSchema = z
  .object({
    version: z.literal(1),
    server_url: z.url(),
    metadata: OAuthMetadataSchema,
    client: OAuthClientRegistrationSchema,
    tokens: z
      .object({
        access_token: z.string().min(1),
        refresh_token: z.string().min(1).optional(),
        token_type: z.string().min(1),
        expires_at: z.number().int().positive().optional(),
        scope: z.string().optional(),
        user_id: z.string().optional(),
        workspace_id: z.string().optional(),
        email_domain: z.string().optional(),
      })
      .strict(),
  })
  .strict();

export type OAuthMetadata = z.infer<typeof OAuthMetadataSchema>;
export type OAuthClientRegistration = z.infer<typeof OAuthClientRegistrationSchema>;
export type OAuthTokenResponse = z.infer<typeof OAuthTokenResponseSchema>;
export type StoredCredential = z.infer<typeof StoredCredentialSchema>;

export interface CredentialStore {
  load(): Promise<StoredCredential | undefined>;
  save(credential: StoredCredential): Promise<void>;
  clear(): Promise<void>;
}
