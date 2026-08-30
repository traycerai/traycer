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

/**
 * Deliberately NOT `.strict()`: Chrome emits cookie fields the contract does
 * not model (`_crHasCrossSiteAncestor`, …) and they change between Chromium
 * majors. Unknown keys are stripped, not rejected - a strict parse here failed
 * every capture and materialized native tabs logged out.
 *
 * `partitionKey` IS modelled, because dropping it silently merges a partitioned
 * cookie into the unpartitioned jar on restore. It is the storage-state STRING
 * form; a producer holding CDP's `{topLevelSite, hasCrossSiteAncestor}` object
 * must flatten it before it reaches this schema, and Electron's cookies API has
 * no partition key at all, so its producers send `null`.
 *
 * Known fidelity limit of that string form: Playwright flattens CDP's
 * `CookiePartitionKey` to `topLevelSite` and drops `hasCrossSiteAncestor`
 * (which arrives as one of the stripped `_cr*` extras). A cookie partitioned
 * with a cross-site ancestor therefore re-seeds into the neighbouring
 * `hasCrossSiteAncestor: false` partition - still partitioned, so not a
 * cross-site leak, just fidelity loss the wire's declared string form cannot
 * express.
 *
 * It defaults rather than being required: a peer built before CHIPS identity
 * existed omits the field entirely, and requiring it would fail the whole frame
 * parse. Frame drops are silent on both sides, so a required field here turned
 * a version skew into an inert "+ Add browser" button. Absent means
 * unpartitioned - the same thing those producers meant by sending `null`.
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

// Reserved evolution room, not yet added:
// - A `downloadEvent` server frame for file downloads/uploads (deferred,
//   spec decision #12); the honest unsupported toast stays until then.
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
      // Answers one `captureTabPreview`. Snapshot-only cross-host context
      // (spec decision #10): a still, a url and a title, never a drive
      // handle. `ok: false` carries `reason` and nothing else - notably a
      // dormant tab, which is reported rather than woken.
      kind: z.literal("tabPreviewResult"),
      ...requestFrameFields,
      ok: z.boolean(),
      /** Base64 JPEG, capped host-side. */
      screenshotBase64: z.string().nullable(),
      url: z.string().nullable(),
      title: z.string().nullable(),
      reason: z.string().nullable(),
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
      // Snapshot-only preview of one tab, for a chat pinned to ANOTHER host
      // that can never drive it (spec decision #10). No `sessionId`: the tab
      // is resolved by the owning host inside this stream's epic scope, which
      // is the only authorization there is.
      kind: z.literal("captureTabPreview"),
      ...requestFrameFields,
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
      // The GUI's declared co-located hostId. Null means "I have a native
      // browserView but I am not co-located with any host I can name". The
      // host compares this against its own id and must never elect a
      // subscriber whose declared id differs as Electron lifecycle owner
      // (spec decision #3): Electron placement is a same-machine
      // optimization, and this field is the sole locality signal it is
      // gated on.
      coLocatedHostId: z.string().nullable(),
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
 * WebRTC video-plane signaling, ridden on `browser.screencast@1.0` as new
 * frame kinds (webrtc-display-plane spec, decision 1 + 12: no third stream
 * method, no minor bump - the contract is pre-release).
 *
 * The host's capture helper page is the offerer: it owns the
 * `RTCPeerConnection` and only creates it once `getDisplayMedia` has a live
 * track, so it - not the client - knows when negotiation can start. The
 * client is therefore always the answerer. `negotiationId` correlates one
 * offer/answer/candidate round; a fallback-and-retry (decision 5) starts a
 * new one, so late candidates from an abandoned round are ignored rather
 * than mis-applied to the next attempt.
 */
