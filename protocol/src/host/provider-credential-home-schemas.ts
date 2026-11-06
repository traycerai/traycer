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
    material: z.enum([
      "usable", "stale", "signed-out", "rejected", "refused-by-provider",
    ]),
    repairDeadline: z.number().nullable(),
    familyVersion: z.string().min(1).nullable(),
    authority: z.enum(["provider-client", "custodian"]).nullable(),
    cause: z.string().nullable(),
    observation: z.strictObject({
      source: z.enum(["provider-client", "custodian"]),
      status: z.enum(["answered", "unknown"]),
      capturedAt: z.number(),
    }),
  }),
);
export type CredentialStanding = z.infer<typeof credentialStandingSchema>;

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
    materialFingerprint: z.string().nullable(),
    standing: credentialStandingSchema.optional(),
    observation: z
      .object({ identity: credentialIdentitySchema, capturedAt: z.number() })
      .nullable(),
    materialMatchesBinding: z.enum(["yes", "no", "unknown"]),
  }),
);
export type CredentialHome = z.infer<typeof credentialHomeSchema>;
