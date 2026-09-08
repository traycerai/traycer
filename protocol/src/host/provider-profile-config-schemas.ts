/**
 * Wire shapes for the profile-config surface: eight brand-new `providers.*`
 * methods (D21) that read/write a managed profile's own config, sign in an
 * API-key profile, and copy settings between profiles. None of these shapes
 * backs a frozen line — `provider-schemas.ts` is the frozen-line museum for
 * `providers.list` and friends; this file owns only the new methods.
 */
import { z } from "zod";
import {
  profileCategoryOwnershipSchema,
  profileCredentialKindSchema,
  providerEnvOverrideSchema,
  providerIdSchema,
  providerProfileAccentColorSchema,
  type ProfileCategoryOwnership,
  type ProfileCredentialKind,
} from "@traycer/protocol/host/provider-schemas";

// D02 (`linked | own`) and D06 (`api_key | auth_token`) are DEFINED in
// `provider-schemas.ts` because the `providers.list@9.0` row spells both too,
// and re-exported here so every consumer of the profile-config surface keeps
// importing them from this module (rule 11: one spelling per fact).
export {
  profileCategoryOwnershipSchema,
  profileCredentialKindSchema,
  type ProfileCategoryOwnership,
  type ProfileCredentialKind,
};

/**
 * D20 / critique B2: `providerSelectionSchema` (`provider-schemas.ts:279`)
 * has no managed arm and must never grow one. This union is used ONLY by the
 * profile-config surface.
 */
export const profileCliSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bundled") }),
  z.object({ kind: z.literal("path") }),
  z.object({ kind: z.literal("custom"), path: z.string().min(1) }),
  z.object({ kind: z.literal("managed"), version: z.string().min(1) }),
]);
export type ProfileCliSelection = z.infer<typeof profileCliSelectionSchema>;

/** D10. `reason` is already scrubbed host-side; capped at 512 chars. */
export const profileEndpointTestVerdictSchema = z.object({
  at: z.number(),
  ok: z.boolean(),
  reason: z.string().max(512).nullable(),
});
export type ProfileEndpointTestVerdict = z.infer<
  typeof profileEndpointTestVerdictSchema
>;

/** D06/D07: configured-ness is a boolean. The credential never rides. */
export const profileEndpointConfigSchema = z.object({
  baseUrl: z.string().nullable(),
  credentialKind: profileCredentialKindSchema,
  credentialConfigured: z.boolean(),
  defaultModel: z.string().nullable(),
  lastTest: profileEndpointTestVerdictSchema.nullable(),
});
export type ProfileEndpointConfig = z.infer<typeof profileEndpointConfigSchema>;

/**
 * D01/D15: the WHOLE config of one profile - every key is always present and
 * a write replaces all of them. This is never a sparse patch, so there is no
 * "leave this alone" encoding here (the credential, which does need one, is a
 * separate three-armed field on the set request). Never carries a credential.
 */
export const profileConfigSchema = z.object({
  cliSelection: profileCliSelectionSchema.nullable(), // null = the default account's (D20 fallback)
  terminalAgentArgs: z.string(),
  env: z.array(providerEnvOverrideSchema),
  endpoint: profileEndpointConfigSchema.nullable(),
  skills: profileCategoryOwnershipSchema,
  plugins: profileCategoryOwnershipSchema,
});
export type ProfileConfig = z.infer<typeof profileConfigSchema>;

/** `null` = the default account (D05: wire `kind:"ambient"`, internal `profileId: null`). */
const profileTargetSchema = z.string().nullable();

/** D01: reads one profile's whole config. `profileId: null` = default account. */
export const providersGetProfileConfigRequestSchema = z.object({
  providerId: providerIdSchema,
  profileId: profileTargetSchema,
});
export type ProvidersGetProfileConfigRequest = z.infer<
  typeof providersGetProfileConfigRequestSchema
>;

/** D01/D15: the WHOLE resolved config, never a patch. Carries no credential. */
export const providersGetProfileConfigResponseSchema = z.object({
  config: profileConfigSchema,
});
export type ProvidersGetProfileConfigResponse = z.infer<
  typeof providersGetProfileConfigResponseSchema
>;

