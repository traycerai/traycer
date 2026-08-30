/**
 * `browser.sessions@1.0` and `browser.screencast@1.0` - browser V1 stream
 * contracts between the GUI and host-owned headless browser sessions.
 *
 * These are intentionally stream-only additions. Until their first release,
 * the browser contracts extend the 1.0 baseline in place. After release,
 * additive changes use negotiated minors with version-gated emission;
 * breaking semantics require a separately served major.
 */
import { z } from "zod";
import { defineRpcContract } from "@traycer/protocol/framework/index";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  browserCdpCommandSchema,
  browserCdpResultSchema,
  browserCdpTargetSchema,
} from "@traycer/protocol/host/browser/cdp-contracts";

// The curated CDP vocabulary lives in its own module (it is addressed
// independently of either stream contract) but stays part of this module's
// public surface, so every consumer keeps one import path.
export * from "@traycer/protocol/host/browser/cdp-contracts";

const textFrameFields = {
  hasBinaryPayload: z.literal(false),
} as const;

const binaryFrameFields = {
  hasBinaryPayload: z.literal(true),
} as const;

const requestFrameFields = {
  ...textFrameFields,
  requestId: z.string(),
} as const;

const browserSessionReferenceFields = {
  sessionId: z.string(),
} as const;

const browserOriginTierSchema = z.enum(["dev", "external"]);
export type BrowserOriginTier = z.infer<typeof browserOriginTierSchema>;

const browserSessionStatusSchema = z.enum([
  "provisioning",
  "ready",
  "navigating",
  "closing",
  "crashed",
  // A durable tab whose replaceable native/headless runtime is not currently
  // attached. Its logical identity remains available for on-demand activation.
  "dormant",
]);
export type BrowserSessionStatus = z.infer<typeof browserSessionStatusSchema>;

const browserSessionClosedReasonSchema = z.enum([
  "completed",
  "idle-ttl",
  "evicted",
  "crashed",
]);
export type BrowserSessionClosedReason = z.infer<
  typeof browserSessionClosedReasonSchema
>;

/** Profile controls credential sharing, not logical session identity. */
export const browserSessionProfileKindSchema = z.enum(["primary", "isolated"]);
export type BrowserSessionProfileKind = z.infer<
  typeof browserSessionProfileKindSchema
>;

/** Attribution for one in-flight tab action; this grants no lock or lease. */
const browserTabDriverSchema = z
  .object({
    chatId: z.string(),
    agentRunId: z.string().nullable(),
    requestId: z.string(),
  })
  .strict();
export type BrowserTabDriver = z.infer<typeof browserTabDriverSchema>;

/** One page, addressed by a durable host-minted id rather than a CDP id. */
const browserTabInfoSchema = z
  .object({
    tabId: z.string(),
    url: z.string(),
    originTier: browserOriginTierSchema,
    status: browserSessionStatusSchema,
    title: z.string().nullable(),
    // Live discovery hint only: the currently viewed/MRU visible tile, or an
    // active headless screencast peek. It grants no control capability.
    viewed: z.boolean(),
    drivenBy: z.array(browserTabDriverSchema),
  })
  .strict();
export type BrowserTabInfo = z.infer<typeof browserTabInfoSchema>;

/** An epic-scoped group of tabs sharing one browser profile. */
const browserSessionInfoSchema = z
  .object({
    sessionId: z.string(),
    epicId: z.string(),
    hostId: z.string(),
    profile: browserSessionProfileKindSchema,
    lastActivityAt: z.number(),
    runtime: z
      .object({
        kind: z.enum(["headless", "electron", "dormant"]),
        revision: z.number().int().nonnegative(),
      })
      .strict(),
    tabs: z.array(browserTabInfoSchema),
  })
  .strict();
export type BrowserSessionInfo = z.infer<typeof browserSessionInfoSchema>;

/** One tab addressed through its owning session. */
export const browserTabIdentitySchema = z
  .object({
    sessionId: z.string(),
    tabId: z.string(),
  })
  .strict();
export type BrowserTabIdentity = z.infer<typeof browserTabIdentitySchema>;

