import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import { readDoorReason } from "@traycer/protocol/framework/door-reason";
import type {
  DoorAdmissionRelease,
  HostDoorObserver,
  HostDoorStateKind,
  StreamDoorObserver,
} from "../host-transport/host-door-state";
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
  HostInstance,
  ReleasedHostMemory,
} from "../host-transport/released-sign-on";
import type {
  HostTokenMintFailure,
  HostTokenMintOutcome,
  HostTokenSource,
} from "./host-token-source";
import { isUsableHostToken, type HostToken } from "./host-token-store";

/** A door's tokens, with whether the stored ones are read yet. */
export type HostTokenAccess = Pick<
  HostTokenSource,
  "current" | "obtain" | "loaded" | "whenLoaded" | "lastFailureOf"
>;

/** The process instances a door's mints and marks belong to. */
export type HostInstanceOwners = Pick<
  ReleasedHostMemory,
  "currentInstance" | "isCurrent"
>;

/**
 * A local door's token source, answering for the host's current process
 * instance: how its last mint ended, and which held token it refused as
 * expired. Both belong to the instance, so a replaced one starts with neither.
 */
export interface TrackedHostTokens extends Pick<
  HostTokenAccess,
  "current" | "obtain" | "loaded" | "whenLoaded"
> {
  readonly hosts: HostInstanceOwners;
  /** `lastFailureOf` for the host's current instance. */
  readonly lastFailure: (
    userId: string,
    hostId: string,
  ) => HostTokenMintFailure | null;
  /**
   * `instance` refused `presented` as expired: it reads authn reachable, so
   * presenting that token to it again cannot open. Any other token, one minted
   * while the refusal was on its way included, and any other instance, is not
   * affected.
   */
  readonly noteHeldRefused: (
    instance: HostInstance,
    userId: string,
    presented: string,
  ) => void;
  /** Whether the host's current instance refused the held token. */
  readonly heldRefused: (userId: string, hostId: string) => boolean;
  /**
   * The refusal noted above makes way only for the owner's sign-in. Where that
   * cannot follow, the held token is presented again: the host admits it once
   * it, too, cannot reach authn.
   */
  readonly forgetHeldRefused: (userId: string, hostId: string) => void;
}

export function trackHostTokenMints(
  tokens: HostTokenAccess,
  hosts: HostInstanceOwners,
): TrackedHostTokens {
  const refusedHeld = new WeakMap<HostInstance, Map<string, string>>();
  return {
    hosts,
    current: (userId, hostId) => tokens.current(userId, hostId),
    loaded: () => tokens.loaded(),
    whenLoaded: () => tokens.whenLoaded(),
    obtain: (userId, hostId, fresh, ask) =>
      tokens.obtain(userId, hostId, fresh, ask),
    lastFailure: (userId, hostId) =>
      tokens.lastFailureOf(userId, hosts.currentInstance(hostId)),
    noteHeldRefused: (instance, userId, presented) => {
      if (!hosts.isCurrent(instance)) return;
      let byUser = refusedHeld.get(instance);
      if (byUser === undefined) {
        byUser = new Map();
        refusedHeld.set(instance, byUser);
      }
      byUser.set(userId, presented);
    },
    forgetHeldRefused: (userId, hostId) => {
      refusedHeld.get(hosts.currentInstance(hostId))?.delete(userId);
    },
    heldRefused: (userId, hostId) => {
      const refused = refusedHeld
        .get(hosts.currentInstance(hostId))
        ?.get(userId);
      return (
        refused !== undefined &&
        tokens.current(userId, hostId)?.token === refused
      );
    },
  };
}

/**
 * Whether authn has not answered a mint for the pair, so no dial waits on it:
 * none has answered in this process (none started, one pending, or none since
 * the last success, whose token then runs out while its renewal is pending),
 * the era moved under it (`superseded`), authn could not be reached
 * (`unavailable`), or the window holds a sign-in authn has not confirmed yet
 * (`no-sign-in`: an app started or restarted while authn could not be reached,
 * whose session is still unverified). Asked only where the caller holds the
 * person's sign-in lease, so `no-sign-in` never means signed out here. Only a
 * refusal authn sent ends it. Never before the stored tokens are read: until
 * then no token is known to be missing, so nothing is presented or probed.
 */
