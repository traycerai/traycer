/**
 * `browser.sessions@1.0` and `browser.screencast@1.0` - the browser stream
 * contracts exactly as the v1.3.0 release (`release-v1.3.0`) shipped them.
 * FROZEN: nothing in this file may change.
 *
 * A peer on that release parses these shapes with `.strict()` schemas and
 * drops any frame that fails, so one field added on this line blanks every
 * tile in a released GUI. The live line is `contracts.ts` (`@2.0`), which is
 * what this file was until the release cut. The two diverge on:
 *
 * - the open requests address the stream by `epicId`; the live line takes a
 *   `scope` - an epic, or the device's epic-less `independent` inventory;
 * - `BrowserSessionInfo.epicId` rather than `scope`, and no
 *   `BrowserTabInfo.boundWindowId`;
 * - `tabOpened` carries no `openerTabId`, `openTabResult` no `handoffToken`,
 *   and the screencast open presents none;
 * - no `attachTab` / `moveTab` client frames, and no `desktopWindowId` on
 *   `electronTabLifecycleReady`.
 *
 * The host serves this line by projecting its live frames down to these
 * shapes and the client serves it by lifting them up; each side's bridge
 * names this file. It stays served for as long as a v1.3.0 peer can dial.
 *
 * A hand copy rather than a derivation from the live schemas, for the reason
 * every frozen file in this package gives: a shared sub-schema that grows
 * moves every line composed from it, and a frozen line's whole job is to stop
 * moving. The one live import is `cdp-contracts`: the curated CDP vocabulary
 * is its own additive surface, released with this line, and a command a
 * v1.3.0 peer never learned is withheld at emission rather than here.
 */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  browserCdpCommandSchema,
  browserCdpResultSchema,
  browserCdpTargetSchema,
} from "@traycer/protocol/host/browser/cdp-contracts";

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

const browserSessionClosedReasonSchema = z.enum([
  "completed",
  "idle-ttl",
  "evicted",
  "crashed",
]);

/** Profile controls credential sharing, not logical session identity. */
const browserSessionProfileKindSchema = z.enum(["primary", "isolated"]);

/** Attribution for one in-flight tab action; this grants no lock or lease. */
const browserTabDriverSchema = z
  .object({
    chatId: z.string(),
    agentRunId: z.string().nullable(),
    requestId: z.string(),
  })
  .strict();

/** One page, addressed by a durable host-minted id rather than a CDP id. */
export const browserTabInfoSchemaV10 = z
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
export type BrowserTabInfoV10 = z.infer<typeof browserTabInfoSchemaV10>;

/** An epic-scoped group of tabs sharing one browser profile. */
export const browserSessionInfoSchemaV10 = z
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
    tabs: z.array(browserTabInfoSchemaV10),
  })
  .strict();
export type BrowserSessionInfoV10 = z.infer<typeof browserSessionInfoSchemaV10>;

/** One tab addressed through its owning session. */
const browserTabIdentitySchema = z
  .object({
    sessionId: z.string(),
    tabId: z.string(),
  })
  .strict();

/** `epicId` is the stream's sole authorization and routing scope. */
export const browserSessionsOpenRequestSchemaV10 = z
  .object({
    epicId: z.string(),
  })
  .strict();
