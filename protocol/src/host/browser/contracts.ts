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

export const browserOriginTierSchema = z.enum(["dev", "external"]);
export type BrowserOriginTier = z.infer<typeof browserOriginTierSchema>;

export const browserSessionStatusSchema = z.enum([
  "provisioning",
  "ready",
  "navigating",
  "closing",
  "crashed",
  // Shared-browser-runtime ticket 01: a tab whose backing page has been
  // suspended (host restart, capacity reclaim) but whose record persists for
  // on-demand restore - see the persistence-and-lifecycle plan. No driver
  // reports this today; it is carried on the wire ahead of the ticket that
  // produces it so consumers can match on it now.
  "dormant",
]);
export type BrowserSessionStatus = z.infer<typeof browserSessionStatusSchema>;

export const browserSessionClosedReasonSchema = z.enum([
  "completed",
  "idle-ttl",
  "evicted",
  "crashed",
]);
export type BrowserSessionClosedReason = z.infer<
  typeof browserSessionClosedReasonSchema
>;

/**
 * Shared-browser-runtime ticket 01. The identity boundary a session's tabs
 * share: `"primary"` is the one shared, signed-in profile per host;
 * `"isolated"` is a throwaway profile with no carried-over identity. Every
 * session this ticket's consumers construct is `"primary"` - real isolated
 * profiles are the host-runtime-and-discovery plan's job.
 */
export const browserSessionProfileKindSchema = z.enum(["primary", "isolated"]);
export type BrowserSessionProfileKind = z.infer<
  typeof browserSessionProfileKindSchema
>;

/**
 * Shared-browser-runtime ticket 01. One attributed driver of a tab -
 * `requestId` names a single in-flight action, `agentRunId` is `null` for a
 * user-driven action. The concurrency model (settled decision 7) is
 * last-writer-wins with no locks; this list is purely attribution, built by
 * reference-counting action start/finish, not a queue or a lock.
 */
export const browserTabDriverSchema = z.object({
  chatId: z.string(),
  agentRunId: z.string().nullable(),
  requestId: z.string(),
});
export type BrowserTabDriver = z.infer<typeof browserTabDriverSchema>;

/**
 * Shared-browser-runtime ticket 01. One page within a session, addressed by
 * a durable, host-minted `tabId` - never a Chromium target id (settled
 * decision 5). This ticket's consumers mint exactly one tab per session
 * (multi-tab mechanics are a later ticket), so `tabId` is currently always
 * equal to the owning session's `sessionId`.
 */
export const browserTabInfoSchema = z.object({
  tabId: z.string(),
  url: z.string(),
  originTier: browserOriginTierSchema,
  status: browserSessionStatusSchema,
  title: z.string().nullable(),
  // Live discovery hint only: the currently viewed/MRU visible tile, or an
  // active headless screencast peek. It grants no control capability.
  viewed: z.boolean(),
  drivenBy: z.array(browserTabDriverSchema),
});
export type BrowserTabInfo = z.infer<typeof browserTabInfoSchema>;

/**
 * Shared-browser-runtime ticket 01. Non-authorizing provenance: which chat
 * (and, if an agent, which run) created the session. `BrowserSessionInfo`'s
 * `epicId` is the authorizing scope now (settled decision 1); this field is
 * metadata only, kept for sidebar attribution ("Agent: checkout test").
 */
export const browserSessionCreatedBySchema = z.object({
  chatId: z.string(),
  agentRunId: z.string().nullable(),
});
export type BrowserSessionCreatedBy = z.infer<
  typeof browserSessionCreatedBySchema
>;

/**
 * Shared-browser-runtime ticket 01 baseline. A session is an epic-scoped
 * group of tabs bound to one profile (the three-layer model's middle layer,
 * plan settled decision 5) - `url`/`title`/`status`/`originTier` moved onto
 * `BrowserTabInfo` since those describe a page, not the session grouping it.
 */
export const browserSessionInfoSchema = z.object({
  sessionId: z.string(),
  epicId: z.string(),
  hostId: z.string(),
  profile: browserSessionProfileKindSchema,
  name: z.string(),
  createdBy: browserSessionCreatedBySchema,
  createdAt: z.number(),
  lastActivityAt: z.number(),
  // Explicit live-runtime settlement for reverse migration. `revision`
  // changes only after the transition has settled, so a cast that received
  // terminal(migrated) never has to infer rollback from tab/binding shape.
  migration: z
    .object({
      revision: z.number().int().nonnegative(),
      runtime: z.enum(["headless", "electron", "dormant"]),
    })
    .optional(),
  tabs: z.array(browserTabInfoSchema),
});
export type BrowserSessionInfo = z.infer<typeof browserSessionInfoSchema>;

export const browserVisibleTileDataLevelSchema = z.enum([
  "console-entry",
  "network-request",
  "screenshot",
  "element",
  "debug-errors",
  "debug-snapshot",
  "control",
]);
export type BrowserVisibleTileDataLevel = z.infer<
  typeof browserVisibleTileDataLevelSchema
>;

