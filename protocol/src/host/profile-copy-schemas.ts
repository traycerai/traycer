import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/** Wire limits, independent of provider binary/admission versions. */
export const PROFILE_COPY_MAX_PAYLOAD_BYTES = 256 * 1024;
export const PROFILE_COPY_MAX_DESTINATIONS = 16;
export const PROFILE_COPY_MAX_INCOMING_PAGE = 50;
export const profileCopyIdSchema = lazySchema(() => z.string().uuid());
export const profileCopyHostIdSchema = lazySchema(() =>
  z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
);
export const profileCopyRevisionSchema = lazySchema(() =>
  z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
);
export const profileCopyProviderSchema = lazySchema(() =>
  z.enum(["claude", "codex", "grok", "antigravity"]),
);
export const profileCopyAuthMethodSchema = lazySchema(() =>
  z.enum([
    "claude-subscription",
    "codex-chatgpt",
    "grok-oauth",
    "oauth-personal",
    "gemini-api-key",
    "other",
  ]),
);
const fingerprintSchema = lazySchema(() => z.string().regex(/^[a-f0-9]{64}$/));

export const profileCopySourceSchema = lazySchema(() =>
  z.strictObject({
    sourceHostId: profileCopyHostIdSchema,
    sourceProfileId: profileCopyIdSchema,
    providerId: profileCopyProviderSchema,
  }),
);
/** Immutable throughout one attempt, including receipt lookup and cancellation. */
export const profileCopyAttemptSchema = lazySchema(() =>
  profileCopySourceSchema
    .extend({
      operationId: profileCopyIdSchema,
      attemptId: profileCopyIdSchema,
      destinationHostId: profileCopyHostIdSchema,
    })
    .refine((value) => value.sourceHostId !== value.destinationHostId, {
      message: "Source and destination must differ",
    }),
);
export type ProfileCopyAttempt = z.infer<typeof profileCopyAttemptSchema>;