/** `epicId` is the stream's sole authorization and routing scope. */
export const browserSessionsOpenRequestSchema = z
  .object({
    epicId: z.string(),
  })
  .strict();
export type BrowserSessionsOpenRequest = z.infer<
  typeof browserSessionsOpenRequestSchema
>;

export const browserStorageCookieSchema = z
  .object({
    name: z.string(),
    value: z.string(),
    domain: z.string(),
    path: z.string(),
    expires: z.number(),
    httpOnly: z.boolean(),
    secure: z.boolean(),
    sameSite: z.enum(["Strict", "Lax", "None"]),
  })
  .strict();
export type BrowserStorageCookie = z.infer<typeof browserStorageCookieSchema>;

export const browserStorageLocalStorageEntrySchema = z
  .object({
    name: z.string(),
    value: z.string(),
  })
  .strict();
export type BrowserStorageLocalStorageEntry = z.infer<
  typeof browserStorageLocalStorageEntrySchema
>;

export const browserStorageOriginSchema = z
  .object({
    origin: z.string(),
    localStorage: z.array(browserStorageLocalStorageEntrySchema),
  })
  .strict();
export type BrowserStorageOrigin = z.infer<typeof browserStorageOriginSchema>;

export const browserStorageStateSchema = z
  .object({
    cookies: z.array(browserStorageCookieSchema),
    origins: z.array(browserStorageOriginSchema),
  })
  .strict();
export type BrowserStorageState = z.infer<typeof browserStorageStateSchema>;

/**
 * The slice of the jar one capture speaks for. Only registrable-domain scopes
 * travel on the wire today (`registrable-domain.ts` derives them on both ends);
 * the host's own store additionally knows a whole-partition scope, which is
 * what a teardown capture writes.
 */
export const browserPrimaryProfileDeltaScopeSchema = z
  .object({
    kind: z.literal("domain"),
    domain: z.string(),
  })
  .strict();
export type BrowserPrimaryProfileDeltaScope = z.infer<
  typeof browserPrimaryProfileDeltaScopeSchema
>;

/** Unpartitioned cookie identity: exactly what a tombstone is keyed by. */
export const browserCookieKeySchema = z
  .object({
    domain: z.string(),
    name: z.string(),
    path: z.string(),
  })
  .strict();
export type BrowserCookieKey = z.infer<typeof browserCookieKeySchema>;

/**
 * One coalescing window's worth of cookie change for a single registrable
 * domain. `cookies` is the **complete** picture of the scope after the window
 * (every cookie the scope subtree holds), not just the ones that changed, so
 * the host can tombstone by absence; `removedKeys` names what was observed
 * disappearing, which is what makes a removal legible in a trace and lets a
 * future reader distinguish "gone" from "never seen".
 */
export const browserPrimaryProfileDeltaSchema = z
  .object({
    scope: browserPrimaryProfileDeltaScopeSchema,
    cookies: z.array(browserStorageCookieSchema),
    removedKeys: z.array(browserCookieKeySchema),
    /** When the window opened, from the sender's clock. */
    issuedAt: z.number(),
  })
  .strict();
export type BrowserPrimaryProfileDelta = z.infer<
  typeof browserPrimaryProfileDeltaSchema
>;

const cdpRequestFrameFields = {
  ...requestFrameFields,
  tabId: z.string(),
  // Host resolves a durable Electron tabId to one exact native incarnation
  // before dispatch.
  registrationId: z.string(),
  target: browserCdpTargetSchema,
} as const;

const browserCdpRequestFrameSchema = z
  .object({
    kind: z.literal("cdpRequest"),
    ...cdpRequestFrameFields,
    command: browserCdpCommandSchema,
  })
  .strict();

const browserBurstOutcomeSchema = z.enum([
  "finished",
  "closed",
  "crashed",
  "suspended",
]);
export type BrowserBurstOutcome = z.infer<typeof browserBurstOutcomeSchema>;

const electronTabCreateReasonSchema = z.enum([
  "session-bootstrap",
  "agent-open",
  "restore",
]);
export type ElectronTabCreateReason = z.infer<
  typeof electronTabCreateReasonSchema
