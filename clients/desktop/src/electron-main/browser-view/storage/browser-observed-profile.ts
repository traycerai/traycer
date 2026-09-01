import {
  BROWSER_PRIMARY_PROFILE_OBSERVED_MAX_BURST,
  BROWSER_PRIMARY_PROFILE_OBSERVED_MAX_COOKIES,
  type BrowserCookieKey,
  type BrowserStorageCookie,
} from "@traycer/protocol/host/browser/contracts";
import { registrableDomain } from "@traycer/protocol/host/browser/registrable-domain";
import { log, sanitizeLogFields } from "../../app/logger";
import {
  browserJarCookieKeys,
  cookieKeyId,
  mergeObservedProfileCookies,
  type BrowserObservedCookieMergeResult,
  type BrowserStorageSession,
} from "./browser-storage-state";

/**
 * The desktop's enforcement of `primaryProfileObserved` (universal-sign-in
 * ticket 03): the first host->jar WRITE direction the contract has, applied to
 * the user's master jar and therefore treated as untrusted input from end to
 * end.
 *
 * Nothing here believes the frame. The registrable domain of every cookie is
 * re-derived locally and checked against the domain the frame claims; a cookie
 * NAME the desktop's own browsing owns in that domain is refused outright,
 * which is what keeps this an ADD-ONLY channel; the volume and the rate are bounded; a site the
 * user forgot is refused until the sending connection has acked pruning it;
 * and what survives goes through Chromium's own `cookies.set`, which is what
 * normalises the attributes away from anything the sender chose.
 *
 * The sending host's identity is NOT read from the frame - it comes from the
 * connection that delivered it (provenance-not-shape), which is also what the
 * per-connection budget and the trace tallies are keyed by.
 */

/** Every reason one observed frame's fate is traced under. */
export type BrowserObservedProfileReason =
  | "applied"
  | "domain-mismatch"
  | "expired-cookie"
  | "over-bound"
  | "rate-limited"
  /**
   * The jar already holds a cookie of this NAME in this registrable domain and
   * no observation put it there, so the desktop's own browsing did (browser
   * security review, root cause D).
   *
   * This is the rule that turns a replace-by-key write channel back into an
   * add-only one. Chromium replaces a cookie by (name, domain, path), so any
   * write to a live key is a destructive write dressed as a merge - but the
   * ownership unit is deliberately COARSER than that triple, because the
   * request the browser sends is coarser too. RFC 6265 orders the `Cookie`
   * header longest-path-first and mainstream servers read the first occurrence
   * of a name, so a host-added `sid` on `/app` beside the desktop's `sid` on
   * `/` IS the session for the user's real requests: an overwrite performed
   * under another key. A `.example.com` form beside a host-only `example.com`
   * one is the same trick by domain. So the test is (name, registrable
   * domain), and it closes the two-second expiry, the junk value, the path
   * shadow, the domain shadow, the forged `__Host-` prefix and the stale
   * replay together, with no clock and no epoch on the wire.
   */
  | "owned-by-desktop"
  /**
   * The user forgot this site, and the connection that sent the observation
   * has not yet acked the ledger revision that says so (universal-sign-in
   * ticket 04). It is the no-resurrection gate, and it replaced the
   * point-in-time `suppressed` check: a clear now bumps the revision before it
   * touches the jar, so every window that check covered is covered by this one
   * - and this one also covers the case a local check never could, an
   * observation captured on a remote host BEFORE it heard about the forget.
   */
  | "ledger-unacked";

/**
 * The frame-level verdict. `expired-cookie` and `owned-by-desktop` are missing
 * on purpose: both are per-cookie and neither costs the frame the rest of the
 * sign-in it belongs to - a real sign-in that refreshes one cookie the desktop
 * owns still carries the others.
 */
export type BrowserObservedProfileOutcome = Exclude<
  BrowserObservedProfileReason,
  "expired-cookie" | "owned-by-desktop"
>;

/**
 * One observation, as the desktop main process receives it.
 *
 * `connectionId` and `hostId` are the renderer's account of WHICH host stream
 * delivered the frame; neither is a field of the frame itself. `connectionId`
 * changes on every reconnect because a reconnect is what makes the host replay
 * its whole contributed set again, and that replay is what the burst is sized
 * for.
 */
export interface BrowserObservedProfile {
  readonly connectionId: string;
  readonly hostId: string;
  readonly domain: string;
  readonly cookies: readonly BrowserStorageCookie[];
}

