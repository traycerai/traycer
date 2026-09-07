/**
 * `browser.sessions@1.0` and `browser.screencast@1.0` - browser V1 stream contracts between the GUI and host-owned headless browser sessions.
 */
import { z } from "zod";
import { defineRpcContract } from "@traycer/protocol/framework/index";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  browserCdpCommandSchema,
  browserCdpResultSchema,
  browserCdpTargetSchema,
} from "@traycer/protocol/host/browser/cdp-contracts";

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

/**
 * Deliberately NOT `.strict()`: Chrome emits cookie fields the contract does not model (`_crHasCrossSiteAncestor`, …) and they change between Chromium majors.
 * `partitionKey` IS modelled, because dropping it silently merges a partitioned cookie into the unpartitioned jar on restore.
 */
export const browserStorageCookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  path: z.string(),
  expires: z.number(),
  httpOnly: z.boolean(),
  secure: z.boolean(),
  sameSite: z.enum(["Strict", "Lax", "None"]),
  partitionKey: z.string().nullable().default(null),
});
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
 * One coalescing window's worth of cookie change for a single registrable domain (`registrable-domain.ts` derives it on both ends).
 */
export const browserPrimaryProfileDeltaSchema = z
  .object({
    domain: z.string(),
    cookies: z.array(browserStorageCookieSchema),
    removedKeys: z.array(browserCookieKeySchema),
    /** When the window opened, from the sender's clock. */
    issuedAt: z.number(),
  })
  .strict();
export type BrowserPrimaryProfileDelta = z.infer<
  typeof browserPrimaryProfileDeltaSchema
>;

/*
 * Wire bounds for the carry-over path.
 * The two frames overflow in OPPOSITE directions, so they get two policies and these must not be unified into one
 */

/** Cookies one `primaryProfileObserved` frame may carry for its single registrable domain. */
export const BROWSER_PRIMARY_PROFILE_OBSERVED_MAX_COOKIES = 512;

/**
 * `primaryProfileObserved` frames one host may deliver in a single burst - the attach replay, which is the only place a host has a whole SET of domains to offer at once rather than the one domain a capture just changed.
 * That is safe precisely because the replay is stateless and idempotent: a domain that did not fit is not lost, only later.
 */
export const BROWSER_PRIMARY_PROFILE_OBSERVED_MAX_BURST = 64;

/** Per-domain entries one `primaryProfileForgetLedger` digest may carry. */
export const BROWSER_FORGET_LEDGER_MAX_DOMAINS = 1_024;

/**
 * One headless-observed sign-in for a single registrable domain (`registrable-domain.ts` derives it on both ends).
 * Do not read it as "this frame cannot assert a logout": ONE IMPLICIT CHANNEL REMAINS.
 */
export const browserPrimaryProfileObservedSchema = z
  .object({
    domain: z.string(),
    /** Every cookie the domain's subtree holds after the capture, not a delta. */
    cookies: z.array(browserStorageCookieSchema),
  })
  .strict();
export type BrowserPrimaryProfileObserved = z.infer<
  typeof browserPrimaryProfileObservedSchema
>;

/** One site the user forgot, stamped by the forgetting desktop's own clock. */
export const browserForgetLedgerDomainSchema = z
  .object({
    /** Registrable domain (eTLD+1) - never a cookie name, never a value. */
    domain: z.string(),
    forgottenAt: z.number(),
  })
  .strict();
export type BrowserForgetLedgerDomain = z.infer<
  typeof browserForgetLedgerDomainSchema
>;

/**
 * The desktop's durable forget ledger, projected for ONE host: a set of INSTRUCTIONS ("this site is gone", "everything before this was gone"), never clock values for the receiver to reason about.
 * A host that missed a push, or never acked one, is simply sent those entries again on the next push, so the digest stays idempotent and needs no host-side watermark.
 */
