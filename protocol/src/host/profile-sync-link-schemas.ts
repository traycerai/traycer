import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import { providerProfileAccentColorSchema } from "./provider-schemas";

/** One transferred sign-in, including the provider's own document. */
export const PROFILE_SYNC_MAX_CREDENTIAL_BYTES = 256 * 1024;
/** Bounds on one overview answer. */
export const PROFILE_SYNC_MAX_DEVICES = 64;
export const PROFILE_SYNC_MAX_PROFILES = 512;

/** Canonical host ids are opaque; preserve their bytes within wire bounds. */
export const profileSyncHostIdSchema = lazySchema(() =>
  z.string().min(1).max(128),
);
export const profileSyncProviderSchema = lazySchema(() =>
  z.enum(["claude", "codex", "grok", "antigravity"]),
);
export type ProfileSyncProvider = z.infer<typeof profileSyncProviderSchema>;
/** A managed profile's id, or `"ambient"` for the source's Terminal account.
 * Only a SOURCE profile may be ambient. */
export const profileSyncSourceProfileIdSchema = lazySchema(() =>
  z.union([z.string().uuid(), z.literal("ambient")]),
);
const linkIdSchema = lazySchema(() => z.string().uuid());
/** Kept by the hosts, never derived from a clock: a host that sees its own
 * store change offers one more than the highest generation it knows. */
const generationSchema = lazySchema(() =>
  z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
);
/** The provider's account id as the hosts know it. `null` only for a
 * credential that names no account (an API key). */
const accountIdSchema = lazySchema(() => z.string().min(1).max(256).nullable());

export const profileSyncStatusSchema = lazySchema(() =>
  z.enum([
    "synced",
    "syncing",
    "sign-in-needed",
    "device-offline",
    "update-needed",
    "cannot-sync",
  ]),
);
export type ProfileSyncStatus = z.infer<typeof profileSyncStatusSchema>;

/** A closed set of words; the app owns the sentence each one renders. */
export const profileSyncReasonSchema = lazySchema(() =>
  z.enum([
    "provider-not-installed",
    "provider-disabled",
    "unsupported-sign-in",
    "keychain-store",
    "keychain-locked",
    "account-changed",
    "account-mismatch",
    "account-unknown",
    "destination-refused",
    "transfer-failed",
    /** The profile was removed on the other device; an explicit sync adds it
     * again. */
    "removed-on-device",
  ]),
);
export type ProfileSyncReason = z.infer<typeof profileSyncReasonSchema>;

export const profileSyncItemSchema = lazySchema(() =>
  z.strictObject({
    providerId: profileSyncProviderSchema,
    sourceProfileId: profileSyncSourceProfileIdSchema,
    name: z.string().min(1).max(128),
    status: profileSyncStatusSchema,
    reason: profileSyncReasonSchema.nullable(),
  }),
);
export type ProfileSyncItem = z.infer<typeof profileSyncItemSchema>;

export const profileSyncDeviceSchema = lazySchema(() =>
  z.strictObject({
    hostId: profileSyncHostIdSchema,
    keepInSync: z.boolean(),
    items: z.array(profileSyncItemSchema).max(PROFILE_SYNC_MAX_PROFILES),
  }),
);
export type ProfileSyncDevice = z.infer<typeof profileSyncDeviceSchema>;

/** Statuses only: no answer to the app ever carries a sign-in. */
export const profileSyncOverviewSchema = lazySchema(() =>
  z.strictObject({
    sourceHostId: profileSyncHostIdSchema,
    /** How many profiles on the source a sync covers today. */
    profileCount: z.number().int().min(0).max(PROFILE_SYNC_MAX_PROFILES),
    devices: z.array(profileSyncDeviceSchema).max(PROFILE_SYNC_MAX_DEVICES),
  }),
);
export type ProfileSyncOverview = z.infer<typeof profileSyncOverviewSchema>;

