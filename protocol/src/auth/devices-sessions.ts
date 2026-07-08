import { z } from "zod";

/**
 * Client-side mirror of authn-v3's Devices & Sessions account-security DTOs.
 *
 * The open-source client cannot import the internal `@traycerai/common`
 * package, so this module mirrors the wire shape consumed by desktop surfaces.
 * Schemas are strict so a backend contract drift fails closed at the HTTP
 * boundary instead of rendering partial account-security state.
 */

export type UserSessionListItem = {
  familyId: string;
  clientKind: string;
  displayLabel: string | null;
  platform: string | null;
  appVersion: string | null;
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