>;

const electronTabCreateFailureCodeSchema = z.enum([
  "identity_violation",
  "native_unavailable",
  "native_create_failed",
]);
export type ElectronTabCreateFailureCode = z.infer<
  typeof electronTabCreateFailureCodeSchema
>;

export const browserSessionsServerFrameSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("snapshot"),
      ...textFrameFields,
      sessions: z.array(browserSessionInfoSchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal("sessionCreated"),
      ...textFrameFields,
      session: browserSessionInfoSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("sessionUpdated"),
      ...textFrameFields,
      session: browserSessionInfoSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("sessionClosed"),
      ...textFrameFields,
      ...browserSessionReferenceFields,
      reason: browserSessionClosedReasonSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("agentTabOpened"),
      ...textFrameFields,
      ...browserSessionReferenceFields,
      tabId: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("actionAck"),
      ...requestFrameFields,
      ok: z.boolean(),
      reason: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("openTabResult"),
      ...requestFrameFields,
      result: z.discriminatedUnion("ok", [
        z
          .object({
            ok: z.literal(true),
            ...browserTabIdentitySchema.shape,
          })
          .strict(),
        z
          .object({
            ok: z.literal(false),
            reason: z.string(),
          })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pong"),
      ...textFrameFields,
    })
    .strict(),
  browserCdpRequestFrameSchema,
  z
    .object({
      kind: z.literal("createElectronTab"),
      ...requestFrameFields,
      sessionId: z.string(),
      tabId: z.string(),
      // Navigation intent, not part of native provisioning readiness. Desktop
      // starts it only after the host accepts the provisioned incarnation.
      requestedUrl: z.string(),
      reason: electronTabCreateReasonSchema,
      // Which jar the guest gets. `isolated` picks a per-session in-memory
      // partition on the desktop and is never seeded, so the desktop cannot
      // infer it from `seedStorageState` being null.
      profile: browserSessionProfileKindSchema,
      seedStorageState: browserStorageStateSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("electronTabAccepted"),
      ...requestFrameFields,
      sessionId: z.string(),
      tabId: z.string(),
      registrationId: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("releaseElectronTab"),
      ...textFrameFields,
      sessionId: z.string(),
      tabId: z.string(),
      registrationId: z.string(),
    })
    .strict(),
  z
    .object({
      // Refreshes the host's durable primary-profile snapshot after a committed
      // Electron navigation. Headless activation reads that snapshot; it never
      // opens a second, opportunistic renderer request path during placement.
      kind: z.literal("capturePrimaryProfile"),
      ...requestFrameFields,
    })
    .strict(),
  z
    .object({
      // Store-key handshake (keychain refactor ticket 05). The host mints the
      // per-user store key and asks the elected desktop to wrap it with that
      // machine's OS keystore; the host keeps the raw bytes in memory only.
      kind: z.literal("storeKeyWrapRequest"),
      ...requestFrameFields,
      rawKey: z.base64(),
    })
    .strict(),
  z
    .object({
      // The blob some desktop wrapped earlier, handed back for `decryptString`.
      kind: z.literal("storeKeyUnwrapRequest"),
      ...requestFrameFields,
      wrappedKey: z.base64(),
    })
    .strict(),
  z
    .object({
      // One site's logins were cleared somewhere else for this user (keychain
      // refactor ticket 07): another desktop's tile menu, or a tombstone the
      // store recorded for `domain`. The receiving desktop removes that
      // registrable domain's cookies and localStorage from its own persistent
      // partition without echoing a delta back - the store already knows. Sent
      // to every elected desktop subscriber of the user EXCEPT the one that
      // reported the change. No `userId`: the identity is the stream's
      // authenticated user.
      kind: z.literal("primaryProfileEvict"),
      ...textFrameFields,
      domain: z.string(),
    })
    .strict(),
  z
    .object({
      // The user forgot every saved browser login (keychain refactor ticket
      // 08). The host has already crypto-shredded its slice for this user and
      // suspended their live `primary` sessions; each connected desktop clears
      // its own persistent partition on receipt. Sent to every subscriber of
      // the user, the originator included - it clears the same way the others
      // do. No `userId`: the identity is the stream's authenticated user.
      kind: z.literal("primaryProfileForgotten"),
      ...textFrameFields,
    })
    .strict(),
  z
    .object({
      // Stream-only action burst; never persisted or replayed.
      kind: z.literal("burstStarted"),
      ...textFrameFields,
      sessionId: z.string(),
      tabId: z.string(),
      burstId: z.string(),
      chatId: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("burstEnded"),
      ...textFrameFields,
      sessionId: z.string(),
      tabId: z.string(),
      burstId: z.string(),
      outcome: browserBurstOutcomeSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("caption"),
      ...textFrameFields,
      sessionId: z.string(),
      tabId: z.string(),
      burstId: z.string(),
      cellTitle: z.string(),
    })
    .strict(),
]);
export type BrowserSessionsServerFrame = z.infer<
  typeof browserSessionsServerFrameSchema