export type BrowserSessionsOpenRequestV10 = z.infer<
  typeof browserSessionsOpenRequestSchemaV10
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
const browserStorageCookieSchema = z.object({
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

const browserStorageLocalStorageEntrySchema = z
  .object({
    name: z.string(),
    value: z.string(),
  })
  .strict();

const browserStorageOriginSchema = z
  .object({
    origin: z.string(),
    localStorage: z.array(browserStorageLocalStorageEntrySchema),
  })
  .strict();

const browserStorageStateSchema = z
  .object({
    cookies: z.array(browserStorageCookieSchema),
    origins: z.array(browserStorageOriginSchema),
  })
  .strict();

/** Unpartitioned cookie identity: exactly what a tombstone is keyed by. */
const browserCookieKeySchema = z
  .object({
    domain: z.string(),
    name: z.string(),
    path: z.string(),
  })
  .strict();

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
const browserPrimaryProfileDeltaSchema = z
  .object({
    domain: z.string(),
    cookies: z.array(browserStorageCookieSchema),
    removedKeys: z.array(browserCookieKeySchema),
    /** When the window opened, from the sender's clock. */
    issuedAt: z.number(),
  })
  .strict();

/*
 * Wire bounds for the carry-over path. Both ends import these, so the
 * producer clamps against exactly the number the receiver enforces.
 *
 * They are exported constants rather than `.max()` on the schemas below, and
 * that is deliberate. A schema bound turns an over-bound frame into a silent
 * parse failure inside the stream transport: the receiver never sees the
 * frame, so it can neither WARN (keyed by `instance=`) nor emit the
 * `over-bound` reject trace these paths are diagnosed by, and these bugs were
 * found by trace forensics. The receiver counts and rejects instead.
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
const BROWSER_PRIMARY_PROFILE_OBSERVED_MAX_COOKIES = 512;

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
const BROWSER_FORGET_LEDGER_MAX_DOMAINS = 1_024;

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
 * COOKIES ONLY - no `origins`/localStorage, and none may be added later.
 * localStorage has no per-key merge: the only
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
 * EXPIRED-COOKIE REJECTION (reason `expired-cookie`): the applier
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
 * entirely the REPLAY ORDERING's obligation, never a check the applier can
 * make from the frame's own contents.
 */
const browserPrimaryProfileObservedSchema = z
  .object({
    domain: z.string(),
    /** Every cookie the domain's subtree holds after the capture, not a delta. */
    cookies: z.array(browserStorageCookieSchema),
  })
  .strict();

/** One site the user forgot, stamped by the forgetting desktop's own clock. */
const browserForgetLedgerDomainSchema = z
  .object({
    /** Registrable domain (eTLD+1) - never a cookie name, never a value. */
    domain: z.string(),
    forgottenAt: z.number(),
  })
  .strict();

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
 * time. The ledger is monotonic and never
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
const browserForgetLedgerSchema = z
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

const electronTabCreateReasonSchema = z.enum([
  "session-bootstrap",
  "agent-open",
  "restore",
]);

const electronTabCreateFailureCodeSchema = z.enum([
  "identity_violation",
  "native_unavailable",
  "native_create_failed",
]);

// Reserved evolution room, not yet added:
// - A `downloadEvent` server frame for file downloads/uploads (deferred); the
//   honest unsupported toast stays until then.
/**
 * The host's verdict on one `captureTabPreview`. Snapshot-only cross-host
 * context: a still, a url and a title, never a drive
 * handle. `ok: false` is an ordinary answer carrying `reason` and nothing else
 * - notably a dormant tab, which is reported rather than woken.
 */
const browserTabPreviewSchema = z
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

/** Who opened the tab: the agent driving the session, or the page itself. */
const browserTabOpenedSourceSchema = z.enum(["agent", "page"]);

export const browserSessionsServerFrameSchemaV10 = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        kind: z.literal("snapshot"),
        ...textFrameFields,
        sessions: z.array(browserSessionInfoSchemaV10),
      })
      .strict(),
    z
      .object({
        kind: z.literal("sessionCreated"),
        ...textFrameFields,
        session: browserSessionInfoSchemaV10,
      })
      .strict(),
    z
      .object({
        kind: z.literal("sessionUpdated"),
        ...textFrameFields,
        session: browserSessionInfoSchemaV10,
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
        // A STANDING request: capture nothing now, keep this `requestId`, and
        // use it on the one capture the host
        // cannot ask for - the flush the desktop pushes as it quits. Every
        // `primaryProfileCaptured` the host stores is thereby solicited: the
        // ordinary answer matches the outstanding request, the quit flush matches
        // the standing one, and anything else is acked and dropped. Issued once
        // per connection, at the point the host both knows the desktop holds the
        // master jar and can read the slice it speaks for.
        standing: z.boolean().default(false),
      })
      .strict(),
    z
      .object({
        // Store-key handshake. The host mints the per-user store key and asks
        // a JAR-AUTHORIZED desktop (one whose
        // `desktopIdentityAttest` this host enrolled) to wrap it with that
        // machine's OS keystore; the host keeps the raw bytes in memory only.
        kind: z.literal("storeKeyWrapRequest"),
        ...requestFrameFields,
        // A store key is 32 bytes and a wrapped blob a few hundred; the cap is
        // slack, not a size contract, and it exists so neither side can be made
        // to buffer or `safeStorage`-process an unbounded string.
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
        // "Prove you are a desktop this host hands the cookie jar to". Issued
        // once per connection, on receipt of `electronTabLifecycleReady`. The
        // nonce is 32 random bytes the host
        // holds on the challenged subscriber and deletes on the first answer, so
        // a captured signature replays onto nothing and a second connection's
        // answer never settles this one.
        kind: z.literal("desktopIdentityChallenge"),
        ...requestFrameFields,
        nonce: z.base64().max(64),
      })
      .strict(),
    z
      .object({
        // A sign-in this host witnessed inside a headless session, offered to
        // the desktops that hold the master jar. Emitted from headless capture
        // events only - never echoed back
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
        // markers, and the live headless contexts. Sent only to the desktop
        // whose digest it answers.
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
        // ledger absorbed. Do not reintroduce a second forget channel.
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
  ],
);
export type BrowserSessionsServerFrameV10 = z.infer<
  typeof browserSessionsServerFrameSchemaV10
