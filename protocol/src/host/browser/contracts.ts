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
      reason: z.enum(["gui-quit", "tab-released", "crash-no-capture"]),
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
