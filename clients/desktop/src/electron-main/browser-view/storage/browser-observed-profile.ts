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


/** Every reason one observed frame's fate is traced under. */
export type BrowserObservedProfileReason =
  | "applied"
  | "domain-mismatch"
  | "expired-cookie"
  | "over-bound"
  | "rate-limited"
  | "owned-by-desktop"
  | "ledger-unacked";

export type BrowserObservedProfileOutcome = Exclude<
  BrowserObservedProfileReason,
  "expired-cookie" | "owned-by-desktop"
>;

export interface BrowserObservedProfile {
  readonly source: "observed" | "seed";
  readonly connectionId: string;
  readonly hostId: string;
  readonly domain: string;
  readonly cookies: readonly BrowserStorageCookie[];
}

export interface BrowserObservedProfileResult {
  /** The frame's claimed domain collapsed to its registrable form - or, when it does not collapse at all, the raw string the sender chose. */
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

/** What the trace needs about the write a result came off. */
export interface BrowserObservedProfileTraceContext {
  readonly source: BrowserObservedProfile["source"];
  readonly hostId: string;
  readonly connectionId: string;
  readonly governor: BrowserObservedConnectionGovernor;
}

/** The jar one observation is applied to, and what kind of jar it is. */
export interface BrowserObservedProfileTarget {
  readonly session: BrowserStorageSession;
  readonly durableJar: boolean;
}

export interface BrowserObservedProfileDependencies {
  readonly now: () => number;
  readonly isForgottenPendingAck: (input: {
    readonly connectionId: string;
    readonly domain: string;
  }) => boolean;
  readonly isHeadlessOriginKey: (keyId: string) => boolean;
  /**
   * Awaited before the merge, deliberately.
   * Both halves must be in place before the first `cookies.set` fires, or the observer sees an insert it cannot attribute and hands the key straight back.
   */
  readonly claimHeadlessOriginKeys: (
    keys: readonly BrowserCookieKey[],
  ) => Promise<void>;
  readonly releaseHeadlessOriginKeys: (
    keys: readonly BrowserCookieKey[],
  ) => Promise<void>;
  readonly getTargetJar: () => BrowserObservedProfileTarget;
  /** Runs the merge with no competing jar work for the same site. */
  readonly serializeOnDomain: <T>(
    domain: string,
    action: () => Promise<T>,
  ) => Promise<T>;
  readonly governor: BrowserObservedConnectionGovernor;
}

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

/** A host cycling reconnects to buy budget pays a full stream re-handshake per cycle, still cannot write a cookie that fails validation, and runs into Chromium's own per-host cookie. */
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

export async function applyBrowserObservedProfile(
  observed: BrowserObservedProfile,
  dependencies: BrowserObservedProfileDependencies,
): Promise<BrowserObservedProfileResult> {
  if (
    observed.source !== "seed" &&
    !dependencies.governor.admit(observed.connectionId)
  ) {
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

/** Every field goes through {@link sanitizeLogFields}: `domain` can be the raw string a sender chose. */
export function traceBrowserObservedProfile(
  result: BrowserObservedProfileResult,
  context: BrowserObservedProfileTraceContext,
): void {
  if (result.outcome !== "applied") {
    traceRejection(result.domain, result.outcome, 0, context);
    return;
  }
  log.info(
    "[browser-view] merged a host-contributed sign-in",
    sanitizeLogFields({
      source: context.source,
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
    "[browser-view] refused a host-contributed sign-in",
    sanitizeLogFields({
      source: context.source,
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

function classifyObservedCookies(args: {
  readonly scope: string;
  readonly cookies: readonly BrowserStorageCookie[];
  readonly now: number;
  readonly jarKeys: readonly BrowserCookieKey[];
  readonly isHeadlessOriginKey: (keyId: string) => boolean;
}): ClassifiedObservedCookies {
  const nowSeconds = args.now / 1_000;
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