>;

/** One tab captured alongside the tab being handed off to headless. */
export const browserElectronTabHandoffSiblingSchema = z
  .object({
    tabId: z.string(),
    registrationId: z.string(),
    url: z.string(),
    capturedStorageState: browserStorageStateSchema.nullable(),
  })
  .strict();
export type BrowserElectronTabHandoffSibling = z.infer<
  typeof browserElectronTabHandoffSiblingSchema
>;

export const browserSessionsClientFrameSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("openTab"),
      ...requestFrameFields,
      sessionId: z.string().nullable(),
      url: z.string(),
    })
    .strict(),
  z
    .object({
      // Tab-scoped close for the browser sidebar; closing the final tab also
      // closes its session.
      kind: z.literal("closeTab"),
      ...requestFrameFields,
      ...browserSessionReferenceFields,
      tabId: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("ping"),
      ...textFrameFields,
    })
    .strict(),
  z
    .object({
      kind: z.literal("cdpResult"),
      ...requestFrameFields,
      result: browserCdpResultSchema,
    })
    .strict(),
  z
    .object({
      // One settlement for one host-minted birth. Receipt means only that the
      // native guest exists, its durable identity is installed, and CDP can be
      // routed through this subscriber. Navigation and presentation begin only
      // after `electronTabAccepted` commits ownership.
      kind: z.literal("electronTabProvisioned"),
      ...requestFrameFields,
      sessionId: z.string(),
      tabId: z.string(),
      registrationId: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("electronTabCreateFailed"),
      ...requestFrameFields,
      sessionId: z.string(),
      tabId: z.string(),
      code: electronTabCreateFailureCodeSchema,
      message: z.string(),
    })
    .strict(),
  z
    .object({
      // The subscriber has the complete native tab lifecycle, CDP, and profile
      // capture seam. The desktop preload exposes this as one capability.
      kind: z.literal("electronTabLifecycleReady"),
      ...textFrameFields,
    })
    .strict(),
  z
    .object({
      kind: z.literal("electronTabState"),
      ...textFrameFields,
      registrationId: z.string(),
      sessionId: z.string(),
      tabId: z.string(),
      url: z.string(),
      title: z.string().nullable(),
      status: browserSessionStatusSchema,
      viewed: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("primaryProfileCaptured"),
      ...requestFrameFields,
      storageState: browserStorageStateSchema.nullable(),
      status: z.enum(["captured", "unavailable", "failed"]),
      reason: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      // Unsolicited: the client's persistent `primary` jar reported cookie
      // changes for one registrable domain and coalesced them into a window
      // (keychain refactor ticket 06). There is no request to answer and no
      // `userId` - the identity is the stream's authenticated user, and only
      // the elected lifecycle subscriber is heard (same gate as
      // `primaryProfileCaptured`).
      kind: z.literal("primaryProfileDelta"),
      ...textFrameFields,
      ...browserPrimaryProfileDeltaSchema.shape,
    })
    .strict(),
  z
    .object({
      // "This machine can reach an OS keystore for you." Sent right after
      // `electronTabLifecycleReady`; the host answers with whichever of
      // the two key requests this user needs. The identity is the stream's
      // authenticated user, so the frame carries no `userId`, and only the
      // elected lifecycle subscriber is heard (same gate as
      // `primaryProfileCaptured`).
      kind: z.literal("storeKeyOffer"),
      ...textFrameFields,
    })
    .strict(),
  z
    .object({
      // `safeStorage.encryptString(rawKey)` for the `requestId` the host sent.
      kind: z.literal("storeKeyWrapped"),
      ...requestFrameFields,
      wrappedKey: z.base64(),
    })
    .strict(),
  z
    .object({
      // `safeStorage.decryptString(wrappedKey)`. `null` means this desktop
      // cannot open the blob (keystore item ACL changed, different machine);
      // the host then stays sealed and never re-mints over a live blob.
      kind: z.literal("storeKeyUnwrapped"),
      ...requestFrameFields,
      rawKey: z.base64().nullable(),
    })
    .strict(),
  z
    .object({
      // "Clear" on one row of Settings > Browser > Sites with saved logins
      // (keychain refactor ticket 10, decision #13). Unsolicited and
      // unacknowledged: the host tombstones that registrable domain in the
      // user's slice and fans `primaryProfileEvict` out for it - to EVERY
      // elected desktop of the user, the sender included, because the request
      // came from a settings page rather than from a jar that already cleared
      // itself. No `userId` - the identity is the stream's authenticated user,
      // and only the elected lifecycle subscriber is heard (same gate as
      // `primaryProfileDelta`).
      kind: z.literal("clearSite"),
      ...textFrameFields,
      domain: z.string(),
    })
    .strict(),
  z
    .object({
      // "Forget all browser logins" (keychain refactor ticket 08, decision
      // #13). Unsolicited and unacknowledged: the host answers by shredding
      // this user's key and slice and fanning `primaryProfileForgotten` back
      // out, which is what tells this desktop to clear its own partition. No
      // `userId` - the identity is the stream's authenticated user, and only
      // the elected lifecycle subscriber is heard (same gate as
      // `primaryProfileCaptured`).
      kind: z.literal("forgetLogins"),
      ...textFrameFields,
    })
    .strict(),
  z
    .object({
      // Captures one exact native incarnation before teardown. Sibling state is
      // grouped into the same frame so the host can hand off the session once.
      // Null storage means desktop could not safely capture it.
      kind: z.literal("electronTabHandoff"),
      ...requestFrameFields,
      sessionId: z.string(),
      tabId: z.string(),
      registrationId: z.string(),
      capturedUrl: z.string(),
      capturedStorageState: browserStorageStateSchema.nullable(),
      siblingTabs: z.array(browserElectronTabHandoffSiblingSchema),
      // `persistence-migration` is the desktop tearing the tab down so it can
      // come back on the durable partition (keychain refactor ticket 02); the
      // host treats it exactly like `tab-released`.
      reason: z.enum([
        "gui-quit",
        "tab-released",
        "crash-no-capture",
        "persistence-migration",
      ]),
    })
    .strict(),
]);
export type BrowserSessionsClientFrame = z.infer<
  typeof browserSessionsClientFrameSchema
