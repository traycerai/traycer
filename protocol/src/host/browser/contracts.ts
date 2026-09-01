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
 * domain (`registrable-domain.ts` derives it on both ends). The two lists
 * answer two different questions and neither can stand in for the other.
 *
 * `cookies` is the **complete** picture of the domain after the window (every
 * cookie its subtree holds), not just the ones that changed. It is what lets
 * the host *reconcile* its cache by absence - the store converging on the
 * desktop's jar.
 *
 * `removedKeys` names what the sender watched **disappear from its own jar**
 * during the window. That is the only logout evidence on this frame:
 * reconciliation buries cookies for all sorts of innocent reasons (a headless
 * context contributed a cookie this desktop never had), so the host propagates
 * a sign-out to live sessions from `removedKeys` alone and never from what a
 * merge happened to tombstone.
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
 * Wire bounds for the universal-sign-in carry-over path (decision 8). Both
 * ends import these, so the producer clamps against exactly the number the
 * receiver enforces.
 *
 * They are exported constants rather than `.max()` on the schemas below, and
 * that is deliberate. A schema bound turns an over-bound frame into a silent
 * parse failure inside the stream transport: the receiver never sees the
 * frame, so it can neither WARN (keyed by `instance=`) nor emit the
 * `over-bound` reject trace these paths are diagnosed by, and this epic's
 * bugs were found by trace forensics. The receiver counts and rejects instead.
 *
 * The two frames overflow in OPPOSITE directions, so they get two policies and
 * these must not be unified into one:
 *
 * - `primaryProfileObserved` over-bound: reject the WHOLE frame, apply none of
 *   it. Dropping an observation costs a re-login; applying an attacker-chosen
 *   prefix of one writes into the master jar. Failing closed is safe here.
 * - `primaryProfileForgetLedger` over-bound: apply EVERYTHING the digest
 *   carries, then WARN and trace the overflow. Never drop it. Rejecting a
 *   forget digest leaves every login it names alive on the host - a silent
 *   resurrection of exactly the sessions the user asked to be gone - so on
 *   this frame a whole-frame reject is the fail-OPEN direction and is
 *   forbidden.
 */

/**
 * Cookies one `primaryProfileObserved` frame may carry for its single
 * registrable domain. Chromium's own per-host cap is 180, so this leaves room
 * for a domain whose subtree spans several hostnames while still bounding what
 * one compromised host can write into the user's jar in a single frame - a
 * real sign-in is tens of cookies, not hundreds.
 */
export const BROWSER_PRIMARY_PROFILE_OBSERVED_MAX_COOKIES = 512;

/**
 * `primaryProfileObserved` frames one host may deliver in a single burst - the
 * attach replay, which is the only place a host has a whole SET of domains to
 * offer at once rather than the one domain a capture just changed.
 *
 * It is ONE number because it is a two-sided contract whose ends fail in
 * opposite directions when they disagree. The host paces its replay to stay at
 * or under it; the desktop's rate limiter (universal-sign-in ticket 03) must
 * admit a burst of exactly this size before it begins refusing. A limiter set
 * lower silently truncates a legitimate reconnect - the user stays signed out
 * on the very machine that asked for the replay, with nothing on either end
 * saying why - and a host pacing higher reaches the same outcome from the
 * other side.
 *
 * A host holding more marked domains than this sends the first burst and
 * leaves the rest for the next attach. That is safe precisely because the
 * replay is stateless and idempotent (decision 5): a domain that did not fit
 * is not lost, only later.
 *
 * 64 is far above a realistic replay - a user's agents sign into a handful of
 * sites, not dozens - and far below what would read as a flood to a desktop
 * applying each frame through Chromium's own `cookies.set`.
 */
export const BROWSER_PRIMARY_PROFILE_OBSERVED_MAX_BURST = 64;

/**
 * Per-domain entries one `primaryProfileForgetLedger` digest may carry. The
 * digest is a whole-ledger replacement rather than a delta, so the desktop
 * trims to this bound by first dropping the entries `forgetAllAt` already
 * covers (a domain forgotten before the last forget-all adds nothing to it)
 * and then the oldest remaining timestamps.
 *
 * That trim order has a cost worth naming: the oldest entries are exactly the
 * domains a long-disconnected host is most likely to still be holding, and a
 * trimmed digest is indistinguishable from a complete one on the wire - the
 * receiving host cannot tell that a forget it never heard about was dropped
 * on the way. The bound is set far above any real ledger so this stays
 * theoretical; if it ever starts biting, the fix is a bigger bound or a
 * lower-water compaction on the desktop, not a smarter host.
 */
export const BROWSER_FORGET_LEDGER_MAX_DOMAINS = 1_024;