export const profileCopyMetadataSchema = lazySchema(() =>
  z.strictObject({
    name: z.string().min(1).max(128),
    color: z.string().regex(/^#[a-fA-F0-9]{6}$/),
    desiredEnabled: z.boolean(),
    skillsPluginsShared: z.boolean(),
  }),
);

/** Provider evidence, never a Traycer account authority supplied by a caller.
 * Kept only on host-to-host preflight/import; public status uses a verdict.
 * The source snapshot is immutable. Local metadata cannot assert online proof.
 */
export const profileCopyIdentityEvidenceSchema = lazySchema(() =>
  z.strictObject({
    revision: profileCopyRevisionSchema,
    observedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    provenance: z.enum(["provider-verified", "local-metadata", "unavailable"]),
    issuer: z.enum(["anthropic", "openai", "xai", "google"]).nullable(),
    accountId: z.string().min(1).max(512).nullable(),
    principalId: z.string().min(1).max(512).nullable(),
  }),
);

/** `directory-unavailable`: a host could not read this account's host directory,
 * so the host pair could not be authorized right now. Distinct from
 * `unreachable` (the host answered) and from `update-required`. */
export const profileCopyReasonSchema = lazySchema(() =>
  z.enum([
    "update-required",
    "unreachable",
    "directory-unavailable",
    "install-required",
    "unsupported-platform",
    "unsupported-auth",
    "adapter-not-admitted",
    "manual-login-unavailable",
    "destination-local-login-required",
    "device-auth-unavailable",
    "login-resource-busy",
    "login-start-unavailable",
    "writer-unconfirmed",
    "credential-invalid",
    "credential-missing",
    "credential-malformed",
    "verification-unavailable",
    "verification-timeout",
    "provider-unavailable",
    "identity-unavailable",
    "identity-mismatch",
    "source-changed",
    "stale-revision",
    "request-conflict",
    "target-removed",
    "cancelled",
    "internal-error",
  ]),
);

/** Independent capabilities: missing automatic admission proves nothing about login. */
export const profileCopyFeasibilitySchema = lazySchema(() =>
  z.strictObject({
    automatic: z.discriminatedUnion("status", [
      z.strictObject({
        status: z.literal("available"),
        admissionRevision: fingerprintSchema,
      }),
      z.strictObject({
        status: z.literal("unavailable"),
        reason: profileCopyReasonSchema,
      }),
    ]),
    manual: z.discriminatedUnion("status", [
      z.strictObject({
        status: z.literal("available"),
        route: z.enum([
          "code-paste",
          "device-code",
          "destination-local-browser",
        ]),
        admissionRevision: fingerprintSchema,
      }),
      z.strictObject({
        status: z.literal("unavailable"),
        reason: profileCopyReasonSchema,
      }),
    ]),
  }),
);

export const profileCopyReadinessSchema = lazySchema(() =>
  z.strictObject({
    preparation: z.enum(["incomplete", "complete"]),
    verification: z.enum([
      "not-checked",
      "verified",
      "invalid",
      "indeterminate",
    ]),
    verificationRevision: profileCopyRevisionSchema.nullable(),
    acceptedVerificationRevision: profileCopyRevisionSchema.nullable(),
    identity: z.enum(["not-checked", "match", "mismatch", "unavailable"]),
    identityRevision: profileCopyRevisionSchema.nullable(),
    acceptedIdentityRevision: profileCopyRevisionSchema.nullable(),
    writer: z.enum(["none", "outstanding", "unconfirmed"]),
    writerGeneration: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    quarantined: z.boolean(),
  }),
);

/** No raw error, path, provider identity or credential fields in status/receipts. */
export const profileCopyOutcomeSchema = lazySchema(() =>
  z.strictObject({
    attempt: profileCopyAttemptSchema,
    revision: profileCopyRevisionSchema,
    state: z.enum([
      "preparing",
      "sign-in-required",
      "signing-in",
      "verifying",
      "verification-pending",
      "account-confirmation-required",
      "ready",
      "signed-in",
      "used-without-verification",
      "already-present",
      "blocked",
      "failed",
      "cancelled",
      "quarantined",
      "outcome-unknown",
      "removed",
    ]),
    reason: profileCopyReasonSchema.nullable(),
    targetProfileId: profileCopyIdSchema.nullable(),
    // Existing-profile display facts, not proof of import credential verification.
    targetEnabled: z.boolean().nullable(),
    targetAuthStatus: z
      .enum(["authenticated", "unauthenticated", "unknown"])
      .nullable(),
    replacementAttemptId: profileCopyIdSchema.nullable(),
    desiredEnabled: z.boolean(),
    destinationProviderEnabled: z.boolean(),
    readiness: profileCopyReadinessSchema,
  }),
);
export type ProfileCopyOutcome = z.infer<typeof profileCopyOutcomeSchema>;

const destinationsSchema = lazySchema(() =>
  z
    .array(profileCopyHostIdSchema)
    .min(1)
    .max(PROFILE_COPY_MAX_DESTINATIONS)
    .refine((values) => new Set(values).size === values.length, {
      message: "Duplicate destination",
    }),
);
export const profileCopyPreviewRequestSchema = lazySchema(() =>
  profileCopySourceSchema
    .extend({
      destinationHostIds: destinationsSchema,
    })
    .refine((value) => !value.destinationHostIds.includes(value.sourceHostId), {
      message: "Source cannot be a destination",
    }),
);
export const profileCopyPreviewDestinationSchema = lazySchema(() =>
  z.strictObject({
    destinationHostId: profileCopyHostIdSchema,
    feasibility: profileCopyFeasibilitySchema,
    disposition: z.enum([
      "automatic",
      "manual",
      "already-present",
      "unavailable",
    ]),
    reason: profileCopyReasonSchema.nullable(),
    existingProfileId: profileCopyIdSchema.nullable(),
    destinationProviderEnabled: z.boolean().nullable(),
  }),
);
export const profileCopyPreviewResponseSchema = lazySchema(() =>
  z.strictObject({
    source: profileCopySourceSchema,
    previewRevision: fingerprintSchema,
    destinations: z
      .array(profileCopyPreviewDestinationSchema)
      .max(PROFILE_COPY_MAX_DESTINATIONS),
  }),
);
export const profileCopyStartRequestSchema = lazySchema(() =>
  profileCopyPreviewRequestSchema.safeExtend({
    operationId: profileCopyIdSchema,
    previewRevision: fingerprintSchema,
  }),
);
export const profileCopyOperationRequestSchema = lazySchema(() =>
  z.strictObject({
    sourceHostId: profileCopyHostIdSchema,
    operationId: profileCopyIdSchema,
  }),
);
export const profileCopyOperationResponseSchema = lazySchema(() =>
  z.strictObject({
    sourceHostId: profileCopyHostIdSchema,
    operationId: profileCopyIdSchema,
    outcomes: z
      .array(profileCopyOutcomeSchema)
      .max(PROFILE_COPY_MAX_DESTINATIONS),
  }),
);
export const profileCopyIncomingRequestSchema = lazySchema(() =>
  z.strictObject({
    destinationHostId: profileCopyHostIdSchema,
    cursor: profileCopyIdSchema.nullable(),
    limit: z.number().int().min(1).max(PROFILE_COPY_MAX_INCOMING_PAGE),
  }),
);
export const profileCopyIncomingResponseSchema = lazySchema(() =>
  z.strictObject({
    drafts: z
      .array(
        z.strictObject({
          metadata: profileCopyMetadataSchema,
          outcome: profileCopyOutcomeSchema,
        }),
      )
      .max(PROFILE_COPY_MAX_INCOMING_PAGE),
    nextCursor: profileCopyIdSchema.nullable(),
  }),
);
export const profileCopyDraftRequestSchema = lazySchema(() =>
  z.strictObject({
    attempt: profileCopyAttemptSchema,
  }),
);
export const profileCopyRevisionRequestSchema = lazySchema(() =>
  profileCopyDraftRequestSchema.extend({
    expectedRevision: profileCopyRevisionSchema,
  }),
);
export const profileCopyDraftResponseSchema = lazySchema(() =>
  z.strictObject({
    result: z.enum(["current", "stale-revision", "unavailable"]),
    outcome: profileCopyOutcomeSchema,
  }),
);
export const profileCopyPreferenceRequestSchema = lazySchema(() =>
  profileCopyRevisionRequestSchema.extend({
    desiredEnabled: z.boolean(),
  }),
);
export const profileCopyVerificationDecisionRequestSchema = lazySchema(() =>
  profileCopyRevisionRequestSchema.extend({
    verificationRevision: profileCopyRevisionSchema,
    decision: z.literal("accept-indeterminate"),
  }),
);
export const profileCopyIdentityDecisionRequestSchema = lazySchema(() =>
  profileCopyRevisionRequestSchema.extend({
    identityRevision: profileCopyRevisionSchema,
    decision: z.enum(["accept-mismatch", "accept-unavailable"]),
  }),
);
export const profileCopyRetryRequestSchema = lazySchema(() =>
  profileCopyRevisionRequestSchema.extend({
    retryRequestId: profileCopyIdSchema,
  }),
);

export const profileCopyLoginControlRequestSchema = lazySchema(() =>
  profileCopyRevisionRequestSchema.extend({
    loginAttemptId: profileCopyIdSchema,
  }),
);
export const profileCopySubmitCodeRequestSchema = lazySchema(() =>
  profileCopyLoginControlRequestSchema.extend({
    code: z.string().min(1).max(8192),
  }),
);
/** Transient login presentation only; never journal these challenges in receipts.
 * T4 validates canonical provider URLs and actual viewer locality at start.
 */
export const profileCopyLoginResponseSchema = lazySchema(() =>
  z.strictObject({
    outcome: profileCopyOutcomeSchema,
    loginAttemptId: profileCopyIdSchema.nullable(),
    challenge: z
      .discriminatedUnion("kind", [
        z.strictObject({
          kind: z.literal("code-paste"),
          url: z.url().max(8192),
        }),
        z.strictObject({
          kind: z.literal("device-code"),
          url: z.url().max(8192),
          userCode: z.string().min(1).max(128),
        }),
        z.strictObject({
          kind: z.literal("destination-local-browser"),
          url: z.url().max(8192),
        }),
      ])
      .nullable(),
  }),
);

/** Manual selection preserves auth intent; it never substitutes another method. */
const manualSelectionSchema = lazySchema(() =>
  z.union([
    z.strictObject({
      providerId: z.literal("claude"),
      authMethod: z.enum(["claude-subscription", "other"]),
    }),
    z.strictObject({
      providerId: z.literal("codex"),
      authMethod: z.enum(["codex-chatgpt", "other"]),
    }),
    z.strictObject({
      providerId: z.literal("grok"),
      authMethod: z.enum(["grok-oauth", "other"]),
    }),
    z.strictObject({
      providerId: z.literal("antigravity"),
      authMethod: z.enum(["oauth-personal", "gemini-api-key", "other"]),
    }),
  ]),
);
export const profileCopySelectedAuthSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("manual"),
      selection: manualSelectionSchema,
    }),
    z.strictObject({
      kind: z.literal("antigravity-api-key"),
      providerId: z.literal("antigravity"),
      authMethod: z.literal("gemini-api-key"),
      apiKey: z.string().min(1).max(PROFILE_COPY_MAX_PAYLOAD_BYTES),
    }),
  ]),
);
/** OAuth export shapes await measured admission/allowlists in T7; not arbitrary JSON. */
export const profileCopyPayloadSchema = lazySchema(() =>
  z
    .strictObject({
      schemaVersion: z.literal(1),
      metadata: profileCopyMetadataSchema,
      selectedAuth: profileCopySelectedAuthSchema,
    })
    .refine(
      (value) =>
        new TextEncoder().encode(JSON.stringify(value)).byteLength <=
        PROFILE_COPY_MAX_PAYLOAD_BYTES,
      {
        message: "Profile payload exceeds byte limit",
      },
    ),
);
export type ProfileCopyPayload = z.infer<typeof profileCopyPayloadSchema>;
export const hostProfileCopyPreflightRequestSchema = lazySchema(() =>
  z
    .strictObject({
      attempt: profileCopyAttemptSchema,
      selection: manualSelectionSchema,
      sourceIdentity: profileCopyIdentityEvidenceSchema,
    })
    .refine(
      (value) => value.attempt.providerId === value.selection.providerId,
      {
        message: "Provider mismatch",
      },
    ),
);
export const hostProfileCopyPreflightResponseSchema = lazySchema(() =>
  z.strictObject({
    attempt: profileCopyAttemptSchema,
    destination: profileCopyPreviewDestinationSchema,
  }),
);
/** `retryOfAttemptId` names the terminal attempt this one replaces, as the
 * source recorded it. The destination hands it to its import store unchanged;
 * it never derives a predecessor itself. */