const browserVisibleTileGrantSchemaV11 = z.object({
  chatId: z.string(),
  tileInstanceId: z.string(),
  origin: z.string(),
  dataLevel: browserVisibleTileDataLevelSchema,
  expiresAt: z.number(),
});

export const browserVisibleTileGrantSchema = browserVisibleTileGrantSchemaV11
  .extend({
    grantId: z.string(),
  })
  .strict();
export type BrowserVisibleTileGrant = z.infer<
  typeof browserVisibleTileGrantSchema
>;

export const browserVisibleTileActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("click"),
    selector: z.string().min(1),
  }),
  z.object({
    kind: z.literal("type"),
    selector: z.string().min(1),
    text: z.string(),
  }),
  z.object({
    kind: z.literal("scroll"),
    deltaX: z.number(),
    deltaY: z.number(),
  }),
  z.object({
    kind: z.literal("navigate"),
    url: z.string().min(1),
  }),
]);
export type BrowserVisibleTileAction = z.infer<
  typeof browserVisibleTileActionSchema
>;

/**
 * `epicId` authorizes session visibility and actions (settled decision 1).
 * `chatId` stays required because this stream is also the transport for
 * existing chat-routed actions
 * (`electronTabHandoff`, the visible-tile-control and borrowed-tile flows, the CDP
 * bridge), whose responses must return to the originating chat dock. It is a
 * routing key only, never a session-authorization boundary.
 */
export const browserSessionsOpenRequestSchema = z.object({
  epicId: z.string(),
  chatId: z.string(),
});
export type BrowserSessionsOpenRequest = z.infer<
  typeof browserSessionsOpenRequestSchema
>;

const browserSessionsServerFrameSchemaV10 = z.discriminatedUnion("kind", [
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
    kind: z.literal("provisionProgress"),
    ...textFrameFields,
    phase: z.string(),
    bytesDownloaded: z.number().int().nonnegative(),
    bytesTotal: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("promoteState"),
    ...requestFrameFields,
    url: z.string(),
    // Opaque JSON blob (Playwright storageState). The protocol intentionally
    // does not structurally type this payload: tightening the field schema in a
    // later minor would be breaking, and streams cannot bump majors. The host
    // and GUI validate it at their own boundaries.
    storageState: z.json(),
  }),
  z.object({
    kind: z.literal("lendResult"),
    ...requestFrameFields,
    ok: z.boolean(),
    reason: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("actionAck"),
    ...requestFrameFields,
    ok: z.boolean(),
    reason: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("pong"),
    ...textFrameFields,
  }),
]);

const browserSessionsServerFrameSchemaV12 = z.discriminatedUnion("kind", [
  ...browserSessionsServerFrameSchemaV10.def.options,
  z.object({
    kind: z.literal("visibleTileControlRequest"),
    ...requestFrameFields,
    grantId: z.string(),
    chatId: z.string(),
    agentRunId: z.string().nullable(),
    agentLabel: z.string(),
    tileInstanceId: z.string(),
    origin: z.string(),
    url: z.string().nullable(),
    requestedAt: z.number(),
    expiresAt: z.number(),
  }),
  z.object({
    kind: z.literal("visibleTileControlResult"),
    ...requestFrameFields,
    tileInstanceId: z.string(),
    ok: z.boolean(),
    reason: z.string().nullable(),
    grant: browserVisibleTileGrantSchema.nullable(),
  }),
  z.object({
    kind: z.literal("visibleTileControlAction"),
    ...requestFrameFields,
    grantId: z.string(),
    tileInstanceId: z.string(),
    action: browserVisibleTileActionSchema,
    requestedAt: z.number(),
  }),
]);