/**
 * One headless-observed sign-in for a single registrable domain
 * (`registrable-domain.ts` derives it on both ends).
 *
 * Direction: host -> jar-authorized desktops. It is the first host->jar WRITE
 * direction the contract has ever had, so the desktop treats it as UNTRUSTED
 * input: it re-derives every cookie's registrable domain itself, drops the
 * frame when any cookie disagrees with `domain`, bounds it by
 * {@link BROWSER_PRIMARY_PROFILE_OBSERVED_MAX_COOKIES}, and applies what
 * survives through Chromium's own `cookies.set` validation.
 *
 * COOKIES ONLY - no `origins`/localStorage, and none may be added later
 * (universal-sign-in decision 1). localStorage has no per-key merge: the only
 * way to apply it is clear-and-reseed a whole origin, which is a second
 * implicit sign-out channel, and an unapplied `origins` array would just ship
 * every SPA's bearer tokens across the wire for nothing. localStorage
 * carry-over is future work, not a field this frame is missing.
 *
 * TRUST POSTURE - the absence of a removals field closes the EXPLICIT
 * sign-out channel, and that is all it closes. Do not read it as "this frame
 * cannot assert a logout": ONE IMPLICIT CHANNEL REMAINS. Chromium treats
 * setting an already-expired cookie as a DELETE of the matching one, and
 * `expires` here has no floor - the desktop's seed path passes any
 * non-negative value straight through to `cookies.set` as `expirationDate`.
 * So a cookie carrying `expires` at or before receive time is a removal
 * wearing a write's clothing.
 *
 * EXPIRED-COOKIE REJECTION (ticket 03, reason `expired-cookie`): the applier
 * MUST drop, per cookie, any cookie whose `expires >= 0 && expires <= now`
 * (seconds since epoch, the field's own unit; a NEGATIVE `expires` is the
 * session-cookie sentinel - the capture path writes `-1` - and is always
 * allowed through). The comparison is against RECEIVE time, so a parse-time
 * schema bound cannot decide it and this stays the applier's obligation. Drop
 * the cookie, not the frame: the rest of the observation is still a
 * legitimate sign-in.
 *
 * No contributor id: provenance is the sending host's identity on this
 * authenticated stream, which the desktop already knows and which a frame
 * field could only forge. No ordering field either, by design - there is no
 * sequence number, watermark or issue timestamp to compare, so protection
 * against a host replaying a stale contribution over a fresher jar is
 * entirely the REPLAY ORDERING's obligation (ticket 02), never a check the
 * applier can make from the frame's own contents.
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
 * The desktop's durable forget ledger, projected for ONE host: a set of
 * INSTRUCTIONS ("this site is gone", "everything before this was gone"), never
 * clock values for the receiver to reason about.
 *
 * Every timestamp on it comes from ONE clock - the authoring desktop's - and is
 * read only by that desktop. A host compares none of them: not against its own
 * clock, not against another desktop's ledger, and not against each other. It
 * clears what the digest names and answers with
 * `primaryProfileForgetLedgerAck`.
 *
 * WHAT `revision` IS FOR, and why this is not simply the whole ledger every
 * time (universal-sign-in ticket 04). The ledger is monotonic and never
 * shrinks, so re-asserting all of it on every push would re-clear a site the
 * user has since signed back into - on every later forget action, forever. The
 * desktop therefore records what each host has ACKED and sends only the
 * entries above it, while `revision` always carries the ledger's current top:
 * the ack means "pruned through here", not "pruned what was in that frame". A
 * host that missed a push, or never acked one, is simply sent those entries
 * again on the next push, so the digest stays idempotent and needs no
 * host-side watermark.
 *
 * `forgetAllAt` is null both when the user has never forgotten everything AND
 * when this host has already acked the revision that carried it - the two are
 * the same instruction-set fact, "no forget-all for you in this digest". It is
 * required and explicitly nullable rather than defaulted: the frame is new on
 * an unreleased contract, so no peer can omit it, and a default would quietly
 * absorb a producer bug into "nothing was ever forgotten" - the one wrong
 * direction for this field. `domains` is bounded by
 * {@link BROWSER_FORGET_LEDGER_MAX_DOMAINS}.
 */