export interface BrowserObservedProfileResult {
  /**
   * The frame's claimed domain collapsed to its registrable form - or, when it
   * does not collapse at all, the raw string the sender chose. The trace is
   * what reads this, and the trace is what sanitises it.
   */
  readonly domain: string;
  readonly outcome: BrowserObservedProfileOutcome;
  readonly appliedCookies: number;
  readonly domainMismatchCookies: number;
  readonly expiredCookies: number;
  /** Live keys this sender is not allowed to write over. */
  readonly ownedByDesktopCookies: number;
  /** Cookies the jar itself would not take; counted, never fatal to the frame. */
  readonly rejectedCookies: number;
}

/** What the trace needs about the connection a result came off. */
export interface BrowserObservedProfileTraceContext {
  readonly hostId: string;
  readonly connectionId: string;
  readonly governor: BrowserObservedConnectionGovernor;
}

/** The jar one observation is applied to, and what kind of jar it is. */
export interface BrowserObservedProfileTarget {
  readonly session: BrowserStorageSession;
  /**
   * True only for `BROWSER_VIEW_PARTITION`. False means saved logins are off
   * on this machine and the write is going to the in-memory jar, so no custody
   * claim is taken at all: a durable mark describes the durable jar, and one
   * recorded for a cookie that dies at quit would still be there - as a
   * standing update right over the user's own login - the day they turn saved
   * logins back on.
   *
   * The cost is stated and accepted: in that mode a host may ADD to the
   * ephemeral jar but not update what it added, because nothing recorded that
   * it did. The sign-in still reaches the user's live tiles, which is the
   * point of applying at all.
   */
  readonly durableJar: boolean;
}

export interface BrowserObservedProfileDependencies {
  readonly now: () => number;
  /**
   * Has the user forgotten this site at a ledger revision the sending
   * connection has not yet acked pruning? See `browser-forget-ledger.ts`.
   */
  readonly isForgottenPendingAck: (input: {
    readonly connectionId: string;
    readonly domain: string;
  }) => boolean;
  /**
   * Did an observation put this key in the jar? See
   * `isHeadlessOriginCookieKey` in `browser-forget-ledger.ts`, which is where
   * the durable set lives.
   */
  readonly isHeadlessOriginKey: (keyId: string) => boolean;
  /**
   * These keys are about to be written by this applier: they become the
   * contributing host's to update, and the desktop's own cookie observer is
   * told not to read their insert events as local writes.
   *
   * Awaited before the merge, deliberately. Both halves must be in place
   * before the first `cookies.set` fires, or the observer sees an insert it
   * cannot attribute and hands the key straight back.
   *
   * Called only for a write bound for the DURABLE jar - see
   * {@link BrowserObservedProfileTarget.durableJar}.
   */
  readonly claimHeadlessOriginKeys: (
    keys: readonly BrowserCookieKey[],
  ) => Promise<void>;
  /**
   * The jar refused these keys, so the claim taken over them is worthless and
   * has to go back: the desktop owns them again, and the user's own next
   * sign-in write must be seen as the local write it is.
   */
  readonly releaseHeadlessOriginKeys: (
    keys: readonly BrowserCookieKey[],
  ) => Promise<void>;
  /**
   * The `primary` jar guests are on right now - the one an observation merges
   * into - together with whether it is the durable one. Resolved once, inside
   * the serialized section, so the ownership test, the merge and the custody
   * record all speak about the same jar.
   */
  readonly getTargetJar: () => BrowserObservedProfileTarget;
  /** Runs the merge with no competing jar work for the same site. */
  readonly serializeOnDomain: <T>(
    domain: string,
    action: () => Promise<T>,
  ) => Promise<T>;
  readonly governor: BrowserObservedConnectionGovernor;
}

/**
 * Sustained admission once the burst is spent: one frame per second per host
 * connection.
 *
 * The burst is the number that matters and it is not chosen here - see
 * {@link BROWSER_PRIMARY_PROFILE_OBSERVED_MAX_BURST}. This only decides how
 * fast a host that has already spent its replay may keep writing, and a live
 * sign-in produces a frame or two, not a stream.
 */
const OBSERVED_FRAME_REFILL_INTERVAL_MS = 1_000;

interface ObservedRejectionTally {
  count: number;
  nextSample: number;
}