/**
 * Ticket 03 - typed CDP bridge for the agent's own tile (`browser.sessions@1.3`).
 *
 * The host cannot reach an Electron tile's CDP debugger directly (it's an
 * electron-main-only API), so this bridge crosses host -> renderer -> IPC ->
 * `webContents.debugger`. A single frame shaped like `method: string, params:
 * object` would collapse to an opaque blob under `flattenToFieldMap` (see
 * `versioned-stream-rpc.ts`): it only diffs fields at the TOP LEVEL of each
 * sub-schema. A *nested* discriminated union (e.g. `action:
 * browserVisibleTileActionSchema` above) fares no better, just differently -
 * the whole nested union serializes into ONE key's value, so growing it is
 * classified as a breaking `schema-changed` rather than an additive key
 * addition. It doesn't slip through undetected; it hard-fails the additivity
 * check outright, which makes it just as unusable for a method set expected
 * to keep growing. So every enumerated CDP method gets its own top-level
 * frame kind, request and result, rather than one dispatch frame carrying a
 * method name plus opaque params - that is the only method set this framework
 * can grow additively. The closed `target` union below is identity, not an
 * extensible method set.
 *
 * This is a versioning artifact for the agent's own credential-free browser,
 * not a security boundary - no policy is enforced through this bridge, and it
 * must not be generalized into one for arbitrary CDP passthrough. The method
 * set is deliberately bounded to what the curated agent-browser API needs
 * today:
 *
 * - `cdpNavigate` / `cdpCaptureScreenshot` / `cdpGetFrameTree` - the agent
 *   tile's own navigation, screenshot and frame-tree primitives (`Page.*`).
 * - `cdpEvaluate` / `cdpCallFunctionOn` / `cdpReleaseObject` - script
 *   execution against the tile's main world (`Runtime.*`).
 * - `cdpDispatchMouseEvent` / `cdpInsertText` / `cdpDispatchKeyEvent` -
 *   synthetic interaction (`Input.*`).
 * - `cdpSetDeviceMetricsOverride` - viewport control (`Emulation.*`).
 * - `cdpSetAutoAttach` (request/result) / `cdpTargetAttached` (push
 *   notification) - session discovery (`Target.*`). Unlike everything else
 *   excluded below, this one is not deferred: the snapshot-serializer spike
 *   already established that Electron OOPIF composition works specifically
 *   via flattened `Target.setAutoAttach` plus `Target.attachedToTarget`
 *   session routing, so ticket 05's cross-origin frame composition cannot
 *   work on the GUI runtime without it. Including it presupposes nothing.
 * - `cdpDescribeNode` (`DOM.*`) - also not deferred, also spike-settled: per
 *   `snapshot-serializer-spike/index.md`, mapping a parent iframe *element*
 *   to its child frame's id is identical on both runtimes -
 *   `DOM.describeNode({objectId})` on the parent session, reading
 *   `node.frameId` off the result. `Target.*` alone gives session routing;
 *   this is what gives the `frameId` to route to. Deliberately narrow: only
 *   the `objectId`-addressed form is exposed (matching how every other
 *   method here resolves elements via a `Runtime.evaluate`/`callFunctionOn`
 *   remote object, never `DOM.getDocument`/`querySelector`'s own node-id
 *   space) - this does not reopen raw DOM-domain traversal.
 *
 * Deliberately excluded, with the reason each belongs to a later ticket:
 *
 * - Cookie/storage methods (`Network.setCookie` etc.) - the agent's own tile
 *   is fresh-partition and credential-free by design (ticket 02); storage
 *   lending is a borrowed-tile concept (ticket 09), not this bridge's.
 * - `Page.createIsolatedWorld` - ticket 06 explicitly leaves "where the
 *   runner page lives" unresolved and load-bearing; adding a typed frame for
 *   it now would presuppose that answer.
 * - Console/network event forwarding, downloads, dialogs, PDF - these are
 *   either push-notification shaped (a different frame family; see the
 *   snapshot/provenance envelope in ticket 05) or explicitly left for ticket
 *   04's cross-runtime parity investigation to resolve first.
 * - A raw-CDP passthrough - the enumerated set above already covers
 *   everything the curated API needs; if a genuine need for one appears
 *   later, it must be added as an explicitly-named escape hatch marked
 *   outside this frame-diffing discipline, not folded into it.
 */
export const browserCdpErrorSchema = z.object({
  kind: z.enum([
    "not_attached",
    "tab_not_found",
    "tile_not_found",
    "cdp_error",
  ]),
  message: z.string(),
  code: z.number().nullable(),
});
export type BrowserCdpError = z.infer<typeof browserCdpErrorSchema>;

export const browserCdpFrameInfoSchema = z.object({
  frameId: z.string(),
  parentFrameId: z.string().nullable(),
  url: z.string(),
  securityOrigin: z.string().nullable(),
});
export type BrowserCdpFrameInfo = z.infer<typeof browserCdpFrameInfoSchema>;

export const browserCdpTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("electron-tab"),
      tabId: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("borrowed-tile"),
      tileInstanceId: z.string(),
    })
    .strict(),
]);
export type BrowserCdpTarget = z.infer<typeof browserCdpTargetSchema>;

const cdpRequestFrameFields = {
  ...requestFrameFields,
  target: browserCdpTargetSchema,
  // Host resolves a durable Electron tabId to one exact native incarnation
  // before dispatch. Borrowed tiles have no native incarnation and use null.
  registrationId: z.string().nullable(),
  // Targets a specific Electron flattened CDP session (an attached OOPIF or
  // worker session). `null` means the target's root session.
  cdpSessionId: z.string().nullable(),
} as const;

const cdpResultFrameFields = {
  ...requestFrameFields,
  target: browserCdpTargetSchema,
  // Echoes the request route so a delayed result cannot settle work issued to
  // a replacement native guest that owns the same durable tabId.
  registrationId: z.string().nullable(),
  ok: z.boolean(),
  error: browserCdpErrorSchema.nullable(),
} as const;