/**
 * D01 full ownership + D15 LWW: the whole config, never a sparse patch, and
 * no revision token. The credential is a three-armed update so "leave it
 * alone" is expressible without a magic null.
 */
export const providersSetProfileConfigRequestSchema = z.object({
  providerId: providerIdSchema,
  profileId: profileTargetSchema,
  config: profileConfigSchema,
  credentialUpdate: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("unchanged") }),
    z.object({ kind: z.literal("set"), value: z.string().min(1) }),
    z.object({ kind: z.literal("clear") }),
  ]),
});
export type ProvidersSetProfileConfigRequest = z.infer<
  typeof providersSetProfileConfigRequestSchema
>;

/** D01/D15: the config as stored after the write - the client re-renders from
 *  this rather than from its own optimistic copy. */
export const providersSetProfileConfigResponseSchema = z.object({
  config: profileConfigSchema,
});
export type ProvidersSetProfileConfigResponse = z.infer<
  typeof providersSetProfileConfigResponseSchema
>;

/** D02. Managed profiles only — the default account is always `own`. */
export const providersSetProfileOwnershipRequestSchema = z.object({
  providerId: providerIdSchema,
  profileId: z.string().min(1),
  category: z.enum(["skills", "plugins"]),
  ownership: profileCategoryOwnershipSchema,
});
export type ProvidersSetProfileOwnershipRequest = z.infer<
  typeof providersSetProfileOwnershipRequestSchema
>;

/** D02: the config after the Linked/Own flip, same re-render contract as
 *  `providersSetProfileConfigResponseSchema`. */
export const providersSetProfileOwnershipResponseSchema = z.object({
  config: profileConfigSchema,
});
export type ProvidersSetProfileOwnershipResponse = z.infer<
  typeof providersSetProfileOwnershipResponseSchema
>;

/** D32 "Start from". `empty` seeds nothing. */
export const profileSeedSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("empty") }),
  z.object({ kind: z.literal("defaultAccount") }),
  z.object({ kind: z.literal("profile"), profileId: z.string().min(1) }),
]);
export type ProfileSeedSource = z.infer<typeof profileSeedSourceSchema>;

/**
 * D06/D10/D32: mints an API-key profile in one call - label, accent, "Start
 * from" seed, endpoint and the credential. The credential is the ONE inbound
 * secret on this surface (D07 forbids it outbound); the host tests it before
 * the profile is kept, so a create that fails the test leaves nothing behind.
 */
export const providersCreateApiKeyProfileRequestSchema = z.object({
  providerId: providerIdSchema,
  // Same 64-char cap as `providerProfileActionSchema`'s rename label.
  label: z.string().min(1).max(64),
  accentColor: providerProfileAccentColorSchema.nullable(),
  startFrom: profileSeedSourceSchema,
  endpoint: z.object({
    baseUrl: z.string().nullable(),
    credentialKind: profileCredentialKindSchema,
    defaultModel: z.string().nullable(),
  }),
  credential: z.string().min(1),
});
export type ProvidersCreateApiKeyProfileRequest = z.infer<
  typeof providersCreateApiKeyProfileRequestSchema
>;

/**
 * D10: "Saving an API-key profile requires a passing test". A failed test is
 * an ORDINARY outcome (draft deleted, scrubbed reason shown), not an RPC
 * error — a thrown error reaches the GUI as a generic failure and loses the
 * reason.
 */
export const providersCreateApiKeyProfileResponseSchema = z.discriminatedUnion(
  "ok",
  [
    z.object({
      ok: z.literal(true),
      profileId: z.string().min(1),
      verdict: profileEndpointTestVerdictSchema,
    }),
    z.object({ ok: z.literal(false), reason: z.string().max(512) }),
  ],
);
export type ProvidersCreateApiKeyProfileResponse = z.infer<
  typeof providersCreateApiKeyProfileResponseSchema
>;

/** D10: tests the profile's STORED endpoint config; the credential never
 *  rides the request. `profileId: null` = default account. */
export const providersTestProfileConnectionRequestSchema = z.object({
  providerId: providerIdSchema,
  profileId: profileTargetSchema,
});
export type ProvidersTestProfileConnectionRequest = z.infer<
  typeof providersTestProfileConnectionRequestSchema
>;