export const browserForgetLedgerSchema = z
  .object({
    forgetAllAt: z.number().nullable(),
    domains: z.array(browserForgetLedgerDomainSchema),
    /**
     * The authoring desktop's monotonic forget counter, bumped by every forget-all and every clear-site.
     * Desktop-local and never compared across machines: a host only ever echoes it back on the ack.
     */
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type BrowserForgetLedger = z.infer<typeof browserForgetLedgerSchema>;

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

// Reserved evolution room, not yet added: - A `downloadEvent` server frame for file downloads/uploads (deferred); the honest unsupported toast stays until then.
/**
 * The host's verdict on one `captureTabPreview`.
 * Snapshot-only cross-host context: a still, a url and a title, never a drive handle.
 */
export const browserTabPreviewSchema = z
  .object({
    ok: z.boolean(),
    /** Base64 JPEG, capped host-side to the wire bound below. */
    screenshotBase64: z.string().max(2_097_152).nullable(),
    // Deliberately uncapped: a real `data:`/`blob:` url or a long title would otherwise fail the whole frame's parse and the picker would just wait out its timeout.
    url: z.string().nullable(),
    title: z.string().nullable(),
    reason: z.string().nullable(),
  })
  .strict();
export type BrowserTabPreview = z.infer<typeof browserTabPreviewSchema>;

/** Who opened the tab: the agent driving the session, or the page itself. */
const browserTabOpenedSourceSchema = z.enum(["agent", "page"]);
export type BrowserTabOpenedSource = z.infer<
  typeof browserTabOpenedSourceSchema
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
      kind: z.literal("tabOpened"),
      ...textFrameFields,
      ...browserSessionReferenceFields,
      tabId: z.string(),
      source: browserTabOpenedSourceSchema,
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
      kind: z.literal("tabPreviewResult"),
      ...requestFrameFields,
      ...browserTabPreviewSchema.shape,
    })
    .strict(),
  z
    .object({
      // Answers one `primaryProfileCaptured`: the host has DURABLY stored (or rejected) that jar.
      kind: z.literal("primaryProfileCaptureAck"),
      ...requestFrameFields,
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
      // Which jar the guest gets.
      // `isolated` picks a per-session in-memory partition on the desktop and is never seeded, so the desktop cannot infer it from `seedStorageState` being null.
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
      // Refreshes the host's durable primary-profile snapshot after a committed Electron navigation.
      // Headless activation reads that snapshot; it never opens a second, opportunistic renderer request path during placement.
      kind: z.literal("capturePrimaryProfile"),
      ...requestFrameFields,
      // A STANDING request: capture nothing now, keep this `requestId`, and use it on the one capture the host cannot ask for - the flush the desktop pushes as it quits.
      standing: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      // Store-key handshake.
      kind: z.literal("storeKeyWrapRequest"),
      ...requestFrameFields,
      rawKey: z.base64().max(4096),
    })
    .strict(),
  z
    .object({
      // The blob some desktop wrapped earlier, handed back for `decryptString`.
      kind: z.literal("storeKeyUnwrapRequest"),
      ...requestFrameFields,
      wrappedKey: z.base64().max(4096),
    })
    .strict(),
  z
    .object({
      // "Prove you are a desktop this host hands the cookie jar to".
      // The nonce is 32 random bytes the host holds on the challenged subscriber and deletes on the first answer, so a captured signature replays onto nothing and a second connection's answer never settles this one.
      kind: z.literal("desktopIdentityChallenge"),
      ...requestFrameFields,
      nonce: z.base64().max(64),
    })
    .strict(),
  z
    .object({
      // A sign-in this host witnessed inside a headless session, offered to the desktops that hold the master jar.
      // Emitted from headless capture events only - never echoed back from a desktop's own `primaryProfileDelta`, which is what terminates the loop - and from primary-profile-backed sessions only, so ephemeral ones stay.
      kind: z.literal("primaryProfileObserved"),
      ...textFrameFields,
      ...browserPrimaryProfileObservedSchema.shape,
    })
    .strict(),
  z
    .object({
      // This host has finished pruning everything the desktop's ledger named through `revision` - the stored slice, the headless-contributed markers, and the live headless contexts.
      kind: z.literal("primaryProfileForgetLedgerAck"),
      ...textFrameFields,
      revision: z.number().int().nonnegative(),
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

/**
 * Domain-separation tag for the desktop identity attestation.
 * Versioned so a future payload shape cannot be confused with this one, and product-tagged so a signature minted here can never be replayed as any other Ed25519 signature the same key might one day produce.
 */
const DESKTOP_IDENTITY_ATTEST_DOMAIN = "traycer-desktop-identity-attest-v1";

/**
 * The exact bytes `desktopIdentityAttest.signature` commits to.
 * Exported from the contract itself so the two sides cannot drift.
 */
export function canonicalDesktopIdentityAttestBytes(input: {
  readonly hostId: string;
  /** The challenge nonce, base64, exactly as it came off the wire. */
  readonly nonce: string;
  /** Ed25519 SPKI DER, base64, exactly as it goes onto the wire. */
  readonly publicKey: string;
}): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      domain: DESKTOP_IDENTITY_ATTEST_DOMAIN,
      hostId: input.hostId,
      nonce: input.nonce,
      publicKey: input.publicKey,
    }),
  );
}

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
      // Snapshot-only preview of one tab, for a chat pinned to ANOTHER host that can never drive it.
      kind: z.literal("captureTabPreview"),
      ...requestFrameFields,
      tabId: z.string(),
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
      // One settlement for one host-minted birth.
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
      // The GUI's declared co-located hostId.
      // The host compares this against its own id and must never elect a subscriber whose declared id differs as Electron lifecycle owner: Electron placement is a same-machine optimization, and this field is the sole locality.
      coLocatedHostId: z.string().nullable(),
      // There was a `desktopWindowId` here.
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
      // The answer to a `capturePrimaryProfile` this host issued.
      kind: z.literal("primaryProfileCaptured"),
      ...requestFrameFields,
      storageState: browserStorageStateSchema.nullable(),
      status: z.enum(["captured", "unavailable", "failed"]),
      reason: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("primaryProfileDelta"),
      ...textFrameFields,
      ...browserPrimaryProfileDeltaSchema.shape,
    })
    .strict(),
  z
    .object({
      // The desktop's answer to `desktopIdentityChallenge` (browser-security-hardening H09): an Ed25519 signature over {@link canonicalDesktopIdentityAttestBytes}, made in the desktop's MAIN process with a key `safeStorage`.
      // No `userId`: the identity is the stream's authenticated user, and the signed bytes commit to the hostId instead, so a signature cannot be relayed into another host's challenge.
      kind: z.literal("desktopIdentityAttest"),
      // Echoes the challenge's `requestId`.
      ...requestFrameFields,
      // Ed25519 SPKI DER.
      publicKey: z.base64().max(128),
      // Which keystore on this machine holds the private half.
      keystoreId: z.string().max(64),
      signature: z.base64().max(128),
      // Whether this desktop's keystore can actually hold the host's store key.
      // A machine whose OS keystore cannot encrypt (Linux with no secret service) still mints a durable keypair and attests, so it keeps native tab placement, and declares `false` so the host never hands it a jar it could not.
      jarEligible: z.boolean(),
    })
    .strict(),
  z
    .object({
      // `safeStorage.encryptString(rawKey)` for the `requestId` the host sent.
      kind: z.literal("storeKeyWrapped"),
      ...requestFrameFields,
      wrappedKey: z.base64().max(4096),
    })
    .strict(),
  z
    .object({
      // `safeStorage.decryptString(wrappedKey)`.
      // `null` means this desktop cannot open the blob (keystore item ACL changed, different machine); the host then stays sealed and never re-mints over a live blob.
      kind: z.literal("storeKeyUnwrapped"),
      ...requestFrameFields,
      rawKey: z.base64().max(4096).nullable(),
    })
    .strict(),
  z
    .object({
      // "Clear" on one row of Settings > Browser > Sites with saved logins.
      kind: z.literal("clearSite"),
      ...textFrameFields,
      domain: z.string(),
    })
    .strict(),
  z
    .object({
      // "Forget all browser logins".
      kind: z.literal("forgetLogins"),
      ...textFrameFields,
    })
    .strict(),
  z
    .object({
      // The desktop's forget ledger, pushed on every forget action and once at attach BEFORE any observed replay - so a host can never re-offer, in the replay, a login the user forgot while that host was disconnected.
      // Answered with `primaryProfileForgetLedgerAck` once the prune has finished, which is what orders the desktop's applier against this host's observations; re-sending it is always safe, because the prune is idempotent.
      kind: z.literal("primaryProfileForgetLedger"),
      ...textFrameFields,
      ...browserForgetLedgerSchema.shape,
    })
    .strict(),
]);
export type BrowserSessionsClientFrame = z.infer<
  typeof browserSessionsClientFrameSchema