const browserSessionsServerFrameSchemaV13 = z.discriminatedUnion("kind", [
  ...browserSessionsServerFrameSchemaV12.def.options,
  z.object({
    kind: z.literal("cdpNavigate"),
    ...cdpRequestFrameFields,
    url: z.string().min(1),
  }),
  z.object({
    kind: z.literal("cdpCaptureScreenshot"),
    ...cdpRequestFrameFields,
    format: z.enum(["png", "jpeg"]),
    quality: z.number().int().min(0).max(100).nullable(),
  }),
  z.object({
    kind: z.literal("cdpGetFrameTree"),
    ...cdpRequestFrameFields,
  }),
  // Spike step 2: an isolated world INSIDE the observed page (e.g.
  // `__aside_utility`), distinct from - and unrelated to - wherever ticket
  // 06 ultimately puts the cell-runner's own blank page. This is needed
  // regardless of that unresolved decision.
  z.object({
    kind: z.literal("cdpCreateIsolatedWorld"),
    ...cdpRequestFrameFields,
    frameId: z.string(),
    worldName: z.string(),
    grantUniversalAccess: z.boolean(),
  }),
  z.object({
    kind: z.literal("cdpEvaluate"),
    ...cdpRequestFrameFields,
    expression: z.string(),
    awaitPromise: z.boolean(),
    returnByValue: z.boolean(),
    // Targets the isolated world from `cdpCreateIsolatedWorld`; null
    // evaluates in the page's main world (CDP's own default when omitted).
    contextId: z.number().int().nullable(),
  }),
  z.object({
    kind: z.literal("cdpCallFunctionOn"),
    ...cdpRequestFrameFields,
    // CDP's `Runtime.callFunctionOn` addresses either a bound object
    // (`objectId`) or a free-standing execution context
    // (`executionContextId`) - exactly one of these two must be non-null.
    // The free-standing form is what step 4 needs: calling
    // `globalThis.__aside.takeSnapshot` isn't bound to any particular
    // object, it's a global function inside the isolated world.
    objectId: z.string().nullable(),
    executionContextId: z.number().int().nullable(),
    functionDeclaration: z.string(),
    // Opaque JSON blob (CDP `CallArgument[]`). Same rationale as
    // `promoteState.storageState` above: structurally typing every possible
    // CDP call argument would be breaking to tighten later, and the host and
    // renderer both validate at their own boundaries.
    argumentsJson: z.json().nullable(),
    returnByValue: z.boolean(),
  }),
  z.object({
    kind: z.literal("cdpReleaseObject"),
    ...cdpRequestFrameFields,
    objectId: z.string(),
  }),
  z.object({
    kind: z.literal("cdpDispatchMouseEvent"),
    ...cdpRequestFrameFields,
    type: z.enum(["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"]),
    x: z.number(),
    y: z.number(),
    button: z.enum(["left", "right", "middle", "none"]).nullable(),
    clickCount: z.number().int().nonnegative().nullable(),
    deltaX: z.number().nullable(),
    deltaY: z.number().nullable(),
  }),
  z.object({
    kind: z.literal("cdpInsertText"),
    ...cdpRequestFrameFields,
    text: z.string(),
  }),
  z.object({
    kind: z.literal("cdpDispatchKeyEvent"),
    ...cdpRequestFrameFields,
    type: z.enum(["keyDown", "keyUp", "rawKeyDown", "char"]),
    key: z.string().nullable(),
    code: z.string().nullable(),
    text: z.string().nullable(),
    modifiers: z.number().int().nullable().default(null),
    unmodifiedText: z.string().nullable().default(null),
    windowsVirtualKeyCode: z.number().int().nullable().default(null),
    location: z.number().int().nonnegative().nullable().default(null),
    isKeypad: z.boolean().nullable().default(null),
    autoRepeat: z.boolean().nullable().default(null),
    commands: z.array(z.string()).nullable().default(null),
  }),
  z.object({
    kind: z.literal("cdpSetDeviceMetricsOverride"),
    ...cdpRequestFrameFields,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    deviceScaleFactor: z.number().positive(),
    mobile: z.boolean(),
  }),
  // Session discovery for OOPIF/worker composition (ticket 04, per the
  // snapshot-serializer spike): `enableAfterCommit` already issues this
  // automatically for the root session on attach, so this exists for
  // explicit host-issued control - most concretely, re-arming auto-attach on
  // a child session so grandchild targets (nested OOPIFs) also flatten in,
  // which `handleTargetAttached`'s per-child enable of Runtime/Log/Network
  // does not itself do.
  z.object({
    kind: z.literal("cdpSetAutoAttach"),
    ...cdpRequestFrameFields,
    autoAttach: z.boolean(),
    waitForDebuggerOnStart: z.boolean(),
  }),
  z.object({
    kind: z.literal("cdpDescribeNode"),
    ...cdpRequestFrameFields,
    objectId: z.string(),
    // null omits CDP's `depth` param entirely (its own default is 1, i.e.
    // immediate children only); the frame-composition use case only reads
    // `frameId` off the root description, so callers rarely need more.
    depth: z.number().int().nullable(),
    pierce: z.boolean(),
  }),
  // Spike step 7 (ground truth for our own byte-identical-output comparison
  // tests, e.g. ticket 05's cross-runtime parity assertions) - not part of
  // the production snapshot path itself.
  z.object({
    kind: z.literal("cdpGetFullAXTree"),
    ...cdpRequestFrameFields,
    depth: z.number().int().nullable(),
  }),
]);

