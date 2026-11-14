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

/** A host-only token's recovery, which always reads the host's refusal. */
export type HostTokenRevalidator = StreamAuthRevalidator & {
  readonly revalidateRefused: (
    refusal: FatalErrorDetails,
  ) => Promise<RevalidateOutcome>;
};

/** One session's recovery, told when that session's open is admitted. */
export type HostTokenSessionRevalidator = HostTokenRevalidator & {
  readonly admitted: () => void;
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

/**
 * The state a failed mint raises; `null` for one that raises none here, a
 * `superseded` mint among them: it belonged to a person no longer signed in.
 */
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
 * When a second `not_admitted` is final. A session's bound lasts until its
 * open is admitted: a relay's every dial adopts the token its attach grant
 * brings, so the token refused the second time is never the one minted after
 * the first. A unary call is retried over a connection that does not redial,
 * so its bound is the token minted after the first refusal.
 */
interface NotAdmittedBound {
  readonly final: (held: string | null) => boolean;
  readonly retried: (minted: string | null) => void;
}

/** A session's bound. {@link hostTokenSessionAuth} wires its reset. */
function untilAdmittedBound(): NotAdmittedBound & {
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

/** A unary call's bound, which no admitted open resets. */
function sameTokenBound(): NotAdmittedBound {
  let mintedAfterNotAdmitted: string | null = null;
  return {
    final: (held) => held !== null && held === mintedAfterNotAdmitted,
    retried: (minted) => {
      mintedAfterNotAdmitted = minted;
    },
  };
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

/**
 * A session's host-token recovery and the door observer that session reports
 * to, composed so the recovery hears every admitted open. Every session that
 * presents a host-only token builds its recovery here. `door` is the caller's
 * own observer, told everything as before.
 */
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

/**
 * Recovery for a host session whose token was refused or ran out. Keyed on
 * the host's `doorReason`, never on its code, and a host's refusal never
 * starts sign-in recovery:
 * - no refusal yet (a token already known to have run out): mint a fresh
 *   token and reconnect.
 * - `token_expired`: one fresh token; refused as expired again while this
 *   clock still calls it unexpired, terminal, with no state.
 * - `not_admitted`: one fresh token; refused again before the session's open
 *   is next admitted, `not-admitted`.
 * - `session_revoked`: the ordinary sign-out path, through the sign-in
 *   token's own refresh.
 * - any other reason, or none (an older host): terminal here; the door
 *   observer has already raised its state.
 *
 * Only authn's own refusal of the sign-in token, a 401 on the mint, is handed
 * to `signInRecovery`.
 *
 * A session builds this through {@link hostTokenSessionAuth}, or nothing
 * tells it the open was admitted and its `not_admitted` bound never resets.
 */
export function hostTokenRevalidator(
  deps: HostTokenRevalidatorDeps,
): HostTokenSessionRevalidator {
  const bound = untilAdmittedBound();
  return {
    ...revalidatorWithBound(deps, bound),
    admitted: bound.admitted,
  };
}

function revalidatorWithBound(
  deps: HostTokenRevalidatorDeps,
  notAdmitted: NotAdmittedBound,
): HostTokenRevalidator {
  // The token minted for this person in answer to their last
  // `token_expired`. Refused as expired again while this clock still calls it
  // usable, another mint cannot help: the next would be refused the same way.
  let mintedAfterExpiry: {
    readonly userId: string;
    readonly token: string;
  } | null = null;

  const mintFresh = async (
    userId: string,
    signInRetried: boolean,
  ): Promise<RevalidateOutcome> => {
    const held = deps.tokens.current(userId, deps.hostId);
    const outcome = await deps.tokens.obtain(userId, deps.hostId, true, null);
    if (outcome.kind === "ok") return "rotated";
    if (outcome.kind === "no-sign-in") return "network-error";
    // The person signed out or was replaced meanwhile: nothing of theirs is
    // raised, and their connection is ended with them.
    if (outcome.kind === "superseded") return "rejected";
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
    if (reason === "token_expired") {
      const held = deps.tokens.current(userId, deps.hostId);
      if (
        held !== null &&
        mintedAfterExpiry?.userId === userId &&
        held.token === mintedAfterExpiry.token &&
        isUsableHostToken(held, deps.now())
      )
        return "rejected";
      const outcome = await mintFresh(userId, false);
      // Only a token that was in fact minted becomes the replacement: after
      // a failed mint the old token is still the one held, and its next
      // refusal earns another try once authn answers.
      if (outcome === "rotated") {
        const minted = deps.tokens.current(userId, deps.hostId)?.token ?? null;
        mintedAfterExpiry = minted === null ? null : { userId, token: minted };
      }
      return outcome;
    }
    if (reason === "not_admitted") {
      const held = deps.tokens.current(userId, deps.hostId)?.token ?? null;
      if (notAdmitted.final(held)) {
        deps.onState(deps.hostId, "not-admitted");
        return "rejected";
      }
      const outcome = await mintFresh(userId, false);
      // Likewise: a failed mint spends nothing of the bound.
      if (outcome === "rotated")
        notAdmitted.retried(
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
      revalidator = revalidatorWithBound({ ...deps, hostId }, sameTokenBound());
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
