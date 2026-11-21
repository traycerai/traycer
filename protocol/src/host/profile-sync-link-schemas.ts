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

/** The most holder folders one linked group names; past it the group never
 * opens. */
export const PROFILE_SYNC_MAX_GROUP_HOLDERS = 32;

/** The most link ids a groupHolders walk carries as visited; a group of 32
 * holder folders cannot reach it in practice, and past it the walk is
 * incomplete. */
export const PROFILE_SYNC_MAX_GROUP_LINKS = 256;

const stopClaimIdSchema = lazySchema(() => z.string().uuid());

/**
 * "Stop syncing" between updated hosts, with one keeper fixed before anything
 * is sent. The computer where Stop was pressed walks the group, then sends
 * `prepare` to each member, naming the keeper and every member. Each member
 * hands its copy to the keeper with `handoff` and keeps it; the keeper alone
 * commits once it holds every member's copy, and `status` asks it whether it
 * has. Only then does a member erase, against the keeper's `receipt`, and
 * send `closed`. `abort` drops a claim that did not commit. A member is a
 * folder: one computer can hold two folders of the chain, each its own
 * member. Every step is a direct call between two computers of the claim:
 * `linkId` is the receiver's own link, which finds its folder, and the
 * member steps name the sender's folder by `profileId`. Each step is answered from what the
 * receiver persisted, so each is safe to send again. A host that predates
 * this method refuses it, which is how the caller learns the peer is on
 * 1.5.4.
 */
export const hostProfileSyncStopLinkRequestSchema = lazySchema(() =>
  z.strictObject({
    linkId: linkIdSchema,
    providerId: profileSyncProviderSchema,
    step: z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("prepare"),
        claimId: stopClaimIdSchema,
        claimantHostId: profileSyncHostIdSchema,
        keeperHostId: profileSyncHostIdSchema,
        /** The keeper's folder on `keeperHostId`. */
        keeperProfileId: profileSyncSourceProfileIdSchema,
        /** Every updated holder folder of the group, the keeper and the
         * receiver included, each with a link it has for the folder; unique
         * by `hostId` and `profileId`. */
        members: z
          .array(
            z.strictObject({
              hostId: profileSyncHostIdSchema,
              profileId: profileSyncSourceProfileIdSchema,
              linkId: linkIdSchema,
            }),
          )
          .max(PROFILE_SYNC_MAX_GROUP_HOLDERS),
        /** The one 1.5.4 computer the keeper hands over to once every member
         * closed, and through which it passes a late copy on; null when the
         * group has none. */
        gatewayHostId: profileSyncHostIdSchema.nullable(),
      }),
      /** `credential` null: the giver holds no sign-in of the chain the wire
       * carries. `profileId`, here and on `status` and `closed`: the
       * sender's folder, which with the sender's host names its member
       * entry. */
      z.strictObject({
        kind: z.literal("handoff"),
        claimId: stopClaimIdSchema,
        profileId: profileSyncSourceProfileIdSchema,
        accountId: accountIdSchema,
        generation: generationSchema,
        credential: profileSyncCredentialSchemaV10.nullable(),
      }),
      z.strictObject({
        kind: z.literal("status"),
        claimId: stopClaimIdSchema,
        profileId: profileSyncSourceProfileIdSchema,
      }),
      z.strictObject({
        kind: z.literal("closed"),
        claimId: stopClaimIdSchema,
        profileId: profileSyncSourceProfileIdSchema,
        generation: generationSchema,
      }),
      z.strictObject({
        kind: z.literal("abort"),
        claimId: stopClaimIdSchema,
      }),
      /** No claim: the sender has nothing to hand over this link (a key, an
       * account none of its links is pinned to, or ends pinned to different
       * accounts). The one step authorised by the link: the sender must be
       * its recorded peer. The receiver ends that one link, erases nothing
       * and answers `ok`, as it does for a link already ended. */
      z.strictObject({ kind: z.literal("leave") }),
    ]),
  }),
);
export type HostProfileSyncStopLinkRequest = z.infer<
  typeof hostProfileSyncStopLinkRequestSchema
