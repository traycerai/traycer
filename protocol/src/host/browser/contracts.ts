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

/** `epicId` is the stream's sole authorization and routing scope. */
export const browserSessionsOpenRequestSchema = z
  .object({
    epicId: z.string(),
  })
  .strict();

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

const browserSessionsCoreServerFrameSchemas = [
  z.object({
    kind: z.literal("snapshot"),
    ...textFrameFields,
    sessions: z.array(browserSessionInfoSchema),
  }),
  z.object({
    kind: z.literal("sessionCreated"),
    ...textFrameFields,
    session: browserSessionInfoSchema,
  }),
  z.object({
    kind: z.literal("sessionUpdated"),
    ...textFrameFields,
    session: browserSessionInfoSchema,
  }),
  z.object({
    kind: z.literal("sessionClosed"),
    ...textFrameFields,
    ...browserSessionReferenceFields,
    reason: browserSessionClosedReasonSchema,
  }),
  z.object({
    kind: z.literal("agentTabOpened"),
    ...textFrameFields,
    ...browserSessionReferenceFields,
    tabId: z.string(),
  }),
  z.object({
    kind: z.literal("actionAck"),
    ...requestFrameFields,
    ok: z.boolean(),
    reason: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("openTabResult"),
    ...requestFrameFields,
    result: z.discriminatedUnion("ok", [
      z
        .object({
          ok: z.literal(true),
          sessionId: z.string(),
          tabId: z.string(),
        })
        .strict(),
      z
        .object({
          ok: z.literal(false),
          reason: z.string(),
        })
        .strict(),
    ]),
  }),
  z.object({
    kind: z.literal("pong"),
    ...textFrameFields,
  }),
] as const;

/** Curated CDP vocabulary carried by the Electron-tab transport. */
const browserCdpErrorSchema = z
  .object({
    kind: z.enum(["not_attached", "tab_not_found", "cdp_error"]),
    message: z.string(),
    code: z.number().nullable(),
  })
  .strict();
export type BrowserCdpError = z.infer<typeof browserCdpErrorSchema>;

const browserCdpFrameInfoSchema = z
  .object({
    frameId: z.string(),
    parentFrameId: z.string().nullable(),
    url: z.string(),
  })
  .strict();
export type BrowserCdpFrameInfo = z.infer<typeof browserCdpFrameInfoSchema>;

/** Logical page target. Native CDP session ids never cross the host wire. */
export const browserCdpTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("root") }).strict(),
  z
    .object({
      kind: z.literal("frame"),
      frameId: z.string(),
      parentFrameId: z.string(),
    })
    .strict(),
]);
export type BrowserCdpTarget = z.infer<typeof browserCdpTargetSchema>;

const cdpRequestFrameFields = {
  ...requestFrameFields,
  tabId: z.string(),
  // Host resolves a durable Electron tabId to one exact native incarnation
  // before dispatch.
  registrationId: z.string(),
  target: browserCdpTargetSchema,
} as const;

const browserCdpCommandKindSchema = z.enum([
  "cdpNavigate",
  "cdpCaptureScreenshot",
  "cdpGetFrameTree",
  "cdpCreateIsolatedWorld",
  "cdpEvaluate",
  "cdpCallFunctionOn",
  "cdpReleaseObject",
  "cdpDispatchMouseEvent",
  "cdpInsertText",
  "cdpDispatchKeyEvent",
  "cdpSetDeviceMetricsOverride",
  "cdpDescribeNode",
]);

const cdpNavigateCommandSchema = z
  .object({
    kind: z.literal("cdpNavigate"),
    url: z.string().min(1),
  })
  .strict();
const cdpCaptureScreenshotCommandSchema = z
  .object({
    kind: z.literal("cdpCaptureScreenshot"),
    format: z.enum(["png", "jpeg"]),
    quality: z.number().int().min(0).max(100).nullable(),
  })
  .strict();
const cdpGetFrameTreeCommandSchema = z
  .object({
    kind: z.literal("cdpGetFrameTree"),
  })
  .strict();
const cdpCreateIsolatedWorldCommandSchema = z
  .object({
    kind: z.literal("cdpCreateIsolatedWorld"),
    frameId: z.string(),
    worldName: z.string(),
    grantUniversalAccess: z.boolean(),
  })
  .strict();
const cdpEvaluateCommandSchema = z
  .object({
    kind: z.literal("cdpEvaluate"),
    expression: z.string(),
    awaitPromise: z.boolean(),
    returnByValue: z.boolean(),
    // Targets the isolated world from `cdpCreateIsolatedWorld`; null evaluates
    // in the page's main world (CDP's own default when omitted).
    contextId: z.number().int().nullable(),
  })
  .strict();
