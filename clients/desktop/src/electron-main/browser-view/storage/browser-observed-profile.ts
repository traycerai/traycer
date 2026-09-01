import {
  BROWSER_PRIMARY_PROFILE_OBSERVED_MAX_BURST,
  BROWSER_PRIMARY_PROFILE_OBSERVED_MAX_COOKIES,
  type BrowserStorageCookie,
} from "@traycer/protocol/host/browser/contracts";
import { registrableDomain } from "@traycer/protocol/host/browser/registrable-domain";
import { log, sanitizeLogFields } from "../../app/logger";
import {
  mergeObservedProfileCookies,
  type BrowserStorageSession,
} from "./browser-storage-state";

/**
 * The desktop's enforcement of `primaryProfileObserved` (universal-sign-in
 * ticket 03): the first host->jar WRITE direction the contract has, applied to
 * the user's master jar and therefore treated as untrusted input from end to
 * end.
 *
 * Nothing here believes the frame. The registrable domain of every cookie is
 * re-derived locally and checked against the domain the frame claims; the
 * volume and the rate are bounded; a site the user forgot is refused until the
 * sending connection has acked pruning it; and what survives goes through
 * Chromium's own `cookies.set`, which is what normalises the attributes away
 * from anything the sender chose.
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
 * The frame-level verdict. `expired-cookie` is missing on purpose: an expired
 * cookie is dropped by itself and never costs the frame the rest of the
 * sign-in it belongs to.
 */
export type BrowserObservedProfileOutcome = Exclude<
  BrowserObservedProfileReason,
  "expired-cookie"
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
  /** Cookies the jar itself would not take; counted, never fatal to the frame. */
  readonly rejectedCookies: number;
}

/** What the trace needs about the connection a result came off. */
export interface BrowserObservedProfileTraceContext {
  readonly hostId: string;
  readonly connectionId: string;
  readonly governor: BrowserObservedConnectionGovernor;
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
  /** The `primary` jar guests are on right now - the one an observation merges into. */
  readonly getSession: () => BrowserStorageSession;
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
    const classified = classifyObservedCookies({
      scope,
      cookies: observed.cookies,
      now: dependencies.now(),
    });
    const merged =
      classified.survivors.length === 0
        ? { applied: 0, rejected: 0 }
        : await mergeObservedProfileCookies(
            classified.survivors,
            dependencies.getSession(),
          );
    return {
      domain: scope,
      outcome: "applied",
      appliedCookies: merged.applied,
      domainMismatchCookies: classified.domainMismatch,
      expiredCookies: classified.expired,
      rejectedCookies: merged.rejected,
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
}

/**
 * The two per-cookie rejections, both of which leave the rest of the frame
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
 * session-cookie sentinel and always passes.
 */
function classifyObservedCookies(args: {
  readonly scope: string;
  readonly cookies: readonly BrowserStorageCookie[];
  readonly now: number;
}): ClassifiedObservedCookies {
  const nowSeconds = args.now / 1_000;
  const survivors: BrowserStorageCookie[] = [];
  let domainMismatch = 0;
  let expired = 0;
  for (const cookie of args.cookies) {
    if (registrableDomain(cookie.domain) !== args.scope) {
      domainMismatch += 1;
      continue;
    }
    if (cookie.expires >= 0 && cookie.expires <= nowSeconds) {
      expired += 1;
      continue;
    }
    survivors.push(cookie);
  }
  return { survivors, domainMismatch, expired };
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
    rejectedCookies: 0,
  };
}