/**
 * Ticket 09 - borrowed-tile attachment (`browser.sessions@1.4`).
 *
 * A borrowed tile is one the USER already had open, in
 * `persist:traycer-browser` with their real logins, that they asked the agent
 * in chat to drive. The chat request IS the consent (v3): there is no
 * confirmation frame here and no grant handshake, deliberately - contrast
 * `visibleTileControlRequest` above, which is T18's older ask-then-grant
 * shape for the same tiles.
 *
 * These two frames carry only the ATTACHMENT LIFETIME. The driving itself
 * reuses the `cdp*` frames above unchanged, which is what "capability parity
 * with the agent's own tile" means concretely: a borrowed tile gets the same
 * fourteen curated methods, including `cdpEvaluate`, over the same transport.
 *
 * What the attachment frames add is the part borrowed tiles need and the
 * agent's own tile does not:
 *
 * - `borrowedTileAttached` tells the renderer which tile is being driven,
 *   by whom, and until when. The renderer needs all three: it registers that
 *   tile's CDP handler ONLY while an attachment is live, and it renders the
 *   passive indicator (our deliberate divergence from Aside, which marks
 *   borrowed tabs not at all) carrying the detach affordance.
 * - `borrowedTileDetached` ends it - on user detach, on expiry, or on host
 *   teardown. The renderer unregisters, agent access ends, indicator goes.
 *
 * There is deliberately NO frame that lists or enumerates tiles. A `tiles`
 * namespace would leak the existence, count and origins of tiles the user
 * never named, which is exactly the widening this ticket must not do: the
 * agent reaches the tile the user named and nothing else.
 *
 * Once a post-release minor exists, `browser-stream-resolver.ts` must parse
 * and emit against the negotiated minor. Unknown object fields are additive;
 * unknown discriminated-union arms and enum values are not. Registry-level
 * schema additivity never substitutes for per-connection emission gating.
 */
export const browserBurstOutcomeSchema = z.enum([
  "finished",
  "closed",
  "crashed",
  "suspended",
]);
export type BrowserBurstOutcome = z.infer<typeof browserBurstOutcomeSchema>;

export const electronTabCreateReasonSchema = z.enum([
  "session-bootstrap",
  "agent-open",
  "restore",
]);
export type ElectronTabCreateReason = z.infer<
  typeof electronTabCreateReasonSchema
>;

export const electronTabCreateFailureCodeSchema = z.enum([
  "identity_violation",
  "native_unavailable",
  "native_create_failed",
]);
export type ElectronTabCreateFailureCode = z.infer<
  typeof electronTabCreateFailureCodeSchema
>;

export const browserSessionsServerFrameSchema = z.discriminatedUnion("kind", [
  ...browserSessionsServerFrameSchemaV13.def.options,
  z.object({
    kind: z.literal("createElectronTab"),
    ...requestFrameFields,
    sessionId: z.string(),
    tabId: z.string(),
    // Navigation intent, not part of native provisioning readiness. Desktop
    // starts it only after the host accepts the provisioned incarnation.
    requestedUrl: z.string(),
    reason: electronTabCreateReasonSchema,
    seedStorageState: z.json().nullable(),
  }),
  z.object({
    kind: z.literal("electronTabAccepted"),
    ...requestFrameFields,
    sessionId: z.string(),
    tabId: z.string(),
    registrationId: z.string(),
  }),
  z.object({
    kind: z.literal("releaseElectronTab"),
    ...requestFrameFields,
    sessionId: z.string(),
    tabId: z.string(),
    registrationId: z.string(),
  }),
  z.object({
    // Refreshes the host's durable primary-profile snapshot after a committed
    // Electron navigation. Headless activation reads that snapshot; it never
    // opens a second, opportunistic renderer request path during placement.
    kind: z.literal("capturePrimaryProfile"),
    ...requestFrameFields,
  }),
  z.object({
    // Push notification, same shape rules as `cdpSessionEnded` above: a
    // fresh `requestId` per push for envelope consistency, not correlation.
    kind: z.literal("borrowedTileAttached"),
    ...requestFrameFields,
    tileInstanceId: z.string(),
    attachmentId: z.string(),
    chatId: z.string(),
    agentRunId: z.string().nullable(),
    agentLabel: z.string(),
    attachedAt: z.number(),
    // Absolute, host-computed, and never extended in place - an attachment
    // is time-limited by construction (v3: "time-limited and does not
    // silently persist"). The renderer holds it so the indicator can end the
    // attachment on its own clock rather than trusting a frame to arrive.
    expiresAt: z.number(),
  }),
  z.object({
    kind: z.literal("borrowedTileDetached"),
    ...requestFrameFields,
    tileInstanceId: z.string(),
    attachmentId: z.string(),
    reason: z.string(),
  }),
  z.object({
    // Agent-browser PiP tickets 01 and 06. Stream-only: never persisted
    // and never replayed on subscribe. `caption` is one frame per
    // (cell, tab) when the cell's first action lands on that tab.
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

const browserSessionsClientFrameSchemaV10 = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("getPromoteState"),
    ...requestFrameFields,
    ...browserSessionReferenceFields,
  }),
  z.object({
    kind: z.literal("lendStorage"),
    ...requestFrameFields,
    ...browserSessionReferenceFields,
    origin: z.string(),
    // Opaque JSON blob (Playwright storageState). The protocol intentionally
    // does not structurally type this payload: tightening the field schema in a
    // later minor would be breaking, and streams cannot bump majors. The host
    // and GUI validate it at their own boundaries.
    storage: z.json(),
  }),
  z.object({
    kind: z.literal("closeSession"),
    ...requestFrameFields,
    ...browserSessionReferenceFields,
  }),
  z.object({
    // Tab-scoped close for the browser sidebar. Names one tab; `closeSession`
    // remains the whole-session path and the last-tab cleanup.
    kind: z.literal("closeTab"),
    ...requestFrameFields,
    ...browserSessionReferenceFields,
    tabId: z.string(),
  }),
  z.object({
    kind: z.literal("ping"),
    ...textFrameFields,
  }),
]);

