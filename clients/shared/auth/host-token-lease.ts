import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import { readDoorReason } from "@traycer/protocol/framework/door-reason";
import type { SessionDoorObserver } from "@traycer/protocol/host-transport/remote/auth";
import type { HostDoorStateKind } from "../host-transport/host-door-state";
import type {
  BearerSourceProvider,
  OpenFrameBearerSource,
} from "./bearer-source";
import type {
  RefusalAwareAuthRevalidator,
  RevalidateOutcome,
  StreamAuthRevalidator,
} from "./bearer-revalidator";

export type HostTokenRevalidator = StreamAuthRevalidator & {
  readonly revalidateRefused: (
    refusal: FatalErrorDetails,
  ) => Promise<RevalidateOutcome>;
};

export type HostTokenSessionRevalidator = HostTokenRevalidator & {
  readonly admitted: () => void;
};
import type {
  HostTokenMintOutcome,
  HostTokenSource,
} from "./host-token-source";
import { isUsableHostToken } from "./host-token-store";

export type HostTokenAccess = Pick<HostTokenSource, "current" | "obtain">;

export type HostTokenStateSink = (
  hostId: string,
  kind: HostDoorStateKind,
) => void;

function stateOfFailedMint(
  outcome: Exclude<HostTokenMintOutcome, { readonly kind: "ok" }>,
  heldTokenExpired: boolean,
): HostDoorStateKind | null {
  if (outcome.kind === "not-a-member") return "not-a-member";
  if (outcome.kind === "not-admitted") return "not-admitted";
  if (outcome.kind === "unavailable")
    return heldTokenExpired ? "token-expired" : "token-unavailable";
  return null;
}

// Never the sign-in token. One lease object per sign-in lease: transports keyed
// on it see a new object exactly when the sign-in context changes.
export function hostTokenBearer(
  tokens: HostTokenAccess,
  signIn: BearerSourceProvider,
  hostId: string,
  onState: HostTokenStateSink,
): BearerSourceProvider {
  const leases = new WeakMap<OpenFrameBearerSource, OpenFrameBearerSource>();
  return () => {
    const signInLease = signIn();
    if (signInLease === null) return null;
    const userId = signInLease.identity.userId;
    if (!isUsableHostToken(tokens.current(userId, hostId), Date.now())) {
      void tokens.obtain(userId, hostId, false, null).then(
        (outcome) => {
          if (outcome.kind === "ok") return;
          const state = stateOfFailedMint(outcome, false);
          if (state !== null) onState(hostId, state);
        },
        () => undefined,
      );
      return null;
    }
    const existing = leases.get(signInLease);
    if (existing !== undefined) return existing;
    const lease: OpenFrameBearerSource = {
      identity: { userId },
      getBearerToken: () => tokens.current(userId, hostId)?.token ?? "",
    };
    leases.set(signInLease, lease);
    return lease;
  };
}

export function hostTokenBearerFor(
  tokens: HostTokenAccess,
  onState: HostTokenStateSink,
): (
  hostId: string,
  signIn: OpenFrameBearerSource,
) => Promise<OpenFrameBearerSource | null> {
  return async (hostId, signIn) => {
    const userId = signIn.identity.userId;
    const outcome = await tokens.obtain(userId, hostId, false, null);
    if (outcome.kind !== "ok") {
      const state = stateOfFailedMint(outcome, false);
      if (state !== null) onState(hostId, state);
      return null;
    }
    return {
      identity: { userId },
      getBearerToken: () => tokens.current(userId, hostId)?.token ?? "",
    };
  };
}

// A relay redials with the token its attach grant brings, so a session's bound
// lasts until its open is admitted; a unary call's ends at the token minted after
// the first refusal.
interface ReplacementBound {
  readonly final: (userId: string, held: string | null) => boolean;
  readonly retried: (userId: string, minted: string | null) => void;
}

function untilAdmittedBound(): ReplacementBound & {
  readonly admitted: () => void;
} {
  let retried = false;
  return {
    final: () => retried,
    retried: () => {
      retried = true;
    },
    admitted: () => {
      retried = false;
    },
  };
}

function sameTokenBound(): ReplacementBound {
  let minted: { readonly userId: string; readonly token: string } | null = null;
  return {
    final: (userId, held) =>
      held !== null && minted?.userId === userId && held === minted.token,
    retried: (userId, token) => {
      minted = token === null ? null : { userId, token };
    },
  };
}

interface ReplacementBounds {
  readonly expiry: ReplacementBound;
  readonly notAdmitted: ReplacementBound;
}

type HostTokenRevalidatorDeps = {
  readonly tokens: HostTokenAccess;
  /** Who is signed in now; read for their id, never their credential. */
  readonly currentUserId: () => string | null;
  readonly hostId: string;
  readonly signInRecovery: StreamAuthRevalidator | null;
  readonly onState: HostTokenStateSink;
  readonly now: () => number;
};

export function hostTokenSessionAuth(
  deps: HostTokenRevalidatorDeps,
  door: SessionDoorObserver | null,
): {
  readonly auth: HostTokenSessionRevalidator;
  readonly door: SessionDoorObserver;
} {
  const auth = hostTokenRevalidator(deps);
  return {
    auth,
    door: {
      refused: (details) => {
        door?.refused(details);
      },
      admitted: () => {
        auth.admitted();
        door?.admitted();
      },
    },
  };
}