>;

export const browserSessionsClientFrameSchemaV10 = z.discriminatedUnion(
  "kind",
  [
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
        // that can never drive it. No `sessionId`: the tab
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
        // subscriber whose declared id differs as Electron lifecycle owner:
        // Electron placement is a same-machine optimization, and this field is
        // the sole locality signal it is gated on.
        coLocatedHostId: z.string().nullable(),
        // There was a `desktopWindowId` here. It is gone: the host's last
        // reader was retired (lifecycle hand-over now happens only through
        // `detachBrowserSessionsSubscriber`), and with the jar plane in the
        // desktop's main process the window a stream belongs to is a fact that
        // process already holds - it never needed to travel.
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
        // The answer to a `capturePrimaryProfile` this host issued. No `userId`
        // - the identity is the stream's authenticated user; the frame is
        // matched to an in-flight (or standing) request BY `requestId` AND
        // subscriber id, so it is heard only from the connection that was
        // asked. Lifecycle election gates nothing here.
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
        // `userId` - the identity is the stream's authenticated user, and the
        // host hears the frame only from a JAR-AUTHORIZED subscriber: one that
        // answered `desktopIdentityChallenge` with a signature this host has
        // enrolled (browser-security-hardening H09). Lifecycle election is a
        // different question and gates nothing here.
        kind: z.literal("primaryProfileDelta"),
        ...textFrameFields,
        ...browserPrimaryProfileDeltaSchema.shape,
      })
      .strict(),
    z
      .object({
        // The desktop's answer to `desktopIdentityChallenge`
        // (browser-security-hardening H09): an Ed25519 signature over
        // {@link canonicalDesktopIdentityAttestBytes}, made in the desktop's
        // MAIN process with a key `safeStorage` holds. It is the whole basis of
        // jar authorization - it replaced the `storeKeyOffer` frame, which was a
        // declaration with nothing behind it. No `userId`: the identity is the
        // stream's authenticated user, and the signed bytes commit to the hostId
        // instead, so a signature cannot be relayed into another host's
        // challenge.
        kind: z.literal("desktopIdentityAttest"),
        // Echoes the challenge's `requestId`.
        ...requestFrameFields,
        // Ed25519 SPKI DER.
        publicKey: z.base64().max(128),
        // Which keystore on this machine holds the private half. A slot label
        // only - it is deliberately OUTSIDE the signature, because it is used
        // only to replace an entry during a `local-ws` enrollment, and that lane
        // already requires a socket on the host's own machine.
        keystoreId: z.string().max(64),
        signature: z.base64().max(128),
        // Whether this desktop's keystore can actually hold the host's store
        // key. A machine whose OS keystore cannot encrypt (Linux with no secret
        // service) still mints a durable keypair and attests, so it keeps native
        // tab placement, and declares `false` so the host never hands it a jar it
        // could not protect. Client-declared, and safe as one: it can only
        // downgrade the declarer. REQUIRED rather than defaulted - a desktop
        // that does not answer it is one whose keystore story this host has no
        // reason to guess at.
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
        // `safeStorage.decryptString(wrappedKey)`. `null` means this desktop
        // cannot open the blob (keystore item ACL changed, different machine);
        // the host then stays sealed and never re-mints over a live blob.
        kind: z.literal("storeKeyUnwrapped"),
        ...requestFrameFields,
        rawKey: z.base64().max(4096).nullable(),
      })
      .strict(),
    z
      .object({
        // "Clear" on one row of Settings > Browser > Sites with saved logins.
        // Unsolicited and unacknowledged: the host tombstones that registrable
        // domain in the user's slice and evicts it from its own live headless
        // contexts. It fans NOTHING back: the host->desktop removal frame was
        // retired, which left the desktop's write channel add-only. No
        // `userId` - the identity is the stream's authenticated
        // user, and the host hears the frame only from a JAR-AUTHORIZED
        // subscriber - see `primaryProfileDelta`. Lifecycle election gates
        // nothing here.
        kind: z.literal("clearSite"),
        ...textFrameFields,
        domain: z.string(),
      })
      .strict(),
    z
      .object({
        // "Forget all browser logins". Unsolicited and unacknowledged: the host
        // answers by shredding this user's key and slice. It fans NOTHING back
        // - the desktop that asked clears its own partition itself and records
        // the forget in its ledger, and the hosts that were not connected to
        // hear this frame learn it from that ledger instead. No `userId`
        // - the identity is the stream's authenticated user, and the host hears
        // the frame only from a JAR-AUTHORIZED subscriber - see
        // `primaryProfileDelta`. Lifecycle election gates nothing here.
        kind: z.literal("forgetLogins"),
        ...textFrameFields,
      })
      .strict(),
    z
      .object({
        // The desktop's forget ledger, pushed on every forget action and once
        // at attach BEFORE any observed replay - so
        // a host can never re-offer, in the replay, a login the user forgot while
        // that host was disconnected. Answered with
        // `primaryProfileForgetLedgerAck` once the prune has finished, which is
        // what orders the desktop's applier against this host's observations;
        // re-sending it is always safe, because the prune is idempotent.
        // Supersedes the `primaryProfileForgotten` fan-out, which is gone. No
        // `userId` - the identity is the stream's authenticated user, and the
        // host hears the frame only from a JAR-AUTHORIZED subscriber - see
        // `primaryProfileDelta`. Lifecycle election gates nothing here.
        kind: z.literal("primaryProfileForgetLedger"),
        ...textFrameFields,
        ...browserForgetLedgerSchema.shape,
      })
      .strict(),
  ],
);
export type BrowserSessionsClientFrameV10 = z.infer<
  typeof browserSessionsClientFrameSchemaV10