export const profileSyncOverviewRequestSchema = lazySchema(() =>
  z.strictObject({ sourceHostId: profileSyncHostIdSchema }),
);
export const profileSyncNowRequestSchema = lazySchema(() =>
  z
    .strictObject({
      sourceHostId: profileSyncHostIdSchema,
      destinationHostId: profileSyncHostIdSchema,
    })
    .refine((value) => value.sourceHostId !== value.destinationHostId),
);
export const profileSyncKeepInSyncRequestSchema = lazySchema(() =>
  z
    .strictObject({
      sourceHostId: profileSyncHostIdSchema,
      destinationHostId: profileSyncHostIdSchema,
      enabled: z.boolean(),
    })
    .refine((value) => value.sourceHostId !== value.destinationHostId),
);
/** The one explicit action after a synced profile was signed in to a
 * different account on the source. */
export const profileSyncAcceptAccountRequestSchema = lazySchema(() =>
  z
    .strictObject({
      sourceHostId: profileSyncHostIdSchema,
      destinationHostId: profileSyncHostIdSchema,
      providerId: profileSyncProviderSchema,
      sourceProfileId: profileSyncSourceProfileIdSchema,
    })
    .refine((value) => value.sourceHostId !== value.destinationHostId),
);

/** The provider's own document travels unchanged, so a field a CLI adds later
 * survives without a host release. The hosts read only the fields they need
 * from it and never log it. */
const providerDocumentSchema = lazySchema(() =>
  z.record(z.string(), z.unknown()),
);
/** Frozen credential variants for the retired peer-transfer @1.0 methods. */
const profileSyncCredentialSchemaV10 = lazySchema(() =>
  z
    .discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("claude-oauth"),
        /** The `claudeAiOauth` object only; MCP sign-ins never travel. */
        document: providerDocumentSchema,
        /** The `oauthAccount` block of the profile's `.claude.json`, which is
         * where the CLI keeps who the sign-in belongs to. `null` when the
         * source has none yet. */
        account: providerDocumentSchema.nullable(),
      }),
      z.strictObject({
        kind: z.literal("codex-auth-file"),
        document: providerDocumentSchema,
      }),
      z.strictObject({
        kind: z.literal("grok-auth-file"),
        document: providerDocumentSchema,
      }),
      z.strictObject({
        kind: z.literal("antigravity-oauth"),
        document: providerDocumentSchema,
      }),
      z.strictObject({
        kind: z.literal("antigravity-api-key"),
        apiKey: z.string().min(1).max(PROFILE_SYNC_MAX_CREDENTIAL_BYTES),
      }),
    ])
    .refine(
      (value) =>
        new TextEncoder().encode(JSON.stringify(value)).byteLength <=
        PROFILE_SYNC_MAX_CREDENTIAL_BYTES,
      { message: "Sign-in exceeds byte limit" },
    ),
);

export const profileSyncCredentialSchema = lazySchema(() =>
  z
    .discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("claude-oauth"),
        /** The `claudeAiOauth` object only; MCP sign-ins never travel. */
        document: providerDocumentSchema,
        /** The `oauthAccount` block of the profile's `.claude.json`, which is
         * where the CLI keeps who the sign-in belongs to. `null` when the
         * source has none yet. */
        account: providerDocumentSchema.nullable(),
      }),
      z.strictObject({
        kind: z.literal("claude-api-key"),
        apiKey: z.string().min(1).max(PROFILE_SYNC_MAX_CREDENTIAL_BYTES),
      }),
      z.strictObject({
        kind: z.literal("codex-auth-file"),
        document: providerDocumentSchema,
      }),
      z.strictObject({
        kind: z.literal("grok-api-key"),
        apiKey: z.string().min(1).max(PROFILE_SYNC_MAX_CREDENTIAL_BYTES),
      }),
      z.strictObject({
        kind: z.literal("grok-auth-file"),
        document: providerDocumentSchema,
      }),
      z.strictObject({
        kind: z.literal("antigravity-oauth"),
        document: providerDocumentSchema,
      }),
      z.strictObject({
        kind: z.literal("antigravity-api-key"),
        apiKey: z.string().min(1).max(PROFILE_SYNC_MAX_CREDENTIAL_BYTES),
      }),
    ])
    .refine(
      (value) =>
        new TextEncoder().encode(JSON.stringify(value)).byteLength <=
        PROFILE_SYNC_MAX_CREDENTIAL_BYTES,
      { message: "Sign-in exceeds byte limit" },
    ),
);
export type ProfileSyncCredential = z.infer<typeof profileSyncCredentialSchema>;