export const hostProfileCopyImportRequestSchema = lazySchema(() =>
  z
    .strictObject({
      attempt: profileCopyAttemptSchema,
      requestFingerprint: fingerprintSchema,
      sourceIdentity: profileCopyIdentityEvidenceSchema,
      retryOfAttemptId: profileCopyIdSchema.nullable(),
      payload: profileCopyPayloadSchema,
    })
    .refine(
      (value) =>
        value.attempt.providerId ===
        (value.payload.selectedAuth.kind === "manual"
          ? value.payload.selectedAuth.selection.providerId
          : value.payload.selectedAuth.providerId),
      { message: "Provider mismatch" },
    )
    .refine((value) => value.retryOfAttemptId !== value.attempt.attemptId, {
      message: "An attempt cannot replace itself",
    })
    .refine(
      (value) =>
        value.retryOfAttemptId === null ||
        value.payload.selectedAuth.kind === "manual" ||
        value.payload.selectedAuth.kind === "antigravity-api-key",
      { message: "Unsupported replacement shape" },
    )
    .refine(
      (value) =>
        new TextEncoder().encode(JSON.stringify(value)).byteLength <=
        PROFILE_COPY_MAX_PAYLOAD_BYTES,
      { message: "Profile import exceeds byte limit" },
    ),
);
export const hostProfileCopyReceiptResponseSchema = lazySchema(() =>
  z.discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("recorded"),
      outcome: profileCopyOutcomeSchema,
    }),
    z.strictObject({
      status: z.literal("not-admitted"),
      attempt: profileCopyAttemptSchema,
    }),
    z.strictObject({
      status: z.literal("outcome-unknown"),
      attempt: profileCopyAttemptSchema,
    }),
  ]),
);

export type ProfileCopySource = z.infer<typeof profileCopySourceSchema>;
export type ProfileCopyMetadata = z.infer<typeof profileCopyMetadataSchema>;
export type ProfileCopyReadiness = z.infer<typeof profileCopyReadinessSchema>;
export type ProfileCopyIdentityEvidence = z.infer<
  typeof profileCopyIdentityEvidenceSchema
>;
export type ProfileCopyFeasibility = z.infer<
  typeof profileCopyFeasibilitySchema
>;
export type ProfileCopySelectedAuth = z.infer<
  typeof profileCopySelectedAuthSchema
>;
