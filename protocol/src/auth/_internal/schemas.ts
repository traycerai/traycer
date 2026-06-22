import { z } from "zod";

/**
 * Private Zod values for the auth / session / MCP-server records and
 * their non-record extension shapes.
 *
 * These schemas are the contract authority. Types for the records they
 * define are derived in `protocol/auth/registry.ts` via `RecordValue<>`,
 * so the runtime check and the compile-time shape stay in lock-step
 * automatically - there is no plain TS duplicate that could drift.
 *
 * Non-record extension shapes (e.g. `traycerUserSubscriptionSchema`)
 * compose against the registered base schemas using `.extend(...)`, so
 * the inferred TypeScript shape of any record that embeds them lines up
 * with the public extension types in `protocol/auth/user.ts` by
 * construction - no `satisfies` annotation needed.
 *
 * Only `protocol/auth/registry.ts` is allowed to import from this
 * module. Every other consumer reaches a record through
 * `getRecordSchema(authRecordRegistry, "<record-name>")` and reads
 * record types from the registry.
 *
 * Date fields use `z.coerce.date()` so wire JSON (ISO strings) and
 * native `Date` instances both validate; the inferred TypeScript type
 * remains `Date`.
 */

// ---- Enums -------------------------------------------------------------- //

export const providerTypeSchema = z.enum([
  "GITHUB",
  "GOOGLE",
  "GITLAB",
  "EMAIL",
]);

export const seatAllocationSchema = z.enum(["MANUAL", "AUTO_ALLOCATION"]);

export const subscriptionStatusSchema = z.enum([
  "PENDING",
  "FREE",
  "PRO_LEGACY",
  "PRO",
  "PRO_PLUS",
  "LITE",
  "LITE_V2",
  "PRO_V2",
  "PRO_PLUS_V2",
  "LITE_V3",
  "PRO_V3",
  "ULTRA_1X_V3",
  "ULTRA_2X_V3",
  "ULTRA_3X_V3",
  "ULTRA_4X_V3",
  "ULTRA_5X_V3",
  "BYOA_V3",
]);

// ---- Core entities (registered records) -------------------------------- //

export const organizationSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  providerHandle: z.string(),
  providerType: providerTypeSchema,
  privacyMode: z.boolean(),
  seatAllocation: seatAllocationSchema,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const userSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  providerId: z.string(),
  providerHandle: z.string(),
  providerType: providerTypeSchema,
  email: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  activatedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  lastSeenAt: z.coerce.date().nullable(),
  privacyMode: z.boolean(),
  isLearningEnabled: z.boolean(),
});

export const teamSchema = z.object({
  id: z.string(),
  slug: z.string(),
  avatarUrl: z.string().nullable(),
  privacyMode: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const subscriptionSchema = z.object({
  id: z.string(),
  userID: z.string().nullable(),
  orgID: z.string().nullable(),
  teamID: z.string().nullable(),
  customerId: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  subscriptionExpiry: z.coerce.date().nullable(),
  trialEndsAt: z.coerce.date().nullable(),
  subscriptionStatus: subscriptionStatusSchema,
  hasPaymentMethod: z.boolean().nullable(),
});

export const creditSchema = z.object({
  id: z.string(),
  userId: z.string(),
  customerId: z.string(),
  bonusCredits: z.number(),
  consumedFromPlan: z.number(),
  consumedFromBonus: z.number(),
  lastResetAt: z.coerce.date(),
});

export const payAsYouGoUsageSchema = z.object({
  allowPayAsYouGo: z.boolean(),
});

export const bundleSummarySchema = z.object({
  bundleTotal: z.number(),
  bundleConsumed: z.number(),
  bundleRemaining: z.number(),
});

// ---- Non-record extension shapes --------------------------------------- //

export const organizationCreditSchema = creditSchema.extend({
  orgId: z.string(),
});

export const traycerOrganizationSubscriptionSchema = subscriptionSchema.extend({
  organization: organizationSchema.optional(),
  isInTrial: z.boolean(),
  bundleSummary: bundleSummarySchema.optional(),
  credit: organizationCreditSchema.optional(),
  totalPlanCredits: z.number().optional(),
  rechargeRateSeconds: z.number(),
  hasActiveBundle: z.boolean().optional(),
});

export const traycerUserSubscriptionSchema = subscriptionSchema.extend({
  isInTrial: z.boolean(),
  bundleSummary: bundleSummarySchema.optional(),
  credit: creditSchema.optional(),
  totalPlanCredits: z.number().optional(),
  rechargeRateSeconds: z.number(),
  hasActiveBundle: z.boolean().optional(),
});

export const traycerTeamSubscriptionSchema = subscriptionSchema.extend({
  team: teamSchema,
  isInTrial: z.boolean(),
  bundleSummary: bundleSummarySchema,
  credit: organizationCreditSchema.optional(),
  totalPlanCredits: z.number(),
  rechargeRateSeconds: z.number(),
  hasActiveBundle: z.boolean(),
});

export const authenticatedUserBaseSchema = z.object({
  user: userSchema,
  userSubscription: traycerUserSubscriptionSchema,
  payAsYouGoUsage: payAsYouGoUsageSchema,
});

// ---- Authenticated-user response records ------------------------------- //

export const authenticatedUserSchema = authenticatedUserBaseSchema.extend({
  teamSubscriptions: z.array(traycerTeamSubscriptionSchema),
});

export const legacyAuthenticatedUserSchema = authenticatedUserBaseSchema.extend(
  {
    organizationSubscription: traycerOrganizationSubscriptionSchema.optional(),
    rechargeRateSeconds: z.number(),
    organizationSubscriptions: z
      .array(traycerOrganizationSubscriptionSchema)
      .optional(),
  },
);

// ---- HTTP response envelopes (token / auth) ---------------------------- //

// Existing cloud-ui/extension auth routes return a single opaque combined JWE
// token. The app-stack `/api/v3/auth/*` routes return a JWS access token plus
// a separate refresh token.
export const providerLoginResponseSchema = z.object({
  token: z.string(),
  refreshToken: z.string().optional(),
  user: userSchema,
});

export const refreshTokenResponseSchema = z.object({
  token: z.string(),
  refreshToken: z.string().optional(),
});

export const exchangeTokenResponseSchema = refreshTokenResponseSchema.extend({
  user: authenticatedUserSchema,
});

export const validateCouponResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    valid: z.boolean(),
  }),
  z.object({
    ok: z.literal(false),
    error: z.string(),
  }),
]);