>;
export const hostProfileSyncStopLinkResponseSchema = lazySchema(() =>
  z.discriminatedUnion("result", [
    /** `prepare`: the receiver holds the claim. `status`: the keeper holds
     * it and has not committed. */
    z.strictObject({ result: z.literal("prepared") }),
    /** `prepare`: nothing to hand over (a key, or a copy for another
     * account than the link's); the receiver ended its links pinned as this
     * one, erased nothing, and is not a member. */
    z.strictObject({ result: z.literal("no-chain") }),
    /** `prepare`: the folder's group has started moving to Personal. */
    z.strictObject({ result: z.literal("converted") }),
    /** `prepare`: the folder is held by another Stop claim. */
    z.strictObject({
      result: z.literal("held"),
      claimId: stopClaimIdSchema,
      claimantHostId: profileSyncHostIdSchema,
    }),
    /** `status`, `abort`, or another claim's `prepare`: the keeper has
     * committed this claim. */
    z.strictObject({ result: z.literal("committed") }),
    /** `status`: the keeper's readable file holds no such claim, so it never
     * committed. */
    z.strictObject({ result: z.literal("unknown") }),
    /** The answer to `handoff`: the keeper holds a renewing copy at
     * `generation` or newer, read back from its store. `none` answers only a
     * `credential: null` handoff: both ends are empty and nothing is erased. */
    z.strictObject({
      result: z.literal("receipt"),
      generation: generationSchema,
      held: z.enum(["renewing", "none"]),
    }),
    /** The answer to `closed`: the keeper counts the member closed. */
    z.strictObject({ result: z.literal("closed") }),
    /** The answer to `abort` (the claim is dropped) and to `leave`. */
    z.strictObject({ result: z.literal("ok") }),
    /** Any step: nothing changed on the receiver. `keychain-locked` and
     * `transfer-failed` are asked again. */
    z.strictObject({
      result: z.literal("refused"),
      reason: profileSyncReasonSchema,
    }),
  ]),
);
export type HostProfileSyncStopLinkResponse = z.infer<
  typeof hostProfileSyncStopLinkResponseSchema
>;

/**
 * Which computers share a linked folder's chain, asked over the caller's own
 * link. `visited`: the link ids the walk has already asked over or is asking
 * over. The answering folder asks over each of its own group links of the
 * asked link's pin that is not in it, passing it on with its own links added.
 * `onward` false asks about the asked link alone: the answering host asks no
 * one, so a check of a link between two computers already visited never
 * walks on. A host without this method (1.5.4) refuses it.
 */
export const hostProfileSyncGroupHoldersRequestSchema = lazySchema(() =>
  z.strictObject({
    linkId: linkIdSchema,
    providerId: profileSyncProviderSchema,
    visited: z.array(linkIdSchema).max(PROFILE_SYNC_MAX_GROUP_LINKS),
    onward: z.boolean().default(true),
  }),
);
export type HostProfileSyncGroupHoldersRequest = z.infer<
  typeof hostProfileSyncGroupHoldersRequestSchema
>;

/**
 * One updated computer of the group, as the walk reached it. `linkId`: the
 * link it was reached over, the same id at both ends, so a direct call can
 * name its folder. `profileId`: the answering folder's own id; a computer
 * holding two folders of the chain is two holders. `oldPeers`: its own links,
 * pinned like the walked chain, to computers that refuse this method.
 * `terminal`: its folder is the computer's own Terminal account; a managed
 * folder that received from one is not.
 */
export const profileSyncGroupHolderSchema = lazySchema(() =>
  z.strictObject({
    hostId: profileSyncHostIdSchema,
    profileId: profileSyncSourceProfileIdSchema,
    linkId: linkIdSchema,
    oldPeers: z
      .array(profileSyncHostIdSchema)
      .max(PROFILE_SYNC_MAX_GROUP_HOLDERS),
    terminal: z.boolean(),
  }),
);
export type ProfileSyncGroupHolder = z.infer<
  typeof profileSyncGroupHolderSchema
>;

/**
 * `holders`: the answering host's own record and every updated computer it
 * reached past it. `complete`: every link it asked about was answered.
 * `terminal`: some computer in the group shares the chain with its Terminal
 * account. `converted`: the answering host's own end of the asked link was
 * ended by its conversion. `moving`: some computer the answer covers is
 * converting or has converted; `groupConverted`: one has converted.
 * `stopping`: some computer the answer covers is under a Stop claim.
 * `pinned`: the asked link bound to the account the answering end pins it to,
 * as the asker binds its own end; null when that end pins no account.
 * `split`: the links the answer covers whose two ends pin different accounts.
 * `mixed`: some folder the answer covers pins its group links to more than
 * one account. `twoFolders`: some computer the answer covers holds more than
 * one folder of the chain. Each defaults to its empty value when absent.
 */
export const hostProfileSyncGroupHoldersResponseSchema = lazySchema(() =>
  z.strictObject({
    holders: z
      .array(profileSyncGroupHolderSchema)
      .max(PROFILE_SYNC_MAX_GROUP_HOLDERS),
    complete: z.boolean(),
    terminal: z.boolean(),
    converted: z.boolean().default(false),
    moving: z.boolean().default(false),
    groupConverted: z.boolean().default(false),
    stopping: z.boolean().default(false),
    pinned: z.string().uuid().nullable().default(null),
    split: z
      .array(linkIdSchema)
      .max(PROFILE_SYNC_MAX_GROUP_HOLDERS * PROFILE_SYNC_MAX_GROUP_HOLDERS)
      .default([]),
    mixed: z.boolean().default(false),
    twoFolders: z.boolean().default(false),
  }),
);
export type HostProfileSyncGroupHoldersResponse = z.infer<
  typeof hostProfileSyncGroupHoldersResponseSchema
>;