/** Each provider's store holds one kind of sign-in (Antigravity: two). A
 * request naming one provider and carrying another's sign-in is refused at
 * the wire, before any host looks for a profile to put it in. */
export function profileSyncCredentialFitsProvider(
  providerId: ProfileSyncProvider,
  credential: ProfileSyncCredential,
): boolean {
  switch (providerId) {
    case "claude":
      return (
        credential.kind === "claude-oauth" ||
        credential.kind === "claude-api-key"
      );
    case "codex":
      return credential.kind === "codex-auth-file";
    case "grok":
      return (
        credential.kind === "grok-auth-file" ||
        credential.kind === "grok-api-key"
      );
    case "antigravity":
      return (
        credential.kind === "antigravity-oauth" ||
        credential.kind === "antigravity-api-key"
      );
  }
}

export const profileSyncProfileSettingsSchema = lazySchema(() =>
  z.strictObject({
    name: z.string().min(1).max(128),
    color: providerProfileAccentColorSchema,
    /** Applied at creation only; afterwards it belongs to each device. */
    enabled: z.boolean(),
  }),
);
export type ProfileSyncProfileSettings = z.infer<
  typeof profileSyncProfileSettingsSchema
>;

/** Source host to destination host: create or update one profile. */
export const hostProfileSyncApplyRequestSchema = lazySchema(() =>
  z
    .strictObject({
      linkId: linkIdSchema,
      providerId: profileSyncProviderSchema,
      sourceProfileId: profileSyncSourceProfileIdSchema,
      profile: profileSyncProfileSettingsSchema,
      accountId: accountIdSchema,
      generation: generationSchema,
      credential: profileSyncCredentialSchemaV10,
      /** Set only by the explicit accept-account action. */
      acceptAccountChange: z.boolean(),
      /** Set until the source has had this link confirmed once. A destination
       * that does not know a link creates a profile only for a new one; for
       * any other the profile was removed there, and it answers so. */
      newLink: z.boolean(),
    })
    .refine(
      (value) =>
        profileSyncCredentialFitsProvider(value.providerId, value.credential),
      { message: "Sign-in does not belong to this provider" },
    ),
);
export type HostProfileSyncApplyRequest = z.infer<
  typeof hostProfileSyncApplyRequestSchema
>;
export const hostProfileSyncApplyResponseSchema = lazySchema(() =>
  z.strictObject({
    result: z.enum(["applied", "kept-newer", "refused"]),
    reason: profileSyncReasonSchema.nullable(),
    /** The receiver's generation after this call. */
    generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  }),
);
export type HostProfileSyncApplyResponse = z.infer<
  typeof hostProfileSyncApplyResponseSchema
>;

/** Either linked host to its peer: a higher generation for an existing link. */
export const hostProfileSyncOfferRequestSchema = lazySchema(() =>
  z
    .strictObject({
      linkId: linkIdSchema,
      providerId: profileSyncProviderSchema,
      accountId: accountIdSchema,
      generation: generationSchema,
      credential: profileSyncCredentialSchemaV10,
    })
    .refine(
      (value) =>
        profileSyncCredentialFitsProvider(value.providerId, value.credential),
      { message: "Sign-in does not belong to this provider" },
    ),
);
export type HostProfileSyncOfferRequest = z.infer<
  typeof hostProfileSyncOfferRequestSchema
>;
export const hostProfileSyncOfferResponseSchema = lazySchema(() =>
  z.strictObject({
    result: z.enum(["stored", "kept-newer", "refused"]),
    reason: profileSyncReasonSchema.nullable(),
    generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  }),
);
export type HostProfileSyncOfferResponse = z.infer<
  typeof hostProfileSyncOfferResponseSchema
>;

/** Either linked host to its peer: the peer's current sign-in for a link. */
export const hostProfileSyncFetchRequestSchema = lazySchema(() =>
  z.strictObject({
    linkId: linkIdSchema,
    providerId: profileSyncProviderSchema,
  }),
);
export type HostProfileSyncFetchRequest = z.infer<
  typeof hostProfileSyncFetchRequestSchema