const cdpCallFunctionOnCommandSchema = z
  .object({
    kind: z.literal("cdpCallFunctionOn"),
    target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("object"), objectId: z.string() }).strict(),
      z
        .object({
          kind: z.literal("context"),
          executionContextId: z.number().int(),
        })
        .strict(),
    ]),
    functionDeclaration: z.string(),
    arguments: z.array(z.object({ value: z.json() }).strict()).nullable(),
    returnByValue: z.boolean(),
  })
  .strict();
const cdpReleaseObjectCommandSchema = z
  .object({
    kind: z.literal("cdpReleaseObject"),
    objectId: z.string(),
  })
  .strict();
const cdpDispatchMouseEventCommandSchema = z
  .object({
    kind: z.literal("cdpDispatchMouseEvent"),
    type: z.enum(["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"]),
    x: z.number(),
    y: z.number(),
    button: z.enum(["left", "right", "middle", "none"]).nullable(),
    clickCount: z.number().int().nonnegative().nullable(),
    deltaX: z.number().nullable(),
    deltaY: z.number().nullable(),
  })
  .strict();
const cdpInsertTextCommandSchema = z
  .object({
    kind: z.literal("cdpInsertText"),
    text: z.string(),
  })
  .strict();
const cdpDispatchKeyEventCommandSchema = z
  .object({
    kind: z.literal("cdpDispatchKeyEvent"),
    type: z.enum(["keyDown", "keyUp", "rawKeyDown", "char"]),
    key: z.string().nullable(),
    code: z.string().nullable(),
    text: z.string().nullable(),
    modifiers: z.number().int().nullable(),
    unmodifiedText: z.string().nullable(),
    windowsVirtualKeyCode: z.number().int().nullable(),
    location: z.number().int().nonnegative().nullable(),
    isKeypad: z.boolean().nullable(),
    autoRepeat: z.boolean().nullable(),
    commands: z.array(z.string()).nullable(),
  })
  .strict();
const cdpSetDeviceMetricsOverrideCommandSchema = z
  .object({
    kind: z.literal("cdpSetDeviceMetricsOverride"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    deviceScaleFactor: z.number().positive(),
    mobile: z.boolean(),
  })
  .strict();
const cdpDescribeNodeCommandSchema = z
  .object({
    kind: z.literal("cdpDescribeNode"),
    objectId: z.string(),
    depth: z.number().int().nullable(),
    pierce: z.boolean(),
  })
  .strict();

/** Address-free CDP vocabulary shared by every browser runtime. */
export const browserCdpCommandSchema = z.discriminatedUnion("kind", [
  cdpNavigateCommandSchema,
  cdpCaptureScreenshotCommandSchema,
  cdpGetFrameTreeCommandSchema,
  cdpCreateIsolatedWorldCommandSchema,
  cdpEvaluateCommandSchema,
  cdpCallFunctionOnCommandSchema,
  cdpReleaseObjectCommandSchema,
  cdpDispatchMouseEventCommandSchema,
  cdpInsertTextCommandSchema,
  cdpDispatchKeyEventCommandSchema,
  cdpSetDeviceMetricsOverrideCommandSchema,
  cdpDescribeNodeCommandSchema,
]);
export type BrowserCdpCommand = z.infer<typeof browserCdpCommandSchema>;

/**
 * A returned JavaScript value. CDP distinguishes an absent `RemoteObject.value`
 * (JavaScript `undefined`) from a present JSON `null`; the wire must preserve
 * that distinction instead of using `null` as an absence sentinel.
 */
export const browserCdpValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("json"), value: z.json() }).strict(),
  z.object({ kind: z.literal("undefined") }).strict(),
]);
export type BrowserCdpValue = z.infer<typeof browserCdpValueSchema>;

const browserCdpSuccessResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("cdpNavigate"),
      ok: z.literal(true),
      errorText: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cdpCaptureScreenshot"),
      ok: z.literal(true),
      dataBase64: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cdpGetFrameTree"),
      ok: z.literal(true),
      frames: z.array(browserCdpFrameInfoSchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cdpCreateIsolatedWorld"),
      ok: z.literal(true),
      executionContextId: z.number().int(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cdpEvaluate"),
      ok: z.literal(true),
      value: browserCdpValueSchema,
      objectId: z.string().nullable(),
      exceptionDescription: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cdpCallFunctionOn"),
      ok: z.literal(true),
      value: browserCdpValueSchema,
      objectId: z.string().nullable(),
      exceptionDescription: z.string().nullable(),
    })
    .strict(),
  z
    .object({ kind: z.literal("cdpReleaseObject"), ok: z.literal(true) })
    .strict(),
  z
    .object({ kind: z.literal("cdpDispatchMouseEvent"), ok: z.literal(true) })
    .strict(),
  z.object({ kind: z.literal("cdpInsertText"), ok: z.literal(true) }).strict(),
  z
    .object({ kind: z.literal("cdpDispatchKeyEvent"), ok: z.literal(true) })
    .strict(),
  z
    .object({
      kind: z.literal("cdpSetDeviceMetricsOverride"),
      ok: z.literal(true),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cdpDescribeNode"),
      ok: z.literal(true),
      frameId: z.string().nullable(),
    })
    .strict(),
]);