/**
 * The candidate fields shared by the per-candidate `iceCandidate` trickle
 * frame and the A12 batch riding `sdpAnswer.candidates` - everything but
 * `negotiationId`, which only the standalone frame needs (the batch's own
 * frame already carries one for the whole array).
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

/** One candidate as it rides `sdpAnswer.candidates` (perf-hardening A12). */
const browserScreencastBatchedIceCandidateSchema = z.object(
  browserScreencastIceCandidateBaseFields,
);
export type BrowserScreencastBatchedIceCandidate = z.infer<
  typeof browserScreencastBatchedIceCandidateSchema
>;

/**
 * One ICE server the client should configure its `RTCPeerConnection` with,
 * mirroring the browser's `RTCIceServer`. The host mints these (short-TTL
 * TURN credentials) and stamps them on the offer, so both ends of a round
 * negotiate against the SAME set. Additive with a `[]` default: an older host
 * sends nothing and the client keeps its STUN-only fallback.
 */
export const browserScreencastIceServerSchema = z
  .object({
    urls: z.array(z.string()),
    username: z.string().nullable(),
    credential: z.string().nullable(),
  })
  .strict();
export type BrowserScreencastIceServer = z.infer<
  typeof browserScreencastIceServerSchema
>;

const browserScreencastAgentCursorTypeSchema = z.enum(["move", "down", "up"]);
export type BrowserScreencastAgentCursorType = z.infer<
  typeof browserScreencastAgentCursorTypeSchema
>;