/** D10: a failed test is an ordinary verdict, never an RPC error - same
 *  reasoning as `providersCreateApiKeyProfileResponseSchema` below. */
export const providersTestProfileConnectionResponseSchema = z.object({
  verdict: profileEndpointTestVerdictSchema,
});
export type ProvidersTestProfileConnectionResponse = z.infer<
  typeof providersTestProfileConnectionResponseSchema
>;

// ── Copy settings (D13; internal noun "sync", D26) ─────────────────────────

/** D13: the copyable categories. Credentials are absent by construction. */
export const copySettingsCategorySchema = z.enum([
  "cliArgs",
  "env",
  "mcp",
  "skills",
  "plugins",
  "endpoint",
]);
export type CopySettingsCategory = z.infer<typeof copySettingsCategorySchema>;

/** D13: source is the default account or a managed profile — never `empty`. */
export const copySettingsSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("defaultAccount") }),
  z.object({ kind: z.literal("profile"), profileId: z.string().min(1) }),
]);
export type CopySettingsSource = z.infer<typeof copySettingsSourceSchema>;

/** Plan §7: preview and apply take the SAME input. */
export const providersCopySettingsRequestSchema = z.object({
  providerId: providerIdSchema,
  source: copySettingsSourceSchema,
  targets: z.array(z.string().min(1)).min(1), // managed profiles only (D13)
  categories: z.array(copySettingsCategorySchema).min(1),
});
export type ProvidersCopySettingsRequest = z.infer<
  typeof providersCopySettingsRequestSchema
>;

/**
 * NAMES ONLY. D13 copies env values and MCP `env`/`headers` with their
 * category; the review says so via `carriesSecretValues` and never puts a
 * value on the wire.
 */
export const copySettingsCategoryPreviewSchema = z.object({
  category: copySettingsCategorySchema,
  adds: z.array(z.string()),
  changes: z.array(z.string()),
  removals: z.array(z.string()),
  carriesSecretValues: z.boolean(),
  ownershipFlip: z.enum(["none", "linkedToOwn"]), // D02 Linked→Own flip
  noop: z.boolean(), // D13: Linked→Linked is a stated no-op
});
export type CopySettingsCategoryPreview = z.infer<
  typeof copySettingsCategoryPreviewSchema
>;

/** D13: NAMES ONLY, per target profile - the preview never carries a copied
 *  value, only what would be added/changed/removed. */
export const providersPreviewCopySettingsResponseSchema = z.object({
  targets: z.array(
    z.object({
      profileId: z.string().min(1),
      label: z.string(),
      categories: z.array(copySettingsCategoryPreviewSchema),
    }),
  ),
});
export type ProvidersPreviewCopySettingsResponse = z.infer<
  typeof providersPreviewCopySettingsResponseSchema
>;

/** D13: per-target outcome. One target failing never fails the batch, so the
 *  result is a list of verdicts rather than a thrown error. */
export const providersApplyCopySettingsResponseSchema = z.object({
  results: z.array(
    z.object({
      profileId: z.string().min(1),
      outcome: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("copied") }),
        z.object({ kind: z.literal("failed"), reason: z.string().max(512) }),
      ]),
    }),
  ),
});
export type ProvidersApplyCopySettingsResponse = z.infer<
  typeof providersApplyCopySettingsResponseSchema
>;

/**
 * D24 (amended, critique B5). This response DOES carry the resolved
 * credential env — the one exception to D07 — so it is served only when
 * `ctx.transportVantage === "local-ws"` (`host-transport/vantage.ts`, "the
 * only unforgeable statement of caller locality") and refused with
 * `E_METHOD_LOCAL_ONLY` on every other path. Enforcement is W5-T3's resolver;
 * this sentence stays in the doc comment so nobody wires a second caller.
 */
export const providersResolveLaunchEnvRequestSchema = z.object({
  providerId: providerIdSchema,
  profileId: z.string().min(1),
});
export type ProvidersResolveLaunchEnvRequest = z.infer<
  typeof providersResolveLaunchEnvRequestSchema
>;

export const providersResolveLaunchEnvResponseSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  cwd: z.string().nullable(),
});
export type ProvidersResolveLaunchEnvResponse = z.infer<
  typeof providersResolveLaunchEnvResponseSchema
>;