const browserSessionsClientFrameSchemaV12 = z.discriminatedUnion("kind", [
  ...browserSessionsClientFrameSchemaV10.def.options,
  z.object({
    kind: z.literal("visibleTileControlDecision"),
    ...requestFrameFields,
    approved: z.boolean(),
    grant: browserVisibleTileGrantSchema.nullable(),
    reason: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("visibleTileControlRevoked"),
    ...requestFrameFields,
    grantId: z.string(),
    tileInstanceId: z.string(),
    reason: z.string(),
  }),
  z.object({
    kind: z.literal("visibleTileControlActionResult"),
    ...requestFrameFields,
    grantId: z.string(),
    ok: z.boolean(),
    reason: z.string().nullable(),
    value: z.unknown().nullable(),
  }),
]);

const browserSessionsClientFrameSchemaV13 = z.discriminatedUnion("kind", [
  ...browserSessionsClientFrameSchemaV12.def.options,
  z.object({
    kind: z.literal("cdpNavigateResult"),
    ...cdpResultFrameFields,
    frameId: z.string().nullable(),
    loaderId: z.string().nullable(),
    errorText: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("cdpCaptureScreenshotResult"),
    ...cdpResultFrameFields,
    dataBase64: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("cdpGetFrameTreeResult"),
    ...cdpResultFrameFields,
    frames: z.array(browserCdpFrameInfoSchema).nullable(),
  }),
  z.object({
    kind: z.literal("cdpEvaluateResult"),
    ...cdpResultFrameFields,
    // Opaque JSON blob (CDP `RemoteObject`). Modeling every possible remote
    // value/preview/error shape would be breaking to tighten later; the host
    // interprets it at its own boundary (ticket 04's typed error taxonomy
    // layers on top of this, it does not live in the wire frame).
    resultJson: z.json().nullable(),
    objectId: z.string().nullable(),
    exceptionDescription: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("cdpCallFunctionOnResult"),
    ...cdpResultFrameFields,
    resultJson: z.json().nullable(),
    objectId: z.string().nullable(),
    exceptionDescription: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("cdpReleaseObjectResult"),
    ...cdpResultFrameFields,
  }),
  z.object({
    kind: z.literal("cdpDispatchMouseEventResult"),
    ...cdpResultFrameFields,
  }),
  z.object({
    kind: z.literal("cdpInsertTextResult"),
    ...cdpResultFrameFields,
  }),
  z.object({
    kind: z.literal("cdpDispatchKeyEventResult"),
    ...cdpResultFrameFields,
  }),
  z.object({
    kind: z.literal("cdpSetDeviceMetricsOverrideResult"),
    ...cdpResultFrameFields,
  }),
  z.object({
    // The addressed CDP debugger can detach for reasons outside our control
    // (target destroyed, renderer crash, explicit detach). The renderer
    // pushes this the moment `onDetached` fires so the host ends the
    // agent's access immediately instead of only discovering it lazily on
    // the next failed dispatch. Opening DevTools is NOT one of those causes
    // on Electron 42.7.1/Chromium 148 - verified 2026-07-28, it coexists
    // with the attached debugger there.
    kind: z.literal("cdpSessionEnded"),
    ...requestFrameFields,
    target: browserCdpTargetSchema,
    // Native lifecycle pushes must name the exact guest incarnation. Borrowed
    // tiles have attachment identity in their target and therefore send null.
    registrationId: z.string().nullable(),
    reason: z.string(),
  }),
  z.object({
    kind: z.literal("cdpSetAutoAttachResult"),
    ...cdpResultFrameFields,
  }),
  z.object({
    // Push notification, not a response to a specific request - mirrors
    // `cdpSessionEnded`'s shape (a fresh `requestId` per push, for envelope
    // consistency only, not request/response correlation). Fired whenever
    // CDP's own `Target.attachedToTarget` fires on the target's root session,
    // so the host can discover a flattened child (OOPIF/worker) session id
    // to address further dispatches at - this bridge's existing per-command
    // `cdpSessionId` field already carries them once known.
    kind: z.literal("cdpTargetAttached"),
    ...requestFrameFields,
    target: browserCdpTargetSchema,
    // See cdpSessionEnded above: durable tabId alone cannot distinguish a
    // delayed event from a native guest that has already been replaced.
    registrationId: z.string().nullable(),
    cdpSessionId: z.string(),
    targetId: z.string(),
    targetType: z.string(),
    url: z.string(),
    waitingForDebugger: z.boolean(),
  }),
  z.object({
    kind: z.literal("cdpDescribeNodeResult"),
    ...cdpResultFrameFields,
    nodeId: z.number().int().nullable(),
    backendNodeId: z.number().int().nullable(),
    nodeName: z.string().nullable(),
    // The field this method exists for: the child frame this node owns, if
    // any (only populated for frame-owner elements like iframe/frame/object).
    frameId: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("cdpCreateIsolatedWorldResult"),
    ...cdpResultFrameFields,
    executionContextId: z.number().int().nullable(),
  }),
  z.object({
    kind: z.literal("cdpGetFullAXTreeResult"),
    ...cdpResultFrameFields,
    // Opaque JSON blob (CDP `AXNode[]`) - ground truth for test comparison
    // only. Modeling the full recursive AXNode shape would be premature
    // specification for a value nothing else consumes structurally.
    nodesJson: z.json().nullable(),
  }),
]);