>;

/**
 * The `browser.sessions` server frames a desktop RENDERER may see.
 * The jar plane lives in the desktop main process, so every frame that carries cookies, a storage state, key material or a signing challenge is consumed there and never projected outward.
 */
export const BROWSER_SESSIONS_JAR_SERVER_FRAME_KINDS = [
  "createElectronTab",
  "electronTabAccepted",
  "releaseElectronTab",
  "cdpRequest",
  "capturePrimaryProfile",
  "primaryProfileObserved",
  "storeKeyWrapRequest",
  "storeKeyUnwrapRequest",
  "desktopIdentityChallenge",
  "primaryProfileCaptureAck",
  "primaryProfileForgetLedgerAck",
] as const;

export type BrowserSessionsJarServerFrame = Extract<
  BrowserSessionsServerFrame,
  {
    readonly kind: (typeof BROWSER_SESSIONS_JAR_SERVER_FRAME_KINDS)[number];
  }
>;

export type BrowserSessionsUxServerFrame = Exclude<
  BrowserSessionsServerFrame,
  BrowserSessionsJarServerFrame
>;

export function isBrowserSessionsJarServerFrame(
  frame: BrowserSessionsServerFrame,
): frame is BrowserSessionsJarServerFrame {
  return JAR_SERVER_FRAME_KINDS.has(frame.kind);
}