interface ObservedConnectionState {
  tokens: number;
  refilledAt: number;
  readonly rejections: Map<
    BrowserObservedProfileReason,
    ObservedRejectionTally
  >;
}

/**
 * Per-host-CONNECTION admission: the token bucket that paces incoming frames,
 * and the tallies that keep their rejection traces from becoming the flood they
 * describe.
 *
 * Keyed per connection rather than per host, because the host paces one attach
 * replay per jar-authorized subscriber and a desktop with several epics open is
 * several subscribers - so it receives one full replay down each stream. A
 * per-host bucket would let those interleaved replays exhaust one budget
 * between them and truncate every one of them, which is the silent "still
 * signed out on the machine that asked for the replay" failure
 * {@link BROWSER_PRIMARY_PROFILE_OBSERVED_MAX_BURST} exists to prevent.
 *
 * A reconnect therefore mints a new key and starts on a fresh budget, BY
 * DESIGN: a replay is per attach, so the budget for one is too. That is not a
 * hole to be re-keyed away, because this is a VOLUME GOVERNOR and not the
 * security boundary - the boundary is the validation every frame passes
 * regardless of budget (domain re-derivation, expiry, per-frame bound,
 * Chromium's own `cookies.set`). A host cycling reconnects to buy budget pays a
 * full stream re-handshake per cycle, still cannot write a cookie that fails
 * validation, and runs into Chromium's own per-host cookie caps, which is what
 * bounds the blast radius of unlimited VALID writes.
 */
export class BrowserObservedConnectionGovernor {
  private readonly connections = new Map<string, ObservedConnectionState>();

  constructor(private readonly now: () => number) {}

  /** Spends one frame's worth of budget, or answers false when there is none. */
  admit(connectionId: string): boolean {
    const now = this.now();
    this.pruneIdleConnections(now);
    const state = this.stateFor(connectionId, now);
    state.tokens = refill(state, now);
    state.refilledAt = now;
    if (state.tokens < 1) return false;
    state.tokens -= 1;
    return true;
  }

  /**
   * The running count of this rejection on this connection when the occurrence
   * is one worth writing down, and `null` when it is not.
   *
   * Rejections arrive at wire rate and carry a sender-chosen domain, so a line
   * each is both a log flood and an amplifier for one. Samples are taken at
   * exponentially growing counts - the 1st, 10th, 100th, ... - which keeps the
   * first occurrence (the one that says it started) and the magnitude (the one
   * that says it is still going) while the volume grows logarithmically.
   * Count-based rather than time-based on purpose: a timer would make what gets
   * written depend on how fast the sender sends.
   */
  sampleRejection(
    connectionId: string,
    reason: BrowserObservedProfileReason,
  ): number | null {
    const state = this.stateFor(connectionId, this.now());
    const tally = state.rejections.get(reason) ?? { count: 0, nextSample: 1 };
    tally.count += 1;
    state.rejections.set(reason, tally);
    if (tally.count < tally.nextSample) return null;
    tally.nextSample *= 10;
    return tally.count;
  }

  private stateFor(connectionId: string, now: number): ObservedConnectionState {
    const existing = this.connections.get(connectionId);
    if (existing !== undefined) return existing;
    const created: ObservedConnectionState = {
      tokens: BROWSER_PRIMARY_PROFILE_OBSERVED_MAX_BURST,
      refilledAt: now,
      rejections: new Map<
        BrowserObservedProfileReason,
        ObservedRejectionTally
      >(),
    };
    this.connections.set(connectionId, created);
    return created;
  }

  /**
   * Connections whose bucket has fully refilled hold no budget state, so they
   * are dropped rather than kept for every stream incarnation this run ever
   * had. Their rejection tallies go with them, which is the right lifetime: a
   * connection quiet long enough to refill starts its next flood's trace at 1.
   */
  private pruneIdleConnections(now: number): void {
    for (const [connectionId, state] of [...this.connections]) {
      if (refill(state, now) >= BROWSER_PRIMARY_PROFILE_OBSERVED_MAX_BURST)
        this.connections.delete(connectionId);
    }
  }
}

function refill(state: ObservedConnectionState, now: number): number {
  return Math.min(
    BROWSER_PRIMARY_PROFILE_OBSERVED_MAX_BURST,
    state.tokens +
      Math.max(0, now - state.refilledAt) / OBSERVED_FRAME_REFILL_INTERVAL_MS,
  );
}