export function authnDidNotAnswer(
  tokens: TrackedHostTokens,
  userId: string,
  hostId: string,
): boolean {
  if (!tokens.loaded()) return false;
  const failure = tokens.lastFailure(userId, hostId);
  return (
    failure === null ||
    failure === "superseded" ||
    failure === "unavailable" ||
    failure === "no-sign-in"
  );
}

/**
 * The held host-only token a local door presents whatever its age while authn
 * has not answered a mint (see {@link authnDidNotAnswer}): never after authn
 * refused one, and never once the host refused that token as expired. The
 * token is kept on disk, so this holds across an app restart. The host admits
 * one past its end while it cannot reach authn either; once a mint succeeds,
 * the fresh token is presented.
 */
export function heldWhileAuthnUnreachable(
  tokens: TrackedHostTokens,
  userId: string,
  hostId: string,
): HostToken | null {
  return authnDidNotAnswer(tokens, userId, hostId) &&
    !tokens.heldRefused(userId, hostId)
    ? tokens.current(userId, hostId)
    : null;
}

/** Where a failed mint's state goes. */
export type HostTokenStateSink = (
  hostId: string,
  kind: HostDoorStateKind,
) => void;

/**
 * Whether a caller that asked for a mint is still live: a subscription that
 * closed, or a call that was aborted, is not, and a shared client that merely
 * stays open is no caller. A mint's state is reported only while its caller
 * is live; callers that join one mint each report on their own, so it shows
 * while any of them is live.
 */
export type MintCaller = () => boolean;

/** For a read made on no caller's behalf: a mint it starts reports nothing. */
export const NO_MINT_CALLER: MintCaller = () => false;

const ALWAYS_LIVE: MintCaller = () => true;

// A mint's report: delivered only while the process instance it started under
// is still the host's and a caller that asked for it is live.
function mintReport(
  onState: HostTokenStateSink,
  hosts: HostInstanceOwners,
  owner: HostInstance,
  caller: MintCaller,
): HostTokenStateSink {
  return (hostId, kind) => {
    if (hosts.isCurrent(owner) && caller()) onState(hostId, kind);
  };
}

// A token is held and past its end: one the host refused as expired reads the
// same as the stream's recovery reads it, never as no token at all.
function holdsExpiredToken(
  tokens: TrackedHostTokens,
  userId: string,
  hostId: string,
): boolean {
  const held = tokens.current(userId, hostId);
  return held !== null && !isUsableHostToken(held, Date.now());
}

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

// The held token goes as it is: usable by this clock and not refused by the host.
function presentsHeldAsIs(
  tokens: TrackedHostTokens,
  userId: string,
  hostId: string,
): boolean {
  return (
    !tokens.heldRefused(userId, hostId) &&
    isUsableHostToken(tokens.current(userId, hostId), Date.now())
  );
}

// Starts a mint for the host's current instance, read as the dial or call asks
// for its credential: the attempt's own. Its failure is
// reported through `mintReport`, unless a held token is still presented after
// it. A held token the host refused is replaced however usable it reads: a
// mint that is not fresh would hand it back.
function mintInBackground(
  tokens: TrackedHostTokens,
  userId: string,
  hostId: string,
  onState: HostTokenStateSink,
  caller: MintCaller,
): Promise<HostTokenMintOutcome> {
  const owner = tokens.hosts.currentInstance(hostId);
  const report = mintReport(onState, tokens.hosts, owner, caller);
  const minted = tokens.obtain(
    userId,
    hostId,
    tokens.heldRefused(userId, hostId),
    { signal: null, owner },
  );
  void minted.then(
    (outcome) => {
      if (outcome.kind === "ok") return;
      if (heldWhileAuthnUnreachable(tokens, userId, hostId) !== null) return;
      const state = stateOfFailedMint(
        outcome,
        holdsExpiredToken(tokens, userId, hostId),
      );
      if (state !== null) report(hostId, state);
    },
    () => undefined,
  );
  return minted;
}