>;

/** Unreleased browser stream baseline. */
export const browserSessionsV1 = defineStreamRpcContract({
  method: "browser.sessions",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: browserSessionsOpenRequestSchema,
  serverFrameSchema: browserSessionsServerFrameSchema,
  clientFrameSchema: browserSessionsClientFrameSchema,
});

/** One site the user's stored primary profile still holds cookies for. */
export const browserSavedLoginSiteSchema = z
  .object({
    /** Registrable domain (eTLD+1) - never a cookie name, never a value. */
    domain: z.string(),
    /** Newest observation of any live cookie under that domain, host clock. */
    lastSeen: z.number(),
  })
  .strict();
export type BrowserSavedLoginSite = z.infer<typeof browserSavedLoginSiteSchema>;

/** No input: the slice read is the caller's own, from the request identity. */
export const browserSavedLoginSitesRequestSchema = z.object({}).strict();
export type BrowserSavedLoginSitesRequest = z.infer<
  typeof browserSavedLoginSitesRequestSchema
>;

/**
 * `sealed` is not "no sites": it is "this host holds no key for you yet", and
 * the two must never render the same way - one is an empty jar, the other is a
 * jar nobody here can open (spec section 6.2). Keeping them separate arms is
 * what lets Settings offer "Connect this desktop to unlock saved logins"
 * instead of claiming the user has no saved logins at all.
 */
export const browserSavedLoginSitesResponseSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("sealed") }).strict(),
    z
      .object({
        kind: z.literal("sites"),
        sites: z.array(browserSavedLoginSiteSchema),
      })
      .strict(),
  ],
);
export type BrowserSavedLoginSitesResponse = z.infer<
  typeof browserSavedLoginSitesResponseSchema
>;

/**
 * Names only, never values (spec section 7.3, decision #26). The host projects
 * the registrable domains of the live cookie keys in the caller's own slice;
 * the cookies themselves never leave the host on this path, so a compromised
 * renderer learns which sites the user is signed into and nothing more.
 */
export const browserSavedLoginSitesV10 = defineRpcContract({
  method: "browser.savedLoginSites",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: browserSavedLoginSitesRequestSchema,
  responseSchema: browserSavedLoginSitesResponseSchema,
});

const browserScreencastFormatSchema = z.enum(["jpeg"]);
export type BrowserScreencastFormat = z.infer<
  typeof browserScreencastFormatSchema
>;

const browserScreencastViewerRoleSchema = z.enum(["tile", "pip"]);
export type BrowserScreencastViewerRole = z.infer<
  typeof browserScreencastViewerRoleSchema
>;

/** Epic-authorized, tab-addressed screencast subscription. */
export const browserScreencastOpenRequestSchema = z
  .object({
    epicId: z.string(),
    sessionId: z.string(),
    tabId: z.string(),
    maxWidth: z.number().int().positive(),
    maxHeight: z.number().int().positive(),
    quality: z.number().int().min(0).max(100),
    format: browserScreencastFormatSchema,
    role: browserScreencastViewerRoleSchema,
  })
  .strict();
export type BrowserScreencastOpenRequest = z.infer<
  typeof browserScreencastOpenRequestSchema
>;

const browserScreencastMetadataSchema = z
  .object({
    offsetTop: z.number(),
    pageScaleFactor: z.number(),
    deviceWidth: z.number(),
    deviceHeight: z.number(),
    scrollOffsetX: z.number(),
    scrollOffsetY: z.number(),
    timestamp: z.number(),
  })
  .strict();
export type BrowserScreencastMetadata = z.infer<
  typeof browserScreencastMetadataSchema
>;

const browserScreencastUnsupportedFeatureSchema = z.enum([
  "fileUpload",
  "download",
]);
export type BrowserScreencastUnsupportedFeature = z.infer<
  typeof browserScreencastUnsupportedFeatureSchema
>;

/** Full navigation snapshot every time; consumers never reconstruct deltas. */
export const browserNavStateSchema = z
  .object({
    url: z.string(),
    canGoBack: z.boolean(),
    canGoForward: z.boolean(),
    loading: z.boolean(),
  })
  .strict();
export type BrowserNavState = z.infer<typeof browserNavStateSchema>;