export const browserCdpResultSchema = z.union([
  browserCdpSuccessResultSchema,
  z
    .object({
      kind: browserCdpCommandKindSchema,
      ok: z.literal(false),
      error: browserCdpErrorSchema,
    })
    .strict(),
]);
export type BrowserCdpResult = z.infer<typeof browserCdpResultSchema>;

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
  ...browserSessionsCoreServerFrameSchemas,
  browserCdpRequestFrameSchema,
  z.object({
    kind: z.literal("createElectronTab"),
    ...requestFrameFields,
    sessionId: z.string(),
    tabId: z.string(),
    // Navigation intent, not part of native provisioning readiness. Desktop
    // starts it only after the host accepts the provisioned incarnation.
    requestedUrl: z.string(),
    reason: electronTabCreateReasonSchema,
    seedStorageState: browserStorageStateSchema.nullable(),
  }),
  z.object({
    kind: z.literal("electronTabAccepted"),
    ...requestFrameFields,
    sessionId: z.string(),
    tabId: z.string(),
    registrationId: z.string(),
  }),
  z
    .object({
      kind: z.literal("releaseElectronTab"),
      ...textFrameFields,
      sessionId: z.string(),
      tabId: z.string(),
      registrationId: z.string(),
    })
    .strict(),
  z.object({
    // Refreshes the host's durable primary-profile snapshot after a committed
    // Electron navigation. Headless activation reads that snapshot; it never
    // opens a second, opportunistic renderer request path during placement.
    kind: z.literal("capturePrimaryProfile"),
    ...requestFrameFields,
  }),
  z.object({
    // Stream-only action burst; never persisted or replayed.
    kind: z.literal("burstStarted"),
    ...textFrameFields,
    sessionId: z.string(),
    tabId: z.string(),
    burstId: z.string(),
    chatId: z.string(),
  }),
  z.object({
    kind: z.literal("burstEnded"),
    ...textFrameFields,
    sessionId: z.string(),
    tabId: z.string(),
    burstId: z.string(),
    outcome: browserBurstOutcomeSchema,
  }),
  z.object({
    kind: z.literal("caption"),
    ...textFrameFields,
    sessionId: z.string(),
    tabId: z.string(),
    burstId: z.string(),
    cellTitle: z.string(),
  }),
]);
export type BrowserSessionsServerFrame = z.infer<
  typeof browserSessionsServerFrameSchema
>;

const browserSessionsCoreClientFrameSchemas = [
  z.object({
    kind: z.literal("openTab"),
    ...requestFrameFields,
    sessionId: z.string().nullable(),
    url: z.string(),
  }),
  z.object({
    // Tab-scoped close for the browser sidebar; closing the final tab also
    // closes its session.
    kind: z.literal("closeTab"),
    ...requestFrameFields,
    ...browserSessionReferenceFields,
    tabId: z.string(),
  }),
  z.object({
    kind: z.literal("ping"),
    ...textFrameFields,
  }),
] as const;

const browserCdpClientFrameSchemas = [
  z.object({
    kind: z.literal("cdpResult"),
    ...requestFrameFields,
    result: browserCdpResultSchema,
  }),
] as const;