const browserSessionsClientFrameSchemaV14 = z.discriminatedUnion("kind", [
  ...browserSessionsClientFrameSchemaV13.def.options,
  z.object({
    // Ticket 09. The renderer has ENDED a borrowed-tile attachment - the user
    // pressed detach on the passive indicator, or the tile's debugger
    // detached out from under it (`reason` says which).
    //
    // Named in the past tense on purpose: this REPORTS a release that has
    // already happened, it does not ask for one. The host has no refusal path
    // here and must not grow one - detach is the mechanism the borrowed-tile
    // design's safety rests on, and a refusable detach is not a detach. Same
    // shape as `visibleTileControlRevoked` above, which is also a report.
    // (`...requestFrameFields` is a transport convention on every client
    // frame in this contract; it carries `requestId` for envelope
    // consistency and implies nothing about request/response semantics.)
    //
    // The renderer stops answering dispatches for the tile BEFORE sending
    // this, and the host refuses every later dispatch for it on receipt, so
    // a frame that is delayed, dropped, or never sent cannot leave the agent
    // driving a tile the user has released.
    kind: z.literal("borrowedTileReleased"),
    ...requestFrameFields,
    tileInstanceId: z.string(),
    attachmentId: z.string(),
    reason: z.string(),
  }),
]);

export const browserSessionsClientFrameSchema = z.discriminatedUnion("kind", [
  ...browserSessionsClientFrameSchemaV14.def.options,
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
  z.object({
    // One-shot capability readiness for ticket 06's canonical Electron
    // profile capture. This stays on the existing stream; it is not a
    // general capability-negotiation subsystem.
    kind: z.literal("primaryProfileCaptureReady"),
    ...requestFrameFields,
  }),
  z.object({
    // The subscriber has the complete native tab lifecycle and CDP seam.
    // Deliberately separate from primaryProfileCaptureReady: storage capture
    // alone cannot create, restore, or drive an Electron tab.
    kind: z.literal("electronTabLifecycleReady"),
    ...requestFrameFields,
  }),
  z.object({
    kind: z.literal("electronTabState"),
    ...requestFrameFields,
    registrationId: z.string(),
    sessionId: z.string(),
    tabId: z.string(),
    url: z.string(),
    title: z.string().nullable(),
    status: browserSessionStatusSchema,
    viewed: z.boolean(),
  }),
  z.object({
    kind: z.literal("primaryProfileCaptured"),
    ...requestFrameFields,
    // Same opaque Playwright storage-state convention as promote/lend and
    // electronTabHandoff. The host validates the concrete cookies+origins shape.
    storageState: z.json().nullable(),
    status: z.enum(["captured", "unavailable", "failed"]),
    reason: z.string().nullable(),
  }),
  z.object({
    // Desktop pushes this once, just before a durable Electron tab dies, for
    // ANY teardown reason - there is no signal distinguishing
    // "the whole GUI quit" from "one subscriber detached" (see ticket 10's
    // artifact), so the real trigger is "the native incarnation is going
    // away", which `closeEntry`'s three call sites and a renderer crash all
    // are.
    //
    // Durable identity is carried directly. `registrationId` prevents a late
    // teardown from an old native guest from handing off a replacement guest
    // that already owns the same `tabId`.
    //
    // `capturedStorageState` is an opaque JSON blob (Playwright storageState
    // shape), same convention as `promoteState`/`lendStorage` above: the
    // protocol does not structurally type it, because tightening the field
    // schema in a later minor would be breaking and streams cannot bump
    // majors. `null` means desktop could not safely capture state for this
    // teardown (see `reason: "crash-no-capture"`) - the host still hands the
    // session off headless at `capturedUrl`, just without carried storage.
    //
    // Ticket 02 (multi-tab handoff): `siblingTabs` carries the session's
    // OTHER live tabs (same session, everything but the triggering tab)
    // captured best-effort at the same moment, so one frame hands off the
    // whole session atomically instead of racing one frame per tab against
    // the runtime flip. Each entry's `capturedStorageState` follows the same
    // opaque/nullable convention as the primary capture above. Empty for a
    // single-tab session, byte-identical to today.
    kind: z.literal("electronTabHandoff"),
    ...requestFrameFields,
    sessionId: z.string(),
    tabId: z.string(),
    registrationId: z.string(),
    capturedUrl: z.string(),
    capturedStorageState: z.json().nullable(),
    siblingTabs: z.array(
      z.object({
        tabId: z.string(),
        registrationId: z.string(),
        url: z.string(),
        capturedStorageState: z.json().nullable(),
      }),
    ),
    reason: z.enum(["gui-quit", "tab-released", "crash-no-capture"]),
  }),
]);
export type BrowserSessionsClientFrame = z.infer<
  typeof browserSessionsClientFrameSchema
