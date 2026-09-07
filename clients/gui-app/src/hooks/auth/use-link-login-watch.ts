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

/** The server enforces ONE live code per user (minting atomically supersedes the previous unclaimed record, and is refused while a claim is being decided), so the displayed code is the only code that can ever report a claim - no multi-code bookkeeping exists. */
/** `not-presented` is the server saying the phone declined to show one - a legitimate older app, or a leaked-QR holder withholding the flag to dodge the check, which the card cannot tell apart and so must render as a warning. */
export type LiveMatchCode =
  | { readonly kind: "shown"; readonly code: string }
  | { readonly kind: "not-presented" }
  | { readonly kind: "unavailable" };

export interface LiveClaim {
  readonly code: string;
  readonly address: string | null;
  readonly userAgent: string | null;
  readonly location: string | null;
  readonly matchCode: LiveMatchCode;
  /** When the claim expires unanswered (epoch ms) on the SERVER's clock, or `null` from a server that predates the field - the card then shows no countdown. */
  readonly claimExpiresAt: number | null;
}

function liveMatchCodeOf(
  claimant: NonNullable<LinkLoginStatusResponse["claimant"]>,
): LiveMatchCode {
  if (claimant.matchCode === undefined) {
    return { kind: "unavailable" };
  }
  if (claimant.matchCode === null) {
    return { kind: "not-presented" };
  }
  return { kind: "shown", code: claimant.matchCode };
}

/** How the displayed code was terminated externally: `superseded` (gone - replaced by a mint on another surface, expired, or consumed) or `rejected` (a denial someone actually made on another surface). */
export type LinkLoginDeadKind = "superseded" | "rejected" | "expired";

// The generous grace absorbs clock skew and poll latency - the local deadline exists so a frozen status poll (throttled timers, a dropped network) can never leave a confirm card whose buttons act on a record the server already deleted.
const LINK_LOGIN_CLAIM_WINDOW_MS = 120_000;
const CLAIM_EXPIRY_GRACE_MS = 15_000;

export interface LinkLoginWatch {
  readonly claim: LiveClaim | null;
  /** The mint query. */
  readonly code: UseQueryResult<MintLinkLoginCodeResponse | null>;
  /** External termination of the displayed code, rendered - never reacted to. */
  readonly deadKind: LinkLoginDeadKind | null;
  /** The ONLY way a surface replaces a dead (or consumed) code: evicts the cached mint and re-enables rotation, so the re-enabled query has nothing stale to serve and must adopt a genuinely new code. */
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
    matchCode: liveMatchCodeOf(claimant),
    claimExpiresAt: claimant.claimExpiresAt ?? null,
  };
}

/** One narrowing rather than two: both readers below need exactly this shape, and a change to `LinkLoginStatusDatum` should not have to be noticed twice. */
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

/** One synchronous read of the watch state: the live claim (unless its local deadline has passed), or how the displayed code died. */
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

/** Owns the Link mobile app panel's code lifecycle: rotates the public code while nothing is claimed, watches THE displayed code (the server's one-live-code policy makes it the only claimable one), pauses rotation the moment its claim appears, and reports external death of the displayed code as a rendered state with rotation idled - the panel offers an explicit restart (a manual `refetch`, which TanStack v5 honors on a disabled query), never an automatic re-mint. */
export function useLinkLoginWatch(enabled: boolean): LinkLoginWatch {
  const [watchedCode, setWatchedCode] = useState<string | null>(null);
  // The code a user-driven restart is replacing: while it is still the
  // watched one, its death is no longer rendered (the replacement is in
  // flight) and the mint query is re-enabled despite it.
  const [restartedFrom, setRestartedFrom] = useState<string | null>(null);

  const status = useAuthLinkLoginStatus(enabled ? watchedCode : null);

  // Local claim deadline, ticking only while a claim is on screen: belt to
  // the status poll's braces - even if every poll freezes, the confirm card
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
  // screen. Never while a claim is live - the claimed code stays watched
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