// Keyed on `doorReason`, never on its code; a host's refusal never starts sign-in
// recovery (only authn's 401 on the mint reaches `signInRecovery`). Build it through
// `hostTokenSessionAuth`, or its bounds never reset.
export function hostTokenRevalidator(
  deps: HostTokenRevalidatorDeps,
): HostTokenSessionRevalidator {
  const expiry = untilAdmittedBound();
  const notAdmitted = untilAdmittedBound();
  return {
    ...revalidatorWithBounds(deps, { expiry, notAdmitted }),
    admitted: () => {
      expiry.admitted();
      notAdmitted.admitted();
    },
  };
}

function revalidatorWithBounds(
  deps: HostTokenRevalidatorDeps,
  bounds: ReplacementBounds,
): HostTokenRevalidator {
  const mintFresh = async (
    userId: string,
    signInRetried: boolean,
    eraRetried: boolean,
  ): Promise<RevalidateOutcome> => {
    const held = deps.tokens.current(userId, deps.hostId);
    const outcome = await deps.tokens.obtain(userId, deps.hostId, true, null);
    if (outcome.kind === "ok") return "rotated";
    if (outcome.kind === "no-sign-in") return "network-error";
    // The era ended: only the same person, signed in again, gets one more ask.
    if (outcome.kind === "superseded")
      return !eraRetried && deps.currentUserId() === userId
        ? mintFresh(userId, signInRetried, true)
        : "rejected";
    if (outcome.kind === "sign-in-rejected") {
      if (signInRetried || deps.signInRecovery === null) return "rejected";
      const recovered = await deps.signInRecovery.revalidateForReconnect();
      return recovered === "rotated"
        ? mintFresh(userId, true, eraRetried)
        : recovered;
    }
    const state = stateOfFailedMint(
      outcome,
      held !== null && !isUsableHostToken(held, deps.now()),
    );
    if (state !== null) deps.onState(deps.hostId, state);
    return outcome.kind === "unavailable" ? "network-error" : "rejected";
  };

  const recover = async (
    userId: string,
    refusal: FatalErrorDetails | null,
  ): Promise<RevalidateOutcome> => {
    if (refusal === null) return mintFresh(userId, false, false);
    const reason = readDoorReason(refusal.doorReason);
    if (reason === "token_expired") {
      // Refused as expired while this clock calls the token usable: another mint would be too.
      const held = deps.tokens.current(userId, deps.hostId);
      if (
        held !== null &&
        isUsableHostToken(held, deps.now()) &&
        bounds.expiry.final(userId, held.token)
      )
        return "rejected";
      const outcome = await mintFresh(userId, false, false);
      // Only a minted token replaces the held one; after a failed mint the old one stays.
      if (outcome === "rotated")
        bounds.expiry.retried(
          userId,
          deps.tokens.current(userId, deps.hostId)?.token ?? null,
        );
      return outcome;
    }
    if (reason === "not_admitted") {
      const held = deps.tokens.current(userId, deps.hostId)?.token ?? null;
      if (bounds.notAdmitted.final(userId, held)) {
        deps.onState(deps.hostId, "not-admitted");
        return "rejected";
      }
      const outcome = await mintFresh(userId, false, false);
      if (outcome === "rotated")
        bounds.notAdmitted.retried(
          userId,
          deps.tokens.current(userId, deps.hostId)?.token ?? null,
        );
      return outcome;
    }
    if (reason === "session_revoked" && deps.signInRecovery !== null)
      await deps.signInRecovery.revalidateForReconnect();
    return "rejected";
  };

  const recoverFor = async (
    refusal: FatalErrorDetails | null,
  ): Promise<RevalidateOutcome> => {
    const userId = deps.currentUserId();
    return userId === null ? "rejected" : recover(userId, refusal);
  };
  return {
    revalidateForReconnect: () => recoverFor(null),
    revalidateRefused: (refusal) => recoverFor(refusal),
  };
}

// A refusal in a call's own answer (no fatal details) recovers nothing: each call's
// token was checked unexpired just before it was sent.
export function hostTokenUnaryRevalidator(deps: {
  readonly tokens: HostTokenAccess;
  readonly currentUserId: () => string | null;
  readonly signInRecovery: StreamAuthRevalidator | null;
  readonly onState: HostTokenStateSink;
  readonly now: () => number;
}): Pick<RefusalAwareAuthRevalidator, "revalidateRefusedBearer"> {
  const byHost = new Map<string, HostTokenRevalidator>();
  const forHost = (hostId: string): HostTokenRevalidator => {
    let revalidator = byHost.get(hostId);
    if (revalidator === undefined) {
      revalidator = revalidatorWithBounds(
        { ...deps, hostId },
        { expiry: sameTokenBound(), notAdmitted: sameTokenBound() },
      );
      byHost.set(hostId, revalidator);
    }
    return revalidator;
  };
  return {
    revalidateRefusedBearer: async (expected, hostId, refusal) => {
      const userId = deps.currentUserId();
      if (userId === null) return "rejected";
      if (userId !== expected.identity.userId) return "superseded";
      if (refusal === null) return "rejected";
      return forHost(hostId).revalidateRefused(refusal);
    },
  };
}