const JAR_SERVER_FRAME_KINDS: ReadonlySet<string> = new Set(
  BROWSER_SESSIONS_JAR_SERVER_FRAME_KINDS,
);

/**
 * The second half of the same rule, and the one the exclusion list cannot state: whatever the union is named, no renderer-reachable frame may carry a cookie array, a storage state or key material as a TOP-LEVEL field.
 */
type BrowserSessionsUxFrameCarryingJarMaterial = Extract<
  BrowserSessionsUxServerFrame,
  | { readonly cookies: unknown }
  | { readonly storageState: unknown }
  | { readonly rawKey: unknown }
  | { readonly wrappedKey: unknown }
  | { readonly seedStorageState: unknown }
  // The doc above says "or a signing challenge", and these are the two fields that carry one.
  | { readonly nonce: unknown }
  | { readonly signature: unknown }
>;
const noJarMaterialReachesARenderer: BrowserSessionsUxFrameCarryingJarMaterial extends never
  ? true
  : never = true;
void noJarMaterialReachesARenderer;

/** The client frames a renderer may ASK for: the three user-initiated tab requests, and nothing else. */
export const BROWSER_SESSIONS_UX_CLIENT_FRAME_KINDS = [
  "openTab",
  "closeTab",
  "captureTabPreview",
] as const;

export type BrowserSessionsUxClientFrame = Extract<
  BrowserSessionsClientFrame,
  {
    readonly kind: (typeof BROWSER_SESSIONS_UX_CLIENT_FRAME_KINDS)[number];
  }
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
    /**
     * Which host contributed this login, when it was a HEADLESS session on the answering host rather than the user's own desktop jar.
     */
    contributedByHostId: z.string().nullable().default(null),
  })
  .strict();
export type BrowserSavedLoginSite = z.infer<typeof browserSavedLoginSiteSchema>;

/** No input: the slice read is the caller's own, from the request identity. */
export const browserSavedLoginSitesRequestSchema = z.object({}).strict();