const browserScreencastCaptureModeSchema = z.enum(["jpeg", "video"]);
export type BrowserScreencastCaptureMode = z.infer<
  typeof browserScreencastCaptureModeSchema
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
      kind: z.literal("pong"),
      ...textFrameFields,
    })
    .strict(),
  z
    .object({
      // Answer to a `ping` that arrived on a video-plane DataChannel (ticket
      // 17's input-path latency probe). Deliberately NOT the `pong` above:
      // that kind belongs to the stream transport's heartbeat, which answers
      // it host-side and, client-side, delivers a pong upward only when it
      // answers an application `ping` the transport itself queued - a pong
      // arriving for a DataChannel ping matches no queued ping and is
      // swallowed, so it could never reach the sender. Carries no correlation
      // id because the prober keeps one ping in flight at a time.
      kind: z.literal("inputPong"),
      ...textFrameFields,
    })
    .strict(),
  z
    .object({
      // Control-plane RTT probe (ticket 18). Its own frame pair rather than
      // the `ping`/`pong` above, which neither end can use for this: the
      // stream transport answers a client `ping` before any resolver sees it,
      // and the pong it sends back is credited to the transport's own ping
      // queue - so a host-side prober can never observe its reply, and on this
      // contract nobody can both initiate a round trip and observe it. The viewer answers with `rttProbeAck` carrying the same
      // `probeId`, and reads `controlPlaneRttMs` - the host's smoothed
      // estimate at send time, null before the first completed probe - to size
      // its own deadlines off the same measurement.
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
      // `denied` answers a `preArm` the host refused because another viewer
      // holds control. Only a viewer that sent one can ever receive it, which
      // is why adding it to this enum cannot break an older client.
      cause: z.enum(["disarmed", "stolen", "denied"]),
    })
    .strict(),
  z
    .object({
      // How far the host has consumed this arm epoch's input sequence
      // (ticket 20). Sent only for input that arrived over the MUX, coalesced,
      // so it exists exactly during the window where the client is waiting to
      // promote its pending DataChannel transport: once `lastSeq` covers the
      // last frame the client put on the mux, nothing can reorder against the
      // channel and the client promotes mid-arm.
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
      // The video plane's hit-testing token. A JPEG-plane tile correlates
      // input against the frame it painted (`castSequence`); a video-plane
      // tile has no such frame, so the host mints a viewport epoch from
      // `Page.getLayoutMetrics` and re-announces it whenever that geometry
      // changes. Input carrying a stale (or no) epoch is rejected, exactly
      // as input naming an unpresented frame is. Same counter as
      // `agentCursor.epoch`.
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
      // epoch minted by the host (ticket 06).
      epoch: z.number().int().nonnegative(),
      normalizedX: z.number(),
      normalizedY: z.number(),
      // Agent identity/context shown alongside the cursor overlay.
      label: z.string(),
    })
    .strict(),
  z
    .object({
      // Which capture is running for this subscriber, and so what its input
      // correlates against: `jpeg` = frames are being pumped, correlate on the
      // presented frame; `video` = the JPEG cast is stopped for the video
      // plane, correlate on the viewport epoch. `video` is sent when the
      // attempt STARTS, not when a track goes live - the client shows its
      // connecting loader for that window and paints no stale frame.
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
      // A speculative claim raised on hover (ticket 20), so the host has the
      // dispatcher live before the click that needs it. Its own kind rather
      // than a flag on `arm` because the AUTHORIZATION differs: this one is
      // refused (`revoked`, cause `denied`) when another viewer holds control,
      // where `arm` steals. Same epoch counter, same ordering, same
      // registry - only the steal is withheld.
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
      // Exactly one correlation token is set, per display plane: JPEG tiles
      // name the painted frame, video tiles name the host's viewport epoch
      // (see the `viewportEpoch` server frame). Neither set is unmappable
      // and the host rejects it.
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
      // Perf-hardening A12: local candidates gathered before the answer
      // shipped, batched here instead of one `iceCandidate` frame each.
      // `.default([])` - additive, and `browser.screencast` is not in the
      // released baseline (ticket 18's hazard note covers the future) - so
      // an older client that sends none still parses.
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
      reason: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("videoStats"),
      ...textFrameFields,
      // Receive-side WebRTC getStats + client-observed timing; the trace log
      // consumes this raw (semantics beyond the shape are ticket 11's scope).
      negotiationId: z.number().int().nonnegative(),
      framesDecoded: z.number().int().nonnegative(),
      framesDropped: z.number().int().nonnegative(),
      packetsLost: z.number().int().nonnegative(),
      jitterMs: z.number().nonnegative(),
      roundTripTimeMs: z.number().nonnegative(),
      // True capture-to-paint, median over the sampling window: WebRTC's
      // Absolute Capture Time extension puts the SENDER's capture instant on
      // the frame, and `requestVideoFrameCallback` metadata surfaces it as
      // `captureTime` in the receiver's own clock domain, so
      // `expectedDisplayTime - captureTime` needs no host stamp of its own.
      // Null whenever the extension was not negotiated (it is a default, not
      // a guarantee) or the WebView has no per-frame callback at all.
      glassToGlassMs: z.number().nonnegative().nullable(),
      // The same measurement's tail, and its two halves - `receiveTime` splits
      // capture-to-paint into "how long the network held the frame" and "how
      // long this client took to decode and composite it", which is the whole
      // difference between a path problem and a client problem. Additive
      // (ticket 17): `.default(null)` so an older client's frame still parses.
      glassToGlassP95Ms: z.number().nonnegative().nullable().default(null),
      networkPlusJitterMs: z.number().nonnegative().nullable().default(null),
      decodeCompositeMs: z.number().nonnegative().nullable().default(null),
      // Round trip of one `ping` sent on the `input-reliable` DataChannel: up
      // the DataChannel, back over the mux as `pong`. Deliberately asymmetric -
      // that IS the human input path's shape, and the uplink half is the leg
      // ticket 18 derives its deadlines from. Null until a ping has completed.
      dataChannelRttMs: z.number().nonnegative().nullable().default(null),
      // getStats() candidate-pair `candidateType` of the active receive
      // path (only observable receiver-side) - the "ICE path taken" metric.
      // Closed vocabulary: telemetry carries no free text.
      iceCandidatePairType: browserScreencastIcePairTypeSchema.catch("unknown"),
    })
    .strict(),
  z
    .object({
      // Reply to the host's `rttProbe`, sent as soon as the viewer sees it.
      // Carries nothing of its own: the host times the round trip and the
      // probe frame carries the result back.
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