/**
 * Validates one observation and merges what survives into the `primary` jar.
 *
 * The checks run outermost-first, and the order is what the traced reason
 * reports when a frame trips more than one. The RATE comes first because it is
 * the governor that bounds every cost below it: the work, the serial queue this
 * frame is about to join, and the tally its own rejection would otherwise grow.
 * Then the claimed domain, then the per-frame bound, and only then the queue.
 *
 * The forget-ledger gate sits INSIDE the serialized section, where it is an
 * ordering fact rather than a guess: every local clear bumps the ledger
 * revision before it queues, so a clear of this site can neither begin nor end
 * between the check and the merge it authorises without that merge seeing the
 * bump. It replaced ticket 03's point-in-time clear-in-progress read, which it
 * strictly subsumes - that read only covered the two suppressed clear paths
 * (the host-driven evict and forget-all) and never the tile/settings clear,
 * which runs unsuppressed by design, while every one of the three bumps the
 * revision.
 */
export async function applyBrowserObservedProfile(
  observed: BrowserObservedProfile,
  dependencies: BrowserObservedProfileDependencies,
): Promise<BrowserObservedProfileResult> {
  if (!dependencies.governor.admit(observed.connectionId)) {
    return dropped(observed.domain, "rate-limited");
  }
  const scope = registrableDomain(observed.domain);
  if (scope === null) return dropped(observed.domain, "domain-mismatch");
  if (observed.cookies.length > BROWSER_PRIMARY_PROFILE_OBSERVED_MAX_COOKIES) {
    return dropped(scope, "over-bound");
  }
  return await dependencies.serializeOnDomain(scope, async () => {
    if (
      dependencies.isForgottenPendingAck({
        connectionId: observed.connectionId,
        domain: scope,
      })
    ) {
      return dropped(scope, "ledger-unacked");
    }
    const target = dependencies.getTargetJar();
    const classified = classifyObservedCookies({
      scope,
      cookies: observed.cookies,
      now: dependencies.now(),
      // Read inside the serialized section, so what the jar holds cannot
      // change between the ownership test and the merge that test authorises.
      jarKeys: await browserJarCookieKeys(scope, target.session),
      isHeadlessOriginKey: dependencies.isHeadlessOriginKey,
    });
    let merged: BrowserObservedCookieMergeResult = { applied: 0, refused: [] };
    if (classified.survivors.length > 0) {
      if (target.durableJar) {
        await dependencies.claimHeadlessOriginKeys(
          classified.survivors.map((cookie) => ({
            domain: cookie.domain,
            name: cookie.name,
            path: cookie.path,
          })),
        );
      }
      merged = await mergeObservedProfileCookies(
        classified.survivors,
        target.session,
      );
      // Still inside the serialized section: the claim was taken over what
      // this applier was ABOUT to write, and a cookie the jar refused makes
      // that claim a standing right over a key nobody wrote - which the user's
      // own later sign-in would then spend instead of revoking.
      if (target.durableJar && merged.refused.length > 0) {
        await dependencies.releaseHeadlessOriginKeys(merged.refused);
      }
    }
    return {
      domain: scope,
      outcome: "applied",
      appliedCookies: merged.applied,
      domainMismatchCookies: classified.domainMismatch,
      expiredCookies: classified.expired,
      ownedByDesktopCookies: classified.ownedByDesktop,
      rejectedCookies: merged.refused.length,
    };
  });
}

/**
 * The trace for one applied or refused observation, and the only place this
 * path writes a log line.
 *
 * Every field goes through {@link sanitizeLogFields}: `domain` can be the raw
 * string a sender chose - the frame whose domain does not derive is exactly the
 * one that keeps its claim - and an unbounded remote string is not something to
 * put in a log that gets pasted into support threads unredacted or untruncated.
 */
export function traceBrowserObservedProfile(
  result: BrowserObservedProfileResult,
  context: BrowserObservedProfileTraceContext,
): void {
  if (result.outcome !== "applied") {
    traceRejection(result.domain, result.outcome, 0, context);
    return;
  }
  log.info(
    "[browser-view] merged an observed sign-in",
    sanitizeLogFields({
      hostId: context.hostId,
      domain: result.domain,
      reason: "applied",
      cookies: result.appliedCookies,
      rejected: result.rejectedCookies,
    }),
  );
  // Counts rather than a line per cookie: a frame may carry hundreds, and the
  // forensic question is which reason claimed how many of them. No cookie name
  // and no value is ever logged.
  if (result.domainMismatchCookies > 0) {
    traceRejection(
      result.domain,
      "domain-mismatch",
      result.domainMismatchCookies,
      context,
    );
  }
  if (result.expiredCookies > 0) {
    traceRejection(
      result.domain,
      "expired-cookie",
      result.expiredCookies,
      context,
    );
  }
  if (result.ownedByDesktopCookies > 0) {
    traceRejection(
      result.domain,
      "owned-by-desktop",
      result.ownedByDesktopCookies,
      context,
    );
  }
}

