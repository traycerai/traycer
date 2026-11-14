import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import { readDoorReason } from "@traycer/protocol/framework/door-reason";
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

/** A host-only token's recovery, which always reads the host's refusal. */
export type HostTokenRevalidator = StreamAuthRevalidator & {
  readonly revalidateRefused: (
    refusal: FatalErrorDetails,
  ) => Promise<RevalidateOutcome>;
};
import type {
  HostTokenMintOutcome,
  HostTokenSource,
} from "./host-token-source";
import { isUsableHostToken } from "./host-token-store";

/** What a transport needs from the app's host-only tokens. */
export type HostTokenAccess = Pick<HostTokenSource, "current" | "obtain">;

/** A state the app raises itself, from a mint or a repeated refusal. */
export type HostTokenStateSink = (
  hostId: string,
  kind: HostDoorStateKind,
) => void;

/** The state a failed mint raises; `null` for one that raises none here. */
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

/**
 * The credential every frame to `hostId` carries: the host-only token, never
 * the sign-in token. Answers for the person `signIn` names.
 *
 * While no unexpired token is held it answers "no bearer" (`null`), the
 * transport's ordinary wait, and starts one mint shared with any other ask for
 * this host; the transport's own reconnect backoff reads the token once it
 * lands.
 * A person with no verified sign-in mints nothing and raises nothing.
 *
 * One lease object per sign-in lease, so transports keyed on the lease object
 * (the session cache, the unary revalidator's fence) see a new object exactly
 * when the person's sign-in context changes.
 */
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

/**
 * For a unary call to `hostId`: the host-only token as its credential, minted
 * first if none is held. `null`, with the state its failure raises, when none
 * can be had now; a person with no verified sign-in raises nothing.
 */
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

/**
 * Recovery for a host connection whose token was refused or ran out. Keyed on
 * the host's `doorReason`, never on its code, and a host's refusal never
 * starts sign-in recovery:
 * - no refusal yet (a token already known to have run out), or
 *   `token_expired`: mint a fresh token and reconnect.
 * - `not_admitted`: one fresh token; refused again with it, `not-admitted`.
 * - `session_revoked`: the ordinary sign-out path, through the sign-in
 *   token's own refresh.
 * - any other reason, or none (an older host): terminal here; the door
 *   observer has already raised its state.
 *
 * Only authn's own refusal of the sign-in token, a 401 on the mint, is handed
 * to `signInRecovery`.
 */
export function hostTokenRevalidator(deps: {
  readonly tokens: HostTokenAccess;
  /** Who is signed in now; read for their id, never their credential. */
  readonly currentUserId: () => string | null;
  readonly hostId: string;
  readonly signInRecovery: StreamAuthRevalidator | null;
  readonly onState: HostTokenStateSink;
  readonly now: () => number;
}): HostTokenRevalidator {
  // The token minted in answer to the last `not_admitted`: a second refusal
  // while it is still the one held is final.
  let mintedAfterNotAdmitted: string | null = null;

  const mintFresh = async (
    userId: string,
    signInRetried: boolean,
  ): Promise<RevalidateOutcome> => {
    const held = deps.tokens.current(userId, deps.hostId);
    const outcome = await deps.tokens.obtain(userId, deps.hostId, true, null);
    if (outcome.kind === "ok") return "rotated";
    if (outcome.kind === "no-sign-in") return "network-error";
    if (outcome.kind === "sign-in-rejected") {
      if (signInRetried || deps.signInRecovery === null) return "rejected";
      const recovered = await deps.signInRecovery.revalidateForReconnect();
      return recovered === "rotated" ? mintFresh(userId, true) : recovered;
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
    if (refusal === null) return mintFresh(userId, false);
    const reason = readDoorReason(refusal.doorReason);
    if (reason === "token_expired") return mintFresh(userId, false);
    if (reason === "not_admitted") {
      const held = deps.tokens.current(userId, deps.hostId)?.token ?? null;
      if (held !== null && held === mintedAfterNotAdmitted) {
        deps.onState(deps.hostId, "not-admitted");
        return "rejected";
      }
      const outcome = await mintFresh(userId, false);
      mintedAfterNotAdmitted =
        deps.tokens.current(userId, deps.hostId)?.token ?? null;
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

/**
 * The same recovery for unary calls, which reach any host through one
 * messenger: one host's revalidator per host, chosen by the host the refused
 * call was sent to. A call answered for a different person than the one now
 * signed in is `superseded`. A refusal in a call's own answer rather than at
 * the door (no fatal details) recovers nothing: each call already carries a
 * token checked unexpired just before it was sent.
 */
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
      revalidator = hostTokenRevalidator({ ...deps, hostId });
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