/**
 * `sealed` is not "no sites": it is "this host holds no key for you yet", and the two must never render the same way - one is an empty jar, the other is a jar nobody here can open (spec section 6.2).
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
 * Names only, never values (spec section 7.3).
 * The host projects the registrable domains of the live cookie keys in the caller's own slice; the cookies themselves never leave the host on this path, so a compromised renderer learns which sites the user is signed.
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

/**
 * The subscription's control tier.
 * Input by tier was never the boundary: a client authenticated as this user already drives the tab through the browser MCP and agent RPCs.
 */
const browserScreencastViewerRoleSchema = z.enum(["tile", "pip", "viewer"]);
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

/** ICE candidate-pair types telemetry may report - a closed vocabulary. */
export const browserScreencastIcePairTypeSchema = z.enum([
  "host",
  "srflx",
  "prflx",
  "relay",
  "unknown",
]);
export type BrowserScreencastIcePairType = z.infer<
  typeof browserScreencastIcePairTypeSchema
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

/**
 * WebRTC video-plane signaling, ridden on `browser.screencast@1.0` as new frame kinds: no third stream method, no minor bump - the contract is pre-release.
 */
const browserScreencastIceCandidateBaseFields = {
  candidate: z.string().max(16_384),
  sdpMid: z.string().nullable(),
  sdpMLineIndex: z.number().int().nonnegative().nullable(),
} as const;

const browserScreencastIceCandidateFields = {
  negotiationId: z.number().int().nonnegative(),
  ...browserScreencastIceCandidateBaseFields,
} as const;

/** One candidate as it rides `sdpAnswer.candidates`. */
const browserScreencastBatchedIceCandidateSchema = z
  .object(browserScreencastIceCandidateBaseFields)
  .strict();
export type BrowserScreencastBatchedIceCandidate = z.infer<
  typeof browserScreencastBatchedIceCandidateSchema
>;

/**
 * One ICE server the client should configure its `RTCPeerConnection` with, mirroring the browser's `RTCIceServer`.
 */
export const browserScreencastIceServerSchema = z
  .object({
    urls: z.array(z.string().max(2_048)).max(16),
    username: z.string().nullable(),
    credential: z.string().nullable(),
  })
  .strict();
export type BrowserScreencastIceServer = z.infer<
  typeof browserScreencastIceServerSchema
>;

/**
 * The STUN-only fallback both ends use when no TURN set was minted - a public server, so it is a literal rather than configuration.
 * One constant because host and viewer must fall back to the SAME server or they gather against different pools.
 */
export const BROWSER_SCREENCAST_STUN_URL = "stun:stun.l.google.com:19302";

const browserScreencastAgentCursorTypeSchema = z.enum(["move", "down", "up"]);
export type BrowserScreencastAgentCursorType = z.infer<
  typeof browserScreencastAgentCursorTypeSchema
>;

const browserScreencastCaptureModeSchema = z.enum(["jpeg", "video"]);
export type BrowserScreencastCaptureMode = z.infer<
  typeof browserScreencastCaptureModeSchema
>;

/** Why a viewer gave up on a video-plane round. */
export const browserVideoPlaneFailureReasonSchema = z.enum([
  "no-first-frame",
  "frames-stopped",
  "track-ended",
  "connection-closed",
  "connection-failed",
  "answer-failed",
]);
export type BrowserVideoPlaneFailureReason = z.infer<
  typeof browserVideoPlaneFailureReasonSchema