>;

export const browserSessionsV10 = defineStreamRpcContract({
  method: "browser.sessions",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: browserSessionsOpenRequestSchemaV10,
  serverFrameSchema: browserSessionsServerFrameSchemaV10,
  clientFrameSchema: browserSessionsClientFrameSchemaV10,
});

const browserScreencastFormatSchema = z.enum(["jpeg"]);

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

/** Epic-authorized, tab-addressed screencast subscription. */
export const browserScreencastOpenRequestSchemaV10 = z
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
export type BrowserScreencastOpenRequestV10 = z.infer<
  typeof browserScreencastOpenRequestSchemaV10
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

const browserScreencastUnsupportedFeatureSchema = z.enum([
  "fileUpload",
  "download",
]);

/** ICE candidate-pair types telemetry may report - a closed vocabulary. */
const browserScreencastIcePairTypeSchema = z.enum([
  "host",
  "srflx",
  "prflx",
  "relay",
  "unknown",
]);

/** Full navigation snapshot every time; consumers never reconstruct deltas. */
const browserNavStateSchema = z
  .object({
    url: z.string(),
    canGoBack: z.boolean(),
    canGoForward: z.boolean(),
    loading: z.boolean(),
  })
  .strict();

/**
 * WebRTC video-plane signaling, ridden on `browser.screencast@1.0` as new
 * frame kinds: no third stream method, no minor bump - the contract is
 * pre-release.
 *
 * The host's capture helper page is the offerer: it owns the
 * `RTCPeerConnection` and only creates it once `getDisplayMedia` has a live
 * track, so it - not the client - knows when negotiation can start. The
 * client is therefore always the answerer. `negotiationId` correlates one
 * offer/answer/candidate round; a fallback-and-retry starts a new one, so
 * late candidates from an abandoned round are ignored rather than
 * mis-applied to the next attempt.
 */
