import { z } from "zod";
import { lazySchema } from "../framework/lazy-schema";

/** Provider-stated spend scope. Display names and email never qualify an id. */
export const spendScopeKeySchema = lazySchema(() =>
  z.union([
    z.strictObject({
      providerId: z.string().min(1),
      accountId: z.string().min(1),
      organizationId: z.string().min(1).nullable(),
    }),
    z.strictObject({ providerId: z.string().min(1), email: z.string().min(1) }),
  ]),
);
export type SpendScopeKey = z.infer<typeof spendScopeKeySchema>;

export const credentialIdentitySchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("spend-scoped"),
      spendScopeKey: spendScopeKeySchema,
      provenance: z.string().min(1),
    }),
    z.strictObject({
      kind: z.literal("unidentified"),
      provenance: z.string().min(1),
      reason: z.string().min(1),
    }),
    z.strictObject({
      kind: z.literal("accountless"),
      provenance: z.string().min(1),
      reason: z.string().min(1),
    }),
  ]),
);
export type CredentialIdentity = z.infer<typeof credentialIdentitySchema>;

export const credentialVersionSchema = lazySchema(() =>
  z.union([
    z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    z.literal("unknown"),
  ]),
);
export type CredentialVersion = z.infer<typeof credentialVersionSchema>;

/** Material standing and the authority of the observation that established it. */
export const credentialStandingSchema = lazySchema(() =>
  z.strictObject({
    material: z
      .enum([
        "usable",
        "stale",
        "signed-out",
        "rejected",
        "refused-by-provider",
      ])
      .nullable(),
    repairDeadline: z.number().nullable(),
    familyVersion: z.string().min(1).nullable(),
    authority: z.enum(["provider-client", "custodian"]).nullable(),
    cause: z.string().nullable(),
    observation: z.strictObject({
      source: z.enum(["provider-client", "custodian", "install", "sign-out"]),
      status: z.enum(["answered", "unknown"]),
      capturedAt: z.number(),
    }),
  }),
);
export type CredentialStanding = z.infer<typeof credentialStandingSchema>;

export const environmentPresenceCauseSchema = lazySchema(() =>
  z.enum([
    "host-left-environment",
    "profile-account-changed",
    "signed-out-by-person",
  ]),
);

/** Why another entry or an unverified native store remains after this account leaves. */
export const credentialMaterialRetainedReasonSchema = lazySchema(() =>
  z.enum([
    "material-changed",
    "foreign-entry",
    "unreadable-entry",
    "unsupported-store",
    "linked-location",
    "home-changed",
    "store-changed",
    "write-failed",
    "shared-settings",
    "unverified-material",
  ]),
);
export type CredentialMaterialRetainedReason = z.infer<
  typeof credentialMaterialRetainedReasonSchema
>;

export const credentialHomeSchema = lazySchema(() =>
  z.strictObject({
    homeAddress: z.string().min(1),
    bindingVersion: credentialVersionSchema,
    materialRevision: credentialVersionSchema,
    custodyVersion: credentialVersionSchema,
    custodyClass: z.enum([
      "self-sufficient",
      "brokered",
      "transitional",
      "unknown",
    ]),
    environmentPresence: z
      .discriminatedUnion("scope", [
        z.strictObject({
          scope: z.literal("environment"),
          environmentId: z.string().min(1),
          state: z.enum(["admitted", "revoking", "absent"]),
          retainedReason: credentialMaterialRetainedReasonSchema.nullable().catch(null),
          cause: environmentPresenceCauseSchema.nullable().catch(null),
        }),
        z.strictObject({
          scope: z.literal("local"),
          state: z.enum(["revoking", "absent"]),
          retainedReason: credentialMaterialRetainedReasonSchema.nullable().catch(null),
          cause: z.literal("signed-out-by-person"),
        }),
      ])
      .nullable(),
    handoffEnvironmentId: z.string().min(1).nullable(),
    materialFingerprint: z.string().nullable(),
    standing: credentialStandingSchema.optional().catch(undefined),
    observation: z
      .object({ identity: credentialIdentitySchema, capturedAt: z.number() })
      .nullable(),
    materialMatchesBinding: z.enum(["yes", "no", "unknown"]),
  }),
);
export type CredentialHome = z.infer<typeof credentialHomeSchema>;

/** Presence is independent of material health; only admitted or local homes participate. */
export function credentialHomeIsCandidate(home: CredentialHome): boolean {
  return (
    home.environmentPresence === null ||
    home.environmentPresence.state === "admitted"
  );
}