>;

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
      // Answer to every `ping` on this contract, whichever transport carried it.
      kind: z.literal("inputPong"),
      ...textFrameFields,
    })
    .strict(),
  z
    .object({
      // Control-plane RTT probe.
      kind: z.literal("rttProbe"),
      ...textFrameFields,
      probeId: z.number().int().nonnegative(),
      controlPlaneRttMs: z.number().nonnegative().nullable(),
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
      // `denied` answers a `preArm` the host refused because another viewer holds control.
      // Only a viewer that sent one can ever receive it, which is why adding it to this enum cannot break an older client.
      cause: z.enum(["disarmed", "stolen", "denied"]),
    })
    .strict(),
  z
    .object({
      // How far the host has consumed this arm epoch's input sequence.
      kind: z.literal("inputAck"),
      ...textFrameFields,
      armEpoch: z.number().int().nonnegative(),
      lastSeq: z.number().int().nonnegative(),
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
  z
    .object({
      kind: z.literal("sdpOffer"),
      ...textFrameFields,
      negotiationId: z.number().int().nonnegative(),
      sdp: z.string().max(1_048_576),
      iceServers: z.array(browserScreencastIceServerSchema).default([]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("iceCandidate"),
      ...textFrameFields,
      ...browserScreencastIceCandidateFields,
    })
    .strict(),
  z
    .object({
      // The video plane's hit-testing token.
      kind: z.literal("viewportEpoch"),
      ...textFrameFields,
      epoch: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("agentCursor"),
      ...textFrameFields,
      type: browserScreencastAgentCursorTypeSchema,
      // Normalized [0,1] to the viewport-epoch geometry, unclamped;
      // epoch minted by the host.
      epoch: z.number().int().nonnegative(),
      normalizedX: z.number(),
      normalizedY: z.number(),
      // Agent identity/context shown alongside the cursor overlay.
      label: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("captureMode"),
      ...textFrameFields,
      mode: browserScreencastCaptureModeSchema,
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
      // A speculative claim raised on hover, so the host has the dispatcher live before the click that needs it.
      kind: z.literal("preArm"),
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
      castSequence: z.number().int().nonnegative().nullable().default(null),
      viewportEpoch: z.number().int().nonnegative().nullable().default(null),
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
  z
    .object({
      kind: z.literal("sdpAnswer"),
      ...textFrameFields,
      negotiationId: z.number().int().nonnegative(),
      sdp: z.string().max(1_048_576),
      // Local candidates gathered before the answer shipped, batched here instead of one `iceCandidate` frame each.
      candidates: z
        .array(browserScreencastBatchedIceCandidateSchema)
        .max(256)
        .default([]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("iceCandidate"),
      ...textFrameFields,
      ...browserScreencastIceCandidateFields,
    })
    .strict(),
  z
    .object({
      kind: z.literal("videoPlaneState"),
      ...textFrameFields,
      // Lets the host ignore a "failed" from a negotiation round it already
      // abandoned (a retry started a new, higher negotiationId).
      negotiationId: z.number().int().nonnegative(),
      // "live" = first decoded video frame; "failed" = track death/timeout.
      state: z.enum(["live", "failed"]),
      reason: browserVideoPlaneFailureReasonSchema.nullable(),
      // Free-form context for the one code that has any (`answer-failed` carries the SDP error's text).
      // Never parsed - it exists so the closed vocabulary above does not cost the host its diagnostics.
      detail: z.string().max(256).nullable().default(null),
    })
    .strict(),
  z
    .object({
      kind: z.literal("videoStats"),
      ...textFrameFields,
      // Receive-side WebRTC getStats + client-observed timing; the trace log
      // consumes this raw (semantics beyond the shape are out of scope here).
      negotiationId: z.number().int().nonnegative(),
      framesDecoded: z.number().int().nonnegative(),
      framesDropped: z.number().int().nonnegative(),
      packetsLost: z.number().int().nonnegative(),
      jitterMs: z.number().nonnegative(),
      roundTripTimeMs: z.number().nonnegative(),
      glassToGlassMs: z.number().nonnegative().nullable(),
      glassToGlassP95Ms: z.number().nonnegative().nullable().default(null),
      networkPlusJitterMs: z.number().nonnegative().nullable().default(null),
      decodeCompositeMs: z.number().nonnegative().nullable().default(null),
      // Round trip of one `ping` sent on the `input-reliable` DataChannel: up the DataChannel, back over the mux as `inputPong`.
      dataChannelRttMs: z.number().nonnegative().nullable().default(null),
      // getStats() candidate-pair `candidateType` of the active receive path (only observable receiver-side) - the "ICE path taken" metric.
      iceCandidatePairType: browserScreencastIcePairTypeSchema.catch("unknown"),
    })
    .strict(),
  z
    .object({
      // Reply to the host's `rttProbe`, sent as soon as the viewer sees it.
      kind: z.literal("rttProbeAck"),
      ...textFrameFields,
      probeId: z.number().int().nonnegative(),
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