export const browserForgetLedgerSchema = z
  .object({
    forgetAllAt: z.number().nullable(),
    domains: z.array(browserForgetLedgerDomainSchema),
    /**
     * The authoring desktop's monotonic forget counter, bumped by every
     * forget-all and every clear-site. Desktop-local and never compared across
     * machines: a host only ever echoes it back on the ack.
     *
     * Bounded at the SCHEMA, unlike the payload bounds above, and for the
     * opposite reason. Those bound volume, where a silent parse failure would
     * cost the receiver its `over-bound` trace. This is a COUNTER the far end
     * stores and compares: a fractional or negative one is not a big frame to
     * refuse loudly, it is a value that poisons a watermark, and there is
     * nothing a peer could usefully do with it but drop the frame.
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

// Reserved evolution room, not yet added:
// - A `downloadEvent` server frame for file downloads/uploads (deferred,
//   spec decision #12); the honest unsupported toast stays until then.
/**
 * The host's verdict on one `captureTabPreview`. Snapshot-only cross-host
 * context (spec decision #10): a still, a url and a title, never a drive
 * handle. `ok: false` is an ordinary answer carrying `reason` and nothing else
 * - notably a dormant tab, which is reported rather than woken.
 */
export const browserTabPreviewSchema = z
  .object({
    ok: z.boolean(),
    /** Base64 JPEG, capped host-side to the wire bound below. */
    screenshotBase64: z.string().max(2_097_152).nullable(),
    // Deliberately uncapped: a real `data:`/`blob:` url or a long title would
    // otherwise fail the whole frame's parse and the picker would just wait
    // out its timeout. Only the screenshot is bounded, and the host clamps
    // that at the producer.
    url: z.string().nullable(),
    title: z.string().nullable(),
    reason: z.string().nullable(),
  })
  .strict();
export type BrowserTabPreview = z.infer<typeof browserTabPreviewSchema>;

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
      kind: z.literal("tabPreviewResult"),
      ...requestFrameFields,
      ...browserTabPreviewSchema.shape,
    })
    .strict(),
  z
    .object({
      // Answers one `primaryProfileCaptured`: the host has DURABLY stored (or
      // rejected) that jar. The desktop's quit flush waits on this rather than
      // on a socket write completing.
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
      // A sign-in this host witnessed inside a headless session, offered to
      // the desktops that hold the master jar (universal-sign-in decisions
      // 1-5). Emitted from headless capture events only - never echoed back
      // from a desktop's own `primaryProfileDelta`, which is what terminates
      // the loop - and from primary-profile-backed sessions only, so ephemeral
      // ones stay isolated. Replayed for the host's headless-contributed
      // domains on every jar-authorized desktop attach, which is what lets the
      // path carry no watermark and no ack: the merge is idempotent, so
      // redundancy is free and a crash costs nothing. Sent to every
      // jar-authorized desktop of the user. No `userId`: the identity is the
      // stream's authenticated user.
      kind: z.literal("primaryProfileObserved"),
      ...textFrameFields,
      ...browserPrimaryProfileObservedSchema.shape,
    })
    .strict(),
  z
    .object({
      // This host has finished pruning everything the desktop's ledger named
      // through `revision` - the stored slice, the headless-contributed
      // markers, and the live headless contexts (universal-sign-in ticket 04).
      // Sent only to the desktop whose digest it answers.
      //
      // It is the HAPPENS-BEFORE the carry-over path has no clock for. A host
      // that has acked revision N pruned everything through N before it sent
      // this, so every `primaryProfileObserved` it emits afterwards is a
      // post-prune capture; one emitted before the prune is exactly the frame
      // whose connection has not acked yet, and the desktop drops it on that
      // fact rather than on an estimate of flight time. Until a connection's
      // first ack, every observation for a ledger-covered domain drops.
      //
      // `revision` is the desktop's own counter, echoed back verbatim. This
      // host neither mints nor compares it - it is an opaque token here, which
      // is what keeps two machines' clocks out of the ordering.
      //
      // Shaped like the ledger's own `revision` (integer, non-negative) so a
      // malformed one is refused at the parse rather than stored. The desktop
      // additionally CLAMPS what it accepts to its own current revision: an
      // ack is an echo, so a host cannot advance a watermark past what it was
      // told, and an inflated one would otherwise disable the desktop's
      // no-resurrection gate permanently.
      //
      // This arm replaced `primaryProfileForgotten`, whose one-shot fan-out the
      // ledger absorbed (decision 6). Do not reintroduce a second forget
      // channel.
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
      // The desktop window this renderer is, or null off Electron. The host
      // hands the Electron lifecycle over only to the incumbent owner's own
      // window: a SECOND window announcing readiness would otherwise rip the
      // first window's live native tabs onto a renderer that has no surface
      // for them. `.default(null)` so an older GUI's readiness frame still
      // parses on a `.strict()` variant.
      desktopWindowId: z.string().nullable().default(null),
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
      // user's slice and evicts it from its own live headless contexts. It
      // fans NOTHING back: the host->desktop removal frame was retired by
      // universal-sign-in ticket 08, which left the desktop's write channel
      // add-only. No `userId` - the identity is the stream's authenticated
      // user, and only the elected lifecycle subscriber is heard (same gate as
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
      // this user's key and slice. It fans NOTHING back - the desktop that
      // asked clears its own partition itself and records the forget in its
      // ledger, and the hosts that were not connected to hear this frame learn
      // it from that ledger instead (universal-sign-in decision 6). No `userId`
      // - the identity is the stream's authenticated user, and only the elected
      // lifecycle subscriber is heard (same gate as `primaryProfileCaptured`).
      kind: z.literal("forgetLogins"),
      ...textFrameFields,
    })
    .strict(),
  z
    .object({
      // The desktop's forget ledger (universal-sign-in decision 6), pushed on
      // every forget action and once at attach BEFORE any observed replay - so
      // a host can never re-offer, in the replay, a login the user forgot while
      // that host was disconnected. Answered with
      // `primaryProfileForgetLedgerAck` once the prune has finished, which is
      // what orders the desktop's applier against this host's observations;
      // re-sending it is always safe, because the prune is idempotent.
      // Supersedes the `primaryProfileForgotten` fan-out, which is gone. No
      // `userId` - the identity is the stream's authenticated user, and only
      // the elected lifecycle subscriber is heard (same gate as
      // `primaryProfileDelta`).
      kind: z.literal("primaryProfileForgetLedger"),
      ...textFrameFields,
      ...browserForgetLedgerSchema.shape,
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
    /**
     * Which host contributed this login, when it was a HEADLESS session on the
     * answering host rather than the user's own desktop jar (universal-sign-in
     * decision 9). `null` means "nothing to attribute": the desktop's own
     * browsing put it here, so there is no other machine to name.
     *
     * It is a `hostId` - the canonical host identity, which the GUI resolves to
     * a display name through the host directory - and the answering host stamps
     * its OWN id from its persisted identity. Nothing a client sends can name a
     * host here.
     *
     * `.default(null)` so a host that predates this field still parses, exactly
     * as the pre-epic slices it reads do.
     */
    contributedByHostId: z.string().nullable().default(null),
  })
  .strict();