// Never the sign-in token. One lease object per sign-in lease: transports keyed
// on it see a new object exactly when the sign-in context changes. Local doors
// only. `null` only when no token can be presented: the stream then probes
// while authn has not answered, and never waits on the mint. Before the stored
// tokens are read it is `null` too, and the stream waits out its reconnect.
//
// Asked with the host the stream's socket was selected for: `hostId`'s token goes
// only to `hostId`, and any other host is answered `null`. A held token the host
// refused counts as none. `caller` is the stream session the read is for.
export function hostTokenBearer(
  tokens: TrackedHostTokens,
  signIn: BearerSourceProvider,
  hostId: string,
  onState: HostTokenStateSink,
): (
  selectedHostId: string,
  caller: MintCaller,
) => OpenFrameBearerSource | null {
  const leases = new WeakMap<OpenFrameBearerSource, OpenFrameBearerSource>();
  return (selectedHostId, caller) => {
    if (selectedHostId !== hostId) return null;
    const signInLease = signIn();
    if (signInLease === null) return null;
    const userId = signInLease.identity.userId;
    if (!presentsHeldAsIs(tokens, userId, hostId)) {
      void mintInBackground(tokens, userId, hostId, onState, caller);
      if (heldWhileAuthnUnreachable(tokens, userId, hostId) === null)
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
 * `WsRpcClientOptions.hostBearerFor` for a local door. A usable token goes at
 * once. With `waitForMint` false (before any dial) so does a held one of any
 * age while authn has not answered, with the mint in the background, and the
 * next call reads whatever it buys; with none, the mint starts and the answer
 * is `null` at once (the call probes). `true` is asked only after a current
 * host named its reason for the probe: the mint is awaited, and only a token
 * it bought is presented. Either waits first for the stored tokens to be
 * read, a local wait. A held token the host refused counts as none. The call
 * is the mint's caller: nothing is reported once `callSignal` is aborted.
 */
export function hostTokenBearerFor(
  tokens: TrackedHostTokens,
  onState: HostTokenStateSink,
): (
  hostId: string,
  signIn: OpenFrameBearerSource,
  waitForMint: boolean,
  callSignal: AbortSignal,
) => Promise<OpenFrameBearerSource | null> {
  return async (hostId, signIn, waitForMint, callSignal) => {
    if (!tokens.loaded()) await tokens.whenLoaded();
    const userId = signIn.identity.userId;
    const lease: OpenFrameBearerSource = {
      identity: { userId },
      getBearerToken: () => tokens.current(userId, hostId)?.token ?? "",
    };
    if (presentsHeldAsIs(tokens, userId, hostId)) return lease;
    const minted = mintInBackground(
      tokens,
      userId,
      hostId,
      onState,
      () => !callSignal.aborted,
    );
    if (!waitForMint)
      return heldWhileAuthnUnreachable(tokens, userId, hostId) === null
        ? null
        : lease;
    return (await minted).kind === "ok" ? lease : null;
  };
}

// A relay redials with the token its attach grant brings, so a session's bound
// lasts until its open is admitted; a unary call's holds the token minted after the
// last refusal until the host answers a call that started with it.
interface ReplacementBound {
  readonly final: (userId: string, held: string | null) => boolean;
  readonly retried: (userId: string, minted: string | null) => void;
}

function untilAdmittedBound(): ReplacementBound {
  let retried = false;
  return {
    final: () => retried,
    retried: () => {
      retried = true;
    },
  };
}

function sameTokenBound(): ReplacementBound & {
  readonly admitted: (userId: string, token: string) => void;
} {
  let minted: { readonly userId: string; readonly token: string } | null = null;
  return {
    final: (userId, held) =>
      held !== null && minted?.userId === userId && held === minted.token,
    retried: (userId, token) => {
      minted = token === null ? null : { userId, token };
    },
    admitted: (userId, token) => {
      if (minted?.userId === userId && minted.token === token) minted = null;
    },
  };
}

interface ReplacementBounds {
  readonly expiry: ReplacementBound;
  readonly notAdmitted: ReplacementBound;
  /**
   * Refreshes the sign-in, asked because authn refused it on a mint, or `null`
   * when the budget allows none. A session's dial sequence spends at most one
   * refresh that authn answered (rotated or refused), until an admission, and
   * a caller that asks while one runs joins it and shares its outcome; each
   * unary recovery spends its own.
   */
  readonly refreshSignIn: (
    recovery: StreamAuthRevalidator,
  ) => Promise<RevalidateOutcome> | null;
}

type HostTokenRevalidatorDeps = {
  readonly tokens: Pick<HostTokenAccess, "current" | "obtain">;
  /** Whose mints these are: the host's instance when a recovery starts. */
  readonly hosts: HostInstanceOwners;
  /** Who is signed in now; read for their id, never their credential. */
  readonly currentUserId: () => string | null;
  readonly hostId: string;
  readonly signInRecovery: StreamAuthRevalidator | null;
  readonly onState: HostTokenStateSink;
  readonly now: () => number;
};

const NOTHING_TO_RELEASE: DoorAdmissionRelease = () => undefined;

/** A remote session's: its door is `deps.hostId`'s. */
export function hostTokenSessionAuth(
  deps: HostTokenRevalidatorDeps,
  door: HostDoorObserver | null,
): {
  readonly auth: HostTokenSessionRevalidator;
  readonly door: HostDoorObserver;
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
        return door?.admitted() ?? NOTHING_TO_RELEASE;
      },
    },
  };
}

