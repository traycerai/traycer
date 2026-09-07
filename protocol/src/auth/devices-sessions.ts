import { z } from "zod";
import { isoMillisecondTimestampSchema } from "@traycer/protocol/common/schemas";

/**
 * Client-side mirror of authn-v3's Devices & Sessions account-security DTOs.
 * The open-source client cannot import the internal `@traycerai/common` package, so this module mirrors the wire shape consumed by desktop surfaces.
 */

export type UserSessionListItem = {
  familyId: string;
  clientKind: string;
  displayLabel: string | null;
  platform: string | null;
  appVersion: string | null;
  location: string | null;
  createdAt: string;
  lastSeenAt: string;
  revoked: boolean;
  revokedAt: string | null;
  revokedBy: string | null;
  current: boolean;
};

export type ListUserSessionsResponse = {
  sessions: UserSessionListItem[];
};

export type RevokeUserSessionResponse = {
  familyId: string;
  revoked: true;
};

export type RevokeAllSessionsResponse = {
  ok: true;
  tokenVersion: number;
  hostsSignaled: number;
  residual: {
    githubProviderTokenHours: number;
  };
};

/**
 * `POST /api/v3/hosts/token` request - the delegated host-credential mint.
 * The CLIENT calls this with its own step-up-fresh bearer on behalf of the host it is connected to; the host never calls it for itself.
 */
export type MintHostCredentialRequest = {
  /** The host's durable id, taken from the endpoint this connection dialed. */
  hostId: string;
  /** Human label for the machine, shown in Devices & Sessions. */
  hostLabel: string | null;
  /** OS/platform string; the server falls back to a UA-derived value on null. */
  platform: string | null;
};

/** The minted host credential, relayed straight to the host over the stream. */
export type MintHostCredentialResponse = {
  /** Host-audience access JWS (`aud: "host"`), hard-capped at 15 minutes. */
  token: string;
  refreshToken: string;
  /** The credential's own refresh family - also its Devices & Sessions row id. */
  familyId: string;
  hostId: string;
  expiresIn: number;
  /** When the server recorded this credential, ISO-8601 at millisecond resolution. */
  provisionedAt: string;
};

export type StepUpChallengeResponse = {
  ok: true;
  expires_in: number;
};

export type VerifyStepUpResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
};

export const userSessionListItemSchema: z.ZodType<UserSessionListItem> = z
  .object({
    familyId: z.string(),
    clientKind: z.string(),
    displayLabel: z.string().nullable(),
    platform: z.string().nullable(),
    appVersion: z.string().nullable(),
    location: z.string().nullable(),
    createdAt: z.string(),
    lastSeenAt: z.string(),
    revoked: z.boolean(),
    revokedAt: z.string().nullable(),
    revokedBy: z.string().nullable(),
    current: z.boolean(),
  })
  .strict();

export const listUserSessionsResponseSchema: z.ZodType<ListUserSessionsResponse> =
  z
    .object({
      sessions: z.array(userSessionListItemSchema),
    })
    .strict();

export const revokeUserSessionResponseSchema: z.ZodType<RevokeUserSessionResponse> =
  z
    .object({
      familyId: z.string(),
      revoked: z.literal(true),
    })
    .strict();

export const revokeAllSessionsResponseSchema: z.ZodType<RevokeAllSessionsResponse> =
  z
    .object({
      ok: z.literal(true),
      tokenVersion: z.number().int(),
      hostsSignaled: z.number().int().nonnegative(),
      residual: z
        .object({
          githubProviderTokenHours: z.number().nonnegative(),
        })
        .strict(),
    })
    .strict();

export const mintHostCredentialResponseSchema: z.ZodType<MintHostCredentialResponse> =
  z
    .object({
      token: z.string().min(1),
      refreshToken: z.string().min(1),
      familyId: z.string().min(1),
      hostId: z.string().min(1),
      expiresIn: z.number().int().positive(),
      provisionedAt: isoMillisecondTimestampSchema,
    })
    .strict();

export const stepUpChallengeResponseSchema: z.ZodType<StepUpChallengeResponse> =
  z
    .object({
      ok: z.literal(true),
      expires_in: z.number().int().positive(),
    })
    .strict();

export const verifyStepUpResponseSchema: z.ZodType<VerifyStepUpResponse> = z
  .object({
    access_token: z.string(),
    token_type: z.literal("Bearer"),
    expires_in: z.number().int().positive(),
  })
  .strict();
