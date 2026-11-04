import { z } from "zod";
import { lazySchema } from "../framework/lazy-schema";

/** Provider-stated spend scope. Display names and email never qualify an id. */
export const spendScopeKeySchema = lazySchema(() =>
  z.union([
    z.object({
      providerId: z.string().min(1),
      accountId: z.string().min(1),
      organizationId: z.string().min(1).nullable(),
    }),
    z.object({ providerId: z.string().min(1), email: z.string().min(1) }),
  ]),
);
export type SpendScopeKey = z.infer<typeof spendScopeKeySchema>;

export const credentialIdentitySchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("spend-scoped"),
      spendScopeKey: spendScopeKeySchema,
      provenance: z.string().min(1),
    }),
    z.object({
      kind: z.literal("unidentified"),
      provenance: z.string().min(1),
      reason: z.string().min(1),
    }),
    z.object({
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

export const credentialHomeSchema = lazySchema(() =>
  z.object({
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
    observation: z
      .object({ identity: credentialIdentitySchema, capturedAt: z.number() })
      .nullable(),
    materialMatchesBinding: z.enum(["yes", "no", "unknown"]),
  }),
);
export type CredentialHome = z.infer<typeof credentialHomeSchema>;
