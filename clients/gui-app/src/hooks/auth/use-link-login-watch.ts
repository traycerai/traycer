import { useCallback, useEffect, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type {
  LinkLoginStatusResponse,
  MintLinkLoginCodeResponse,
} from "@traycer/protocol/auth/link-login";
import {
  useAuthLinkLoginCode,
  useEvictLinkLoginCode,
} from "@/hooks/auth/use-link-login-code-query";
import {
  useAuthLinkLoginStatus,
  type LinkLoginStatusDatum,
} from "@/hooks/auth/use-link-login-status-query";

/**
 * A live claim on this panel's code. The server enforces ONE live code per
 * user (minting atomically supersedes the previous unclaimed record, and is
 * refused while a claim is being decided), so the displayed code is the only
 * code that can ever report a claim — no multi-code bookkeeping exists.
 */
export interface LiveClaim {
  readonly code: string;
  readonly address: string | null;
  readonly userAgent: string | null;
  readonly location: string | null;
}

/**
 * How the displayed code was terminated externally: `superseded` (gone —
 * replaced by a mint on another surface, expired, or consumed) or
 * `rejected` (a denial someone actually made on another surface). Two
 * states because they read differently to the user; the portal renders the
 * same pair.
 */
export type LinkLoginDeadKind = "superseded" | "rejected" | "expired";

// Client-side mirror of the server's claim window (authn's
// LINK_LOGIN_CLAIM_WINDOW_SECONDS): from the claim, the human has this long
// to decide before the record evaporates. The generous grace absorbs clock
// skew and poll latency — the local deadline exists so a frozen status poll
// (throttled timers, a dropped network) can never leave a confirm card whose
// buttons act on a record the server already deleted.
const LINK_LOGIN_CLAIM_WINDOW_MS = 120_000;
const CLAIM_EXPIRY_GRACE_MS = 15_000;

export interface LinkLoginWatch {
  /** The live claim on the displayed code, if any. */
  readonly claim: LiveClaim | null;
  /**
   * The mint query. Rotation is paused while a claim is live AND while the
   * displayed code is externally dead — a dead code costs zero further
   * requests, and an automatic re-mint would supersede the other surface
   * right back (ping-ponging mints between open surfaces). Restart is the
   * panel's explicit, user-driven `refetch()` only.
   */
  readonly code: UseQueryResult<MintLinkLoginCodeResponse | null>;
  /** External termination of the displayed code, rendered — never reacted to. */
  readonly deadKind: LinkLoginDeadKind | null;
  /**
   * The ONLY way a surface replaces a dead (or consumed) code: evicts the
   * cached mint and re-enables rotation, so the re-enabled query has nothing
   * stale to serve and must adopt a genuinely new code. A bare `refetch()`
   * is NOT equivalent — it fires the request but the re-enabled observer
   * serves the still-fresh cache entry, re-rendering the dead code and
   * wasting the minted one.
   */
  readonly restart: () => void;
}

function claimFromStatus(
  code: string | null,
  datum: LinkLoginStatusDatum | null | undefined,
): LiveClaim | null {
  const claimant = claimantOf(datum);
  if (code === null || claimant === null) {
    return null;
  }
  return {
    code,
    address: claimant.address,
    userAgent: claimant.userAgent,
    location: claimant.location,
  };
}

/**
 * The claimant a status datum carries, or `null` for every state that has
 * none — absent, `"gone"`, not yet claimed, or claimed with no metadata.
 *
 * One narrowing rather than two: both readers below need exactly this shape,
 * and a change to `LinkLoginStatusDatum` should not have to be noticed twice.
 */
function claimantOf(
  datum: LinkLoginStatusDatum | null | undefined,
): LinkLoginStatusResponse["claimant"] | null {
  if (
    datum === null ||
    datum === undefined ||
    datum === "gone" ||
    datum.status !== "claimed"
  ) {
    return null;
  }
  return datum.claimant;
}

function claimedAtMsFromStatus(
  datum: LinkLoginStatusDatum | null | undefined,
): number | null {
  const claimant = claimantOf(datum);
  return claimant === null ? null : claimant.claimedAt;
}

interface WatchSnapshot {
  readonly claim: LiveClaim | null;
  readonly externallyDead: LinkLoginDeadKind | null;
}

/**
 * One synchronous read of the watch state: the live claim (unless its local
 * deadline has passed), or how the displayed code died. Pure, so the hook
 * body stays a straight line.
 */
function resolveWatchSnapshot(
  watchedCode: string | null,
  datum: LinkLoginStatusDatum | null | undefined,
  nowMs: number,
): WatchSnapshot {
  const rawClaim = claimFromStatus(watchedCode, datum);
  const claimedAtMs = claimedAtMsFromStatus(datum);
  const expiredLocally =
    rawClaim !== null &&
    claimedAtMs !== null &&
    nowMs > claimedAtMs + LINK_LOGIN_CLAIM_WINDOW_MS + CLAIM_EXPIRY_GRACE_MS;
  if (expiredLocally) {
    return { claim: null, externallyDead: "expired" };
  }
  const externallyDead =
    rawClaim === null && watchedCode !== null
      ? deadKindFromStatus(datum)
      : null;
  return { claim: rawClaim, externallyDead };
}

function deadKindFromStatus(
  datum: LinkLoginStatusDatum | null | undefined,
): LinkLoginDeadKind | null {
  if (datum === "gone") {
    return "superseded";
  }
  if (datum !== null && datum !== undefined && datum.status === "denied") {
    return "rejected";
  }
  return null;
}

/**
 * Owns the Link-a-phone panel's code lifecycle: rotates the public code
 * while nothing is claimed, watches THE displayed code (the server's
 * one-live-code policy makes it the only claimable one), pauses rotation the
 * moment its claim appears, and reports external death of the displayed
 * code as a rendered state with rotation idled — the panel offers an
 * explicit restart (a manual `refetch`, which TanStack v5 honors on a
 * disabled query), never an automatic re-mint.
 */
export function useLinkLoginWatch(enabled: boolean): LinkLoginWatch {
  const [watchedCode, setWatchedCode] = useState<string | null>(null);
  // The code a user-driven restart is replacing: while it is still the
  // watched one, its death is no longer rendered (the replacement is in
  // flight) and the mint query is re-enabled despite it.
  const [restartedFrom, setRestartedFrom] = useState<string | null>(null);

  const status = useAuthLinkLoginStatus(enabled ? watchedCode : null);

  // Local claim deadline, ticking only while a claim is on screen: belt to
  // the status poll's braces — even if every poll freezes, the confirm card
  // cannot outlive the record it fronts.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const { claim, externallyDead } = resolveWatchSnapshot(
    watchedCode,
    status.data,
    nowMs,
  );
  const claimOnScreen = claim !== null;
  useEffect(() => {
    if (!claimOnScreen) {
      return;
    }
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);
    return () => {
      clearInterval(timer);
    };
  }, [claimOnScreen]);
  const restartPending =
    restartedFrom !== null && restartedFrom === watchedCode;

  const code = useAuthLinkLoginCode(
    enabled && claim === null && (externallyDead === null || restartPending),
  );
  const minted = code.data ?? null;

  // Adjust-during-render (guarded): follow the mint onto the code now on
  // screen. Never while a claim is live — the claimed code stays watched
  // until the decision resolves it, and the mint query is paused anyway.
  if (claim === null && minted !== null && watchedCode !== minted.code) {
    setWatchedCode(minted.code);
    if (restartedFrom !== null) {
      setRestartedFrom(null);
    }
  }

  const evict = useEvictLinkLoginCode();
  const restart = useCallback(() => {
    evict();
    setRestartedFrom(watchedCode);
  }, [evict, watchedCode]);

  return {
    claim,
    code,
    deadKind: restartPending ? null : externallyDead,
    restart,
  };
}