/**
 * A local stream's: its door hears which host each answer came from, and only
 * `deps.hostId`'s admission resets the recovery's bounds for that host. Its
 * recovery is built per stream session, the caller of every mint it starts;
 * every session of the client shares one set of bounds.
 */
export function hostTokenStreamAuth(
  deps: HostTokenRevalidatorDeps,
  door: StreamDoorObserver | null,
): {
  readonly auth: (caller: MintCaller) => HostTokenRevalidator;
  readonly door: StreamDoorObserver;
} {
  const recovery = boundedRecovery(deps);
  return {
    auth: recovery.forCaller,
    door: {
      refused: (details, hostId) => {
        door?.refused(details, hostId);
      },
      admitted: (hostId) => {
        if (hostId === deps.hostId) recovery.admitted();
        return door?.admitted(hostId) ?? NOTHING_TO_RELEASE;
      },
    },
  };
}

// Keyed on `doorReason`, never on its code; a host's refusal never starts sign-in
// recovery (only authn's 401 on the mint reaches `signInRecovery`). Build it through
// `hostTokenSessionAuth`, or its bounds never reset. Its reports go to
// `deps.onState` whoever is still waiting: its owner fences them itself.
export function hostTokenRevalidator(
  deps: HostTokenRevalidatorDeps,
): HostTokenSessionRevalidator {
  const recovery = boundedRecovery(deps);
  return { ...recovery.forCaller(ALWAYS_LIVE), admitted: recovery.admitted };
}

// A session's recovery sequence: its bounds and its sign-in refresh, until an
// admission replaces it. A recovery writes only to the sequence it started in,
// so a late refresh never spends a newer sequence, and a newer sequence never
// joins it: its own refresh joins at the sign-in's revalidator.
function recoverySequence(): ReplacementBounds {
  let spent = false;
  let running: Promise<RevalidateOutcome> | null = null;
  return {
    expiry: untilAdmittedBound(),
    notAdmitted: untilAdmittedBound(),
    refreshSignIn: (recovery) => {
      if (running !== null) return running;
      if (spent) return null;
      const refresh = recovery
        .revalidateForReconnect()
        .then((outcome) => {
          // A refresh that never reached authn spends nothing.
          if (outcome !== "network-error") spent = true;
          return outcome;
        })
        .finally(() => {
          if (running === refresh) running = null;
        });
      running = refresh;
      return refresh;
    },
  };
}

function boundedRecovery(deps: HostTokenRevalidatorDeps): {
  readonly forCaller: (caller: MintCaller) => HostTokenRevalidator;
  readonly admitted: () => void;
} {
  let sequence = recoverySequence();
  return {
    forCaller: (caller) => revalidatorWithBounds(deps, () => sequence, caller),
    admitted: () => {
      sequence = recoverySequence();
    },
  };
}