>;
export const hostProfileSyncFetchResponseSchema = lazySchema(() =>
  z.discriminatedUnion("result", [
    z.strictObject({
      result: z.literal("current"),
      accountId: accountIdSchema,
      generation: generationSchema,
      credential: profileSyncCredentialSchemaV10,
    }),
    /** The link exists but its store holds no sign-in right now. */
    z.strictObject({
      result: z.literal("none"),
      generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    }),
    z.strictObject({
      result: z.literal("refused"),
      reason: profileSyncReasonSchema,
    }),
  ]),
);
export type HostProfileSyncFetchResponse = z.infer<
  typeof hostProfileSyncFetchResponseSchema
>;

/**
 * An updated host to its peer after "Stop syncing": the peer hands over its
 * current sign-in, then stops renewing it. Under the profile's lock the peer
 * answers with what its store holds, empties a renewing sign-in (a key stays)
 * and ends its link, keeping its account row. A host that predates this
 * method refuses it, which is how the caller learns the peer is on 1.5.4.
 */
export const hostProfileSyncStopLinkRequestSchema = lazySchema(() =>
  z.strictObject({
    linkId: linkIdSchema,
    providerId: profileSyncProviderSchema,
  }),
);
export type HostProfileSyncStopLinkRequest = z.infer<
  typeof hostProfileSyncStopLinkRequestSchema
>;
export const hostProfileSyncStopLinkResponseSchema = lazySchema(() =>
  z.discriminatedUnion("result", [
    /** The peer stopped. `current` is what its store held; `null` when it
     * held no sign-in the 1.5.4 wire carries. */
    z.strictObject({
      result: z.literal("stopped"),
      current: z
        .strictObject({
          accountId: accountIdSchema,
          generation: generationSchema,
          credential: profileSyncCredentialSchemaV10,
        })
        .nullable(),
    }),
    /** The peer's end is its Terminal account, which keeps the sign-in:
     * nothing changed there, and the caller gives up its own copy. */
    z.strictObject({ result: z.literal("terminal") }),
    /** As fetch: `removed-on-device` for a link the peer no longer serves;
     * `keychain-locked` and `transfer-failed` are asked again. */
    z.strictObject({
      result: z.literal("refused"),
      reason: profileSyncReasonSchema,
    }),
  ]),
);
export type HostProfileSyncStopLinkResponse = z.infer<
  typeof hostProfileSyncStopLinkResponseSchema
>;

/** The most computers one linked group names; past it the group never opens. */
export const PROFILE_SYNC_MAX_GROUP_HOLDERS = 32;

/**
 * Which computers share a linked folder's chain, asked over the caller's own
 * link. The answering host asks each of its own linked peers not already in
 * `visited`, over its own link, so every hop is between two recorded peers.
 * A host without this method (1.5.4) refuses it.
 */
export const hostProfileSyncGroupHoldersRequestSchema = lazySchema(() =>
  z.strictObject({
    linkId: linkIdSchema,
    providerId: profileSyncProviderSchema,
    visited: z
      .array(profileSyncHostIdSchema)
      .max(PROFILE_SYNC_MAX_GROUP_HOLDERS),
  }),
);
export type HostProfileSyncGroupHoldersRequest = z.infer<
  typeof hostProfileSyncGroupHoldersRequestSchema
>;

/**
 * `holders`: every computer the answering host reached through the group, its
 * own linked peers included. `complete`: every one of them answered. `terminal`:
 * some computer in the group shares the chain with its Terminal account.
 */
export const hostProfileSyncGroupHoldersResponseSchema = lazySchema(() =>
  z.strictObject({
    holders: z
      .array(profileSyncHostIdSchema)
      .max(PROFILE_SYNC_MAX_GROUP_HOLDERS),
    complete: z.boolean(),
    terminal: z.boolean(),
  }),
);
export type HostProfileSyncGroupHoldersResponse = z.infer<
  typeof hostProfileSyncGroupHoldersResponseSchema
>;