>;

/**
 * Shared-browser-runtime ticket 01: baseline rewrite. `browser.sessions` had
 * never shipped, so its prior minor history (@1.0 through @1.4, tracked as
 * separate frozen contracts) is collapsed into one fresh `@1.0` carrying
 * every frame kind this file defines - no projection machinery and no
 * frozen-minor exports to preserve, since nothing has shipped for them to
 * stay compatible with. Agent-browser PiP ticket 01 extends that same 1.0
 * in place (`burstStarted` / `burstEnded` / `caption`).
 */
export const browserSessionsV1 = defineStreamRpcContract({
  method: "browser.sessions",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: browserSessionsOpenRequestSchema,
  serverFrameSchema: browserSessionsServerFrameSchema,
  clientFrameSchema: browserSessionsClientFrameSchema,
});

export const browserScreencastFormatSchema = z.enum(["jpeg"]);
export type BrowserScreencastFormat = z.infer<
  typeof browserScreencastFormatSchema
>;

export const browserScreencastViewerRoleSchema = z.enum(["tile", "pip"]);
export type BrowserScreencastViewerRole = z.infer<
  typeof browserScreencastViewerRoleSchema
>;

/**
 * Epic-authorized and tab-addressed: a session can carry more than one tab
 * (settled decision 5), so screencast names both the epic boundary and the
 * page it mirrors.
 *
 * Agent-browser PiP ticket 01 adds `role` in place (schema only until
 * ticket 04). `.default("tile")` (not `.optional`) so omitted frames read
 * as `"tile"` and nothing changes for them.
 */
export const browserScreencastOpenRequestSchema = z.object({
  epicId: z.string(),
  sessionId: z.string(),
  tabId: z.string(),
  maxWidth: z.number().int().positive(),
  maxHeight: z.number().int().positive(),
  quality: z.number().int().min(0).max(100),
  format: browserScreencastFormatSchema,
  role: browserScreencastViewerRoleSchema.default("tile"),
});
export type BrowserScreencastOpenRequest = z.infer<
  typeof browserScreencastOpenRequestSchema
>;

export const browserScreencastMetadataSchema = z.object({
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

export const browserScreencastUnsupportedFeatureSchema = z.enum([
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
    cause: z.enum(["migrated"]).optional(),
  }),
  z.object({
    kind: z.literal("migrationPending"),
    ...textFrameFields,
    pending: z.boolean(),
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
  // Screencast-natural-control: full snapshot every time, no deltas.
  // Schema only here; the host starts emitting these in ticket 04.
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

export const browserScreencastPointerTypeSchema = z.enum([
  "move",
  "down",
  "up",
  "wheel",
]);
export type BrowserScreencastPointerType = z.infer<
  typeof browserScreencastPointerTypeSchema
>;

export const browserScreencastPointerButtonSchema = z.enum([
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

export const browserScreencastKeyboardTypeSchema = z.enum([
  "rawKeyDown",
  "keyUp",
  "char",
]);
export type BrowserScreencastKeyboardType = z.infer<
  typeof browserScreencastKeyboardTypeSchema
>;

export const browserScreencastClientFrameSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ack"),
    ...textFrameFields,
    sequence: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("setPaused"),
    ...textFrameFields,
    paused: z.boolean(),
  }),
  z.object({
    kind: z.literal("setParams"),
    ...textFrameFields,
    maxWidth: z.number().int().positive(),
    maxHeight: z.number().int().positive(),
    quality: z.number().int().min(0).max(100),
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
    clickCount: z.number().int().min(0).max(8).default(1),
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
    autoRepeat: z.boolean().default(false),
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

export const browserScreencastV10 = defineStreamRpcContract({
  method: "browser.screencast",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: browserScreencastOpenRequestSchema,
  serverFrameSchema: browserScreencastServerFrameSchema,
  clientFrameSchema: browserScreencastClientFrameSchema,
});