export const browserSessionsClientFrameSchema = z.discriminatedUnion("kind", [
  ...browserSessionsCoreClientFrameSchemas,
  ...browserCdpClientFrameSchemas,
  z.object({
    // One settlement for one host-minted birth. Receipt means only that the
    // native guest exists, its durable identity is installed, and CDP can be
    // routed through this subscriber. Navigation and presentation begin only
    // after `electronTabAccepted` commits ownership.
    kind: z.literal("electronTabProvisioned"),
    ...requestFrameFields,
    sessionId: z.string(),
    tabId: z.string(),
    registrationId: z.string(),
  }),
  z.object({
    kind: z.literal("electronTabCreateFailed"),
    ...requestFrameFields,
    sessionId: z.string(),
    tabId: z.string(),
    code: electronTabCreateFailureCodeSchema,
    message: z.string(),
  }),
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
  z.object({
    kind: z.literal("primaryProfileCaptured"),
    ...requestFrameFields,
    storageState: browserStorageStateSchema.nullable(),
    status: z.enum(["captured", "unavailable", "failed"]),
    reason: z.string().nullable(),
  }),
  z.object({
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
    siblingTabs: z.array(
      z.object({
        tabId: z.string(),
        registrationId: z.string(),
        url: z.string(),
        capturedStorageState: browserStorageStateSchema.nullable(),
      }),
    ),
    reason: z.enum(["gui-quit", "tab-released", "crash-no-capture"]),
  }),
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

const browserScreencastMetadataSchema = z.object({
  offsetTop: z.number(),
  pageScaleFactor: z.number(),
  deviceWidth: z.number(),
  deviceHeight: z.number(),
  scrollOffsetX: z.number(),
  scrollOffsetY: z.number(),
  timestamp: z.number(),
});
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

export const browserScreencastServerFrameSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("started"),
    ...textFrameFields,
    frameWidth: z.number().int().positive(),
    frameHeight: z.number().int().positive(),
    deviceScaleFactor: z.number().positive(),
  }),
  z.object({
    kind: z.literal("frame"),
    ...binaryFrameFields,
    sequence: z.number().int().nonnegative(),
    metadata: browserScreencastMetadataSchema,
  }),
  z.object({
    kind: z.literal("stalled"),
    ...textFrameFields,
  }),
  z.object({
    kind: z.literal("resized"),
    ...textFrameFields,
    frameWidth: z.number().int().positive(),
    frameHeight: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("failed"),
    ...textFrameFields,
    reason: z.string(),
  }),
  z.object({
    kind: z.literal("complete"),
    ...textFrameFields,
  }),
  z.object({
    kind: z.literal("pong"),
    ...textFrameFields,
  }),
  z.object({
    kind: z.literal("armed"),
    ...textFrameFields,
    armEpoch: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("revoked"),
    ...textFrameFields,
    armEpoch: z.number().int().nonnegative(),
    cause: z.enum(["disarmed", "stolen"]),
  }),
  z.object({
    kind: z.literal("dialogOpened"),
    ...textFrameFields,
    generation: z.number().int().nonnegative(),
    type: z.enum(["alert", "beforeunload", "confirm", "prompt"]),
    message: z.string(),
    defaultValue: z.string(),
  }),
  z.object({
    kind: z.literal("dialogSettled"),
    ...textFrameFields,
    generation: z.number().int().nonnegative(),
  }),
  // Full navigation snapshot every time; consumers never reconstruct deltas.
  z.object({
    kind: z.literal("navState"),
    ...textFrameFields,
    url: z.string(),
    canGoBack: z.boolean(),
    canGoForward: z.boolean(),
    loading: z.boolean(),
  }),
  z.object({
    kind: z.literal("unsupportedInteraction"),
    ...textFrameFields,
    feature: browserScreencastUnsupportedFeatureSchema,
  }),
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
  z.object({
    kind: z.literal("ack"),
    ...textFrameFields,
    sequence: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("viewport"),
    ...textFrameFields,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    dpr: z.number().finite().positive(),
  }),
  z.object({
    kind: z.literal("ping"),
    ...textFrameFields,
  }),
  z.object({
    kind: z.literal("arm"),
    ...textFrameFields,
    armEpoch: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("disarm"),
    ...textFrameFields,
    armEpoch: z.number().int().nonnegative(),
  }),
  z.object({
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
  }),
  z.object({
    kind: z.literal("keyboard"),
    ...textFrameFields,
    ...browserScreencastControlIdentitySchema,
    type: browserScreencastKeyboardTypeSchema,
    code: z.string(),
    key: z.string(),
    modifiers: z.number().int().min(0).max(15),
    // DOM event.repeat.
    autoRepeat: z.boolean(),
  }),
  z.object({
    kind: z.literal("insertText"),
    ...textFrameFields,
    ...browserScreencastControlIdentitySchema,
    text: z.string(),
  }),
  z.object({
    kind: z.literal("navigate"),
    ...textFrameFields,
    ...browserScreencastControlIdentitySchema,
    url: z.string().max(2048),
  }),
  z.object({
    kind: z.literal("goBack"),
    ...textFrameFields,
    ...browserScreencastControlIdentitySchema,
  }),
  z.object({
    kind: z.literal("goForward"),
    ...textFrameFields,
    ...browserScreencastControlIdentitySchema,
  }),
  z.object({
    kind: z.literal("reload"),
    ...textFrameFields,
    ...browserScreencastControlIdentitySchema,
  }),
  z.object({
    kind: z.literal("dialogResponse"),
    ...textFrameFields,
    armEpoch: z.number().int().nonnegative(),
    generation: z.number().int().nonnegative(),
    accept: z.boolean(),
    promptText: z.string().nullable(),
  }),
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