export const emailOtpResponseSchema = z.object({
  success: z.boolean(),
});

// ---- MCP server entities ----------------------------------------------- //

export const mcpServerStatusSchema = z.enum([
  "CONNECTED",
  "CONNECTING",
  "DISCONNECTED",
  "UNAUTHORIZED",
  "AUTHORIZING",
  "AUTHORIZATION_FAILED",
]);

export const mcpServerAuthTypeSchema = z.enum(["NO_AUTH", "PAT", "OAUTH"]);

export const mcpServerRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  status: mcpServerStatusSchema,
  userId: z.string().nullable(),
  orgId: z.string().nullable(),
  teamId: z.string().nullable(),
  isConsentGiven: z.boolean(),
  authType: mcpServerAuthTypeSchema,
  patEncrypted: z.string().nullable(),
  patIV: z.string().nullable(),
  patTag: z.string().nullable(),
  customHeadersEncrypted: z.string().nullable(),
  customHeadersIV: z.string().nullable(),
  customHeadersTag: z.string().nullable(),
  oauthAccessTokenEncrypted: z.string().nullable(),
  oauthAccessTokenIV: z.string().nullable(),
  oauthAccessTokenTag: z.string().nullable(),
  oauthAccessTokenExpiresAt: z.coerce.date().nullable(),
  oauthRefreshTokenEncrypted: z.string().nullable(),
  oauthRefreshTokenIV: z.string().nullable(),
  oauthRefreshTokenTag: z.string().nullable(),
  oauthClientId: z.string().nullable(),
  oauthClientSecretEncrypted: z.string().nullable(),
  oauthClientSecretIV: z.string().nullable(),
  oauthClientSecretTag: z.string().nullable(),
  enabledToolNames: z.unknown(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const mcpToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
});

export const mcpServerSchema = mcpServerRowSchema.extend({
  tools: z.array(mcpToolSchema),
  instructions: z.string().nullable(),
  customHeaderKeys: z.array(z.string()),
});

// ---- MCP HTTP response envelopes --------------------------------------- //

export const installMcpServerResponseSchema = z.object({
  server: mcpServerSchema,
  authorizationUrl: z.string().nullable(),
});

export const listMcpServersResponseSchema = z.object({
  servers: z.array(mcpServerSchema),
});

export const refreshMcpServersResponseSchema = listMcpServersResponseSchema;

export const userMcpServersSchema = z.object({
  user: userSchema,
  servers: z.array(mcpServerSchema),
});

export const organizationMcpServersSchema = z.object({
  organization: organizationSchema,
  servers: z.array(mcpServerSchema),
});

export const listAllMcpServersResponseSchema = z.object({
  user: userMcpServersSchema,
  organizations: z.array(organizationMcpServersSchema),
});

export const disconnectMcpServerResponseSchema = listMcpServersResponseSchema;

export const connectMcpServerResponseSchema = installMcpServerResponseSchema;

export const updateMcpServerResponseSchema = installMcpServerResponseSchema;

export const listMcpServerToolsResponseSchema = z.array(mcpToolSchema);

export const executeMcpServerToolResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    result: z.string(),
  }),
  z.object({
    ok: z.literal(false),
    error: z.string(),
  }),
]);