export const browserScreencastServerFrameSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("started"),
      ...textFrameFields,
      frameWidth: z.number().int().positive(),
      frameHeight: z.number().int().positive(),
      deviceScaleFactor: z.number().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("frame"),
      ...binaryFrameFields,
      sequence: z.number().int().nonnegative(),
      metadata: browserScreencastMetadataSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("stalled"),
      ...textFrameFields,
    })
    .strict(),
  z
    .object({
      kind: z.literal("resized"),
      ...textFrameFields,
      frameWidth: z.number().int().positive(),
      frameHeight: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("failed"),
      ...textFrameFields,
      reason: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("complete"),
      ...textFrameFields,
    })
    .strict(),
  z
    .object({
      kind: z.literal("pong"),
      ...textFrameFields,
    })
    .strict(),
  z
    .object({
      kind: z.literal("armed"),
      ...textFrameFields,
      armEpoch: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("revoked"),
      ...textFrameFields,
      armEpoch: z.number().int().nonnegative(),
      cause: z.enum(["disarmed", "stolen"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("dialogOpened"),
      ...textFrameFields,
      generation: z.number().int().nonnegative(),
      type: z.enum(["alert", "beforeunload", "confirm", "prompt"]),
      message: z.string(),
      defaultValue: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("dialogSettled"),
      ...textFrameFields,
      generation: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("navState"),
      ...textFrameFields,
      ...browserNavStateSchema.shape,
    })
    .strict(),
  z
    .object({
      kind: z.literal("unsupportedInteraction"),
      ...textFrameFields,
      feature: browserScreencastUnsupportedFeatureSchema,
    })
    .strict(),
]);
export type BrowserScreencastServerFrame = z.infer<
  typeof browserScreencastServerFrameSchema
>;

const browserScreencastControlIdentitySchema = {
  armEpoch: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
};

const browserScreencastPointerTypeSchema = z.enum([
  "move",
  "down",
  "up",
  "wheel",
]);
export type BrowserScreencastPointerType = z.infer<
  typeof browserScreencastPointerTypeSchema
>;

const browserScreencastPointerButtonSchema = z.enum([
  "none",
  "left",
  "middle",
  "right",
  "back",
  "forward",
]);
export type BrowserScreencastPointerButton = z.infer<
  typeof browserScreencastPointerButtonSchema
>;

const browserScreencastKeyboardTypeSchema = z.enum([
  "rawKeyDown",
  "keyUp",
  "char",
]);

export const browserScreencastClientFrameSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ack"),
      ...textFrameFields,
      sequence: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("viewport"),
      ...textFrameFields,
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      dpr: z.number().finite().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("ping"),
      ...textFrameFields,
    })
    .strict(),
  z
    .object({
      kind: z.literal("arm"),
      ...textFrameFields,
      armEpoch: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("disarm"),
      ...textFrameFields,
      armEpoch: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pointer"),
      ...textFrameFields,
      ...browserScreencastControlIdentitySchema,
      type: browserScreencastPointerTypeSchema,
      castSequence: z.number().int().nonnegative(),
      normalizedX: z.number(),
      normalizedY: z.number(),
      button: browserScreencastPointerButtonSchema,
      buttons: z.number().int().min(0).max(31),
      modifiers: z.number().int().min(0).max(15),
      // Local click tracker; 0 for move/wheel.
      clickCount: z.number().int().min(0).max(8),
      deltaX: z.number(),
      deltaY: z.number(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("keyboard"),
      ...textFrameFields,
      ...browserScreencastControlIdentitySchema,
      type: browserScreencastKeyboardTypeSchema,
      code: z.string(),
      key: z.string(),
      modifiers: z.number().int().min(0).max(15),
      // DOM event.repeat.
      autoRepeat: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("insertText"),
      ...textFrameFields,
      ...browserScreencastControlIdentitySchema,
      text: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("navigate"),
      ...textFrameFields,
      ...browserScreencastControlIdentitySchema,
      url: z.string().max(2048),
    })
    .strict(),
  z
    .object({
      kind: z.literal("goBack"),
      ...textFrameFields,
      ...browserScreencastControlIdentitySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("goForward"),
      ...textFrameFields,
      ...browserScreencastControlIdentitySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("reload"),
      ...textFrameFields,
      ...browserScreencastControlIdentitySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("dialogResponse"),
      ...textFrameFields,
      armEpoch: z.number().int().nonnegative(),
      generation: z.number().int().nonnegative(),
      accept: z.boolean(),
      promptText: z.string().nullable(),
    })
    .strict(),
]);
export type BrowserScreencastClientFrame = z.infer<
  typeof browserScreencastClientFrameSchema
>;

export const browserScreencastV1 = defineStreamRpcContract({
  method: "browser.screencast",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: browserScreencastOpenRequestSchema,
  serverFrameSchema: browserScreencastServerFrameSchema,
  clientFrameSchema: browserScreencastClientFrameSchema,
});