function traceRejection(
  domain: string,
  reason: BrowserObservedProfileReason,
  cookies: number,
  context: BrowserObservedProfileTraceContext,
): void {
  const occurrences = context.governor.sampleRejection(
    context.connectionId,
    reason,
  );
  if (occurrences === null) return;
  log.warn(
    "[browser-view] refused an observed sign-in",
    sanitizeLogFields({
      hostId: context.hostId,
      domain,
      reason,
      cookies,
      // The running total this line stands for, so a sampled trace still
      // reports the magnitude of what it sampled.
      occurrences,
    }),
  );
}

interface ClassifiedObservedCookies {
  readonly survivors: readonly BrowserStorageCookie[];
  readonly domainMismatch: number;
  readonly expired: number;
  readonly ownedByDesktop: number;
}

/**
 * The three per-cookie rejections, all of which leave the rest of the frame
 * applicable.
 *
 * `domain-mismatch` is the independent half of the trust model: the sender's
 * claimed domain is collapsed the same way the cookie's own is, so a cookie
 * for someone else's site cannot ride in on a legitimate observation.
 *
 * `expired-cookie` closes the one implicit sign-out channel the frame's shape
 * leaves open. Chromium treats setting an already-expired cookie as a DELETE of
 * the matching one, and the apply path passes any non-negative `expires`
 * straight through as `expirationDate` - so without this, a frame that cannot
 * express a removal could still perform one. The comparison is against RECEIVE
 * time, which is why it cannot be a schema bound. A NEGATIVE `expires` is the
 * session-cookie sentinel and always passes. It stops only the ZERO-RESIDUE
 * delete; every other destructive write is stopped by the rule below.
 *
 * `owned-by-desktop` is that rule, and it is the load-bearing one. The unit is
 * a cookie NAME within this registrable domain: if the jar holds any cookie of
 * that name that no observation put there, the desktop's own login owns the
 * name and a remote machine may not write it under any path or domain form. A
 * name the jar does not hold is free to add, which is the entire feature: a
 * sign-in that happened on another machine arrives as names this jar has never
 * seen.
 */
function classifyObservedCookies(args: {
  readonly scope: string;
  readonly cookies: readonly BrowserStorageCookie[];
  readonly now: number;
  readonly jarKeys: readonly BrowserCookieKey[];
  readonly isHeadlessOriginKey: (keyId: string) => boolean;
}): ClassifiedObservedCookies {
  const nowSeconds = args.now / 1_000;
  // Names in this scope that no observation contributed. A name with one
  // desktop-written form and one host-contributed form lands here, which is
  // the conservative reading and the right one: the desktop's form is still a
  // live login.
  const desktopOwnedNames = new Set(
    args.jarKeys
      .filter((key) => !args.isHeadlessOriginKey(cookieKeyId(key)))
      .map((key) => key.name),
  );
  const survivors: BrowserStorageCookie[] = [];
  let domainMismatch = 0;
  let expired = 0;
  let ownedByDesktop = 0;
  for (const cookie of args.cookies) {
    if (registrableDomain(cookie.domain) !== args.scope) {
      domainMismatch += 1;
      continue;
    }
    if (cookie.expires >= 0 && cookie.expires <= nowSeconds) {
      expired += 1;
      continue;
    }
    if (desktopOwnedNames.has(cookie.name)) {
      ownedByDesktop += 1;
      continue;
    }
    survivors.push(cookie);
  }
  return { survivors, domainMismatch, expired, ownedByDesktop };
}

function dropped(
  domain: string,
  outcome: BrowserObservedProfileOutcome,
): BrowserObservedProfileResult {
  return {
    domain,
    outcome,
    appliedCookies: 0,
    domainMismatchCookies: 0,
    expiredCookies: 0,
    ownedByDesktopCookies: 0,
    rejectedCookies: 0,
  };
}