// Each recovery takes the bounds current when it starts and the host's current
// instance as its mints' owner; every state it reports is for `caller` and
// that owner, and dropped once either is gone.
function revalidatorWithBounds(
  deps: HostTokenRevalidatorDeps,
  boundsNow: () => ReplacementBounds,
  caller: MintCaller,
): HostTokenRevalidator {
  const mintFresh = async (
    userId: string,
    signInRetried: boolean,
    eraRetried: boolean,
    bounds: ReplacementBounds,
    owner: HostInstance,
    report: HostTokenStateSink,
  ): Promise<RevalidateOutcome> => {
    const held = deps.tokens.current(userId, deps.hostId);
    const outcome = await deps.tokens.obtain(userId, deps.hostId, true, {
      signal: null,
      owner,
    });
    if (outcome.kind === "ok") return "rotated";
    if (outcome.kind === "no-sign-in") return "network-error";
    // The era ended: only the same person, signed in again, gets one more ask.
    if (outcome.kind === "superseded")
      return !eraRetried && deps.currentUserId() === userId
        ? mintFresh(userId, signInRetried, true, bounds, owner, report)
        : "rejected";
    if (outcome.kind === "sign-in-rejected") {
      if (signInRetried || deps.signInRecovery === null) return "rejected";
      const refresh = bounds.refreshSignIn(deps.signInRecovery);
      if (refresh === null) return "rejected";
      const recovered = await refresh;
      return recovered === "rotated"
        ? mintFresh(userId, true, eraRetried, bounds, owner, report)
        : recovered;
    }
    const state = stateOfFailedMint(
      outcome,
      held !== null && !isUsableHostToken(held, deps.now()),
    );
    if (state !== null) report(deps.hostId, state);
    return outcome.kind === "unavailable" ? "network-error" : "rejected";
  };

  const recover = async (
    userId: string,
    refusal: FatalErrorDetails | null,
  ): Promise<RevalidateOutcome> => {
    const bounds = boundsNow();
    const owner = deps.hosts.currentInstance(deps.hostId);
    const report = mintReport(deps.onState, deps.hosts, owner, caller);
    const mint = (): Promise<RevalidateOutcome> =>
      mintFresh(userId, false, false, bounds, owner, report);
    if (refusal === null) return mint();
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
      const outcome = await mint();
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
        // The host refused a freshly minted token too. Its sink decides
        // whether that shows: the app's raises nothing while a connection to
        // that host is admitted.
        report(deps.hostId, "not-admitted");
        return "rejected";
      }
      const outcome = await mint();
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
  readonly tokens: Pick<HostTokenAccess, "current" | "obtain">;
  readonly hosts: HostInstanceOwners;
  readonly currentUserId: () => string | null;
  readonly signInRecovery: StreamAuthRevalidator | null;
  readonly onState: HostTokenStateSink;
  readonly now: () => number;
}): Required<
  Pick<RefusalAwareAuthRevalidator, "revalidateRefusedBearer" | "admissionOf">
> {
  interface HostRecovery {
    // The call whose refusal it recovers is the caller of every mint it starts.
    readonly forCall: (callSignal: AbortSignal) => HostTokenRevalidator;
    readonly admitted: (userId: string, token: string) => void;
  }
  const byHost = new Map<string, HostRecovery>();
  const forHost = (hostId: string): HostRecovery => {
    let recovery = byHost.get(hostId);
    if (recovery === undefined) {
      const expiry = sameTokenBound();
      const notAdmitted = sameTokenBound();
      // A unary recovery is one call's: `signInRetried` bounds it to one.
      const bounds: ReplacementBounds = {
        expiry,
        notAdmitted,
        refreshSignIn: (signInRecovery) =>
          signInRecovery.revalidateForReconnect(),
      };
      recovery = {
        forCall: (callSignal) =>
          revalidatorWithBounds(
            { ...deps, hostId },
            () => bounds,
            () => !callSignal.aborted,
          ),
        admitted: (userId, token) => {
          expiry.admitted(userId, token);
          notAdmitted.admitted(userId, token);
        },
      };
      byHost.set(hostId, recovery);
    }
    return recovery;
  };
  return {
    revalidateRefusedBearer: async (expected, hostId, refusal, callSignal) => {
      const userId = deps.currentUserId();
      if (userId === null) return "rejected";
      if (userId !== expected.identity.userId) return "superseded";
      if (refusal === null) return "rejected";
      return forHost(hostId).forCall(callSignal).revalidateRefused(refusal);
    },
    // Read as the call starts: a token minted while it ran is cleared only by a
    // call that starts with it.
    admissionOf: (expected, hostId) => {
      const userId = expected.identity.userId;
      const held = deps.tokens.current(userId, hostId)?.token ?? null;
      return () => {
        if (held !== null) byHost.get(hostId)?.admitted(userId, held);
      };
    },
  };
}