export type BrowserSavedLoginSite = z.infer<typeof browserSavedLoginSiteSchema>;

/** No input: the slice read is the caller's own, from the request identity. */
export const browserSavedLoginSitesRequestSchema = z.object({}).strict();

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

/**
 * The subscription's control tier.
 *
 * A tile drives the tab; `"pip"` and `"viewer"` are read-only, routed to the
 * host's restricted client-frame handler, so an `arm` or an input frame from
 * either is refused and traced rather than dispatched. They differ only in
 * what else they cost the host - a `"pip"` mirrors a tile that is already
 * streaming and is never offered its own video round, while a `"viewer"` is a
 * first-class watcher of the tab (viewed state, its own WebRTC round) that
 * simply has no input rights.
 *
 * NOT AN AUTHORIZATION. The tier is declared by the client and the host
 * applies it verbatim: a modified client sends `"tile"` and drives. Nothing
 * here can be made unforgeable - `transportVantage` is a placement fact (a
 * desktop GUI on a remote host is relay too) and `clientKind` is client text.
 * Input by tier was never the boundary: a client authenticated as this user
 * already drives the tab through the browser MCP and agent RPCs. User
 * authentication is the boundary; this field bounds a cooperating client and
 * denies nothing.
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
const browserScreencastBatchedIceCandidateSchema = z
  .object(browserScreencastIceCandidateBaseFields)
  .strict();
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
    urls: z.array(z.string().max(2_048)).max(16),
    username: z.string().nullable(),
    credential: z.string().nullable(),
  })
  .strict();
export type BrowserScreencastIceServer = z.infer<
  typeof browserScreencastIceServerSchema
>;

/**
 * The STUN-only fallback both ends use when no TURN set was minted - a public
 * server, so it is a literal rather than configuration. One constant because
 * host and viewer must fall back to the SAME server or they gather against
 * different pools.
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

/**
 * Why a viewer gave up on a video-plane round. Closed, because the host reads
 * these to decide whether to turn the JPEG pump back on and traces them as a
 * fixed vocabulary; anything variable rides `videoPlaneState.detail`.
 */
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
      // Answer to every `ping` on this contract, whichever transport carried
      // it. There is no plain `pong` arm: the stream transport answers a mux
      // `ping` itself, before any resolver sees the frame, and client-side it
      // delivers a pong upward only for an application `ping` it queued - so a
      // `pong` from here could never reach the sender. Carries no correlation
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
      reason: browserVideoPlaneFailureReasonSchema.nullable(),
      // Free-form context for the one code that has any (`answer-failed`
      // carries the SDP error's text). Never parsed - it exists so the closed
      // vocabulary above does not cost the host its diagnostics.
      // `.default(null)` so an older client's frame still parses.
      detail: z.string().max(256).nullable().default(null),
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
      // the DataChannel, back over the mux as `inputPong`. Deliberately
      // asymmetric -
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