/**
 * The candidate fields shared by the per-candidate `iceCandidate` trickle
 * frame and the batch riding `sdpAnswer.candidates` - everything but
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

/** One candidate as it rides `sdpAnswer.candidates`. */
const browserScreencastBatchedIceCandidateSchema = z
  .object(browserScreencastIceCandidateBaseFields)
  .strict();

/**
 * One ICE server the client should configure its `RTCPeerConnection` with,
 * mirroring the browser's `RTCIceServer`. The host mints these (short-TTL
 * TURN credentials) and stamps them on the offer, so both ends of a round
 * negotiate against the SAME set. Additive with a `[]` default: an older host
 * sends nothing and the client keeps its STUN-only fallback.
 */
const browserScreencastIceServerSchema = z
  .object({
    urls: z.array(z.string().max(2_048)).max(16),
    username: z.string().nullable(),
    credential: z.string().nullable(),
  })
  .strict();

const browserScreencastAgentCursorTypeSchema = z.enum(["move", "down", "up"]);

const browserScreencastCaptureModeSchema = z.enum(["jpeg", "video"]);

/**
 * Why a viewer gave up on a video-plane round. Closed, because the host reads
 * these to decide whether to turn the JPEG pump back on and traces them as a
 * fixed vocabulary; anything variable rides `videoPlaneState.detail`.
 */
const browserVideoPlaneFailureReasonSchema = z.enum([
  "no-first-frame",
  "frames-stopped",
  "track-ended",
  "connection-closed",
  "connection-failed",
  "answer-failed",
]);

export const browserScreencastServerFrameSchemaV10 = z.discriminatedUnion(
  "kind",
  [
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
        // Control-plane RTT probe. Its own frame pair rather than
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
        // How far the host has consumed this arm epoch's input sequence. Sent
        // only for input that arrived over the MUX, coalesced, so it exists
        // exactly during the window where the client is waiting to
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
  ],
);
export type BrowserScreencastServerFrameV10 = z.infer<
  typeof browserScreencastServerFrameSchemaV10
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

const browserScreencastPointerButtonSchema = z.enum([
  "none",
  "left",
  "middle",
  "right",
  "back",
  "forward",
]);

const browserScreencastKeyboardTypeSchema = z.enum([
  "rawKeyDown",
  "keyUp",
  "char",
]);

export const browserScreencastClientFrameSchemaV10 = z.discriminatedUnion(
  "kind",
  [
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
        // A speculative claim raised on hover, so the host has the
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
        // Local candidates gathered before the answer shipped, batched here
        // instead of one `iceCandidate` frame each. `.default([])` - additive,
        // and `browser.screencast` is not in the released baseline - so an
        // older client that sends none still parses.
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
        // consumes this raw (semantics beyond the shape are out of scope here).
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
        // difference between a path problem and a client problem. Additive:
        // `.default(null)` so an older client's frame still parses.
        glassToGlassP95Ms: z.number().nonnegative().nullable().default(null),
        networkPlusJitterMs: z.number().nonnegative().nullable().default(null),
        decodeCompositeMs: z.number().nonnegative().nullable().default(null),
        // Round trip of one `ping` sent on the `input-reliable` DataChannel: up
        // the DataChannel, back over the mux as `inputPong`. Deliberately
        // asymmetric - that IS the human input path's shape, and the uplink
        // half is the leg deadlines are derived from. Null until a ping has
        // completed.
        dataChannelRttMs: z.number().nonnegative().nullable().default(null),
        // getStats() candidate-pair `candidateType` of the active receive
        // path (only observable receiver-side) - the "ICE path taken" metric.
        // Closed vocabulary: telemetry carries no free text.
        iceCandidatePairType:
          browserScreencastIcePairTypeSchema.catch("unknown"),
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
  ],
);
export type BrowserScreencastClientFrameV10 = z.infer<
  typeof browserScreencastClientFrameSchemaV10
>;

export const browserScreencastV10 = defineStreamRpcContract({
  method: "browser.screencast",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: browserScreencastOpenRequestSchemaV10,
  serverFrameSchema: browserScreencastServerFrameSchemaV10,
  clientFrameSchema: browserScreencastClientFrameSchemaV10,
});
