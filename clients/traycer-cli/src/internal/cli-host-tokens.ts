import {
  MutableBearerLease,
  readLeaseBearer,
  type BearerLease,
  type BearerSourceProvider,
  type OpenFrameBearerSource,
} from "@traycer-clients/shared/auth/bearer-source";
import type {
  RefusalAwareAuthRevalidator,
  RevalidateOutcome,
} from "@traycer-clients/shared/auth/bearer-revalidator";
import { createHostTokenFilePersistence } from "@traycer-clients/shared/auth/host-token-file";
import {
  heldWhileAuthnUnreachable,
  hostTokenRevalidator,
  trackHostTokenMints,
  type HostTokenSessionRevalidator,
} from "@traycer-clients/shared/auth/host-token-lease";
import {
  createHostTokenSource,
  type HostTokenMintOutcome,
  type HostTokenSource,
  type VerifiedSignIn,
} from "@traycer-clients/shared/auth/host-token-source";
import { isUsableHostToken } from "@traycer-clients/shared/auth/host-token-store";
import { mintHostTokenViaHttp } from "@traycer-clients/shared/host-transport/remote/grant-client";
import {
  heldTokenRefused,
  hostTokenUnobtainable,
  ownerSignInEligible,
  type ReleasedSignOn,
  processReleasedHosts,
} from "@traycer-clients/shared/host-transport/released-sign-on";
import { config } from "../config";
import {
  CREDENTIALS_LOCK_WAIT_MS,
  createCliCredentialsStore,
  createStoreBackedRevalidator,
} from "../store/credentials-store";
import type { HostAuth } from "./host-auth";

const LOCK_POLL_INTERVAL_MS = 50;

export interface CliSignIn {
  readonly lease: BearerLease;
  /** Refreshes the sign-in under the credentials lock and rotates `lease`. */
  readonly refresh: () => Promise<RevalidateOutcome>;
  /** Cancels this process's own mints, so an abandoned one cannot hold the CLI open; `null` lives as long as the command. */
  readonly signal: AbortSignal | null;
}

export interface SignInRevalidator {
  revalidateCurrentContext(): Promise<RevalidateOutcome>;
}

/** Why no host-only token could be had: authn's answer, after any one refresh. */
export type CliHostTokenFailure = Exclude<
  HostTokenMintOutcome,
  { readonly kind: "ok" }
>;

/**
 * Told of a mint refusal that ends a command dialing this machine's host (see
 * `CliHostTokens.onRefusalEndingCommand`).
 */
export type CliMintRefusalListener = (
  hostId: string,
  failure: CliHostTokenFailure,
) => void;

/** authn's answers about the host that a later mint would repeat. */
function isHostRefusal(
  outcome: HostTokenMintOutcome,
): outcome is Extract<
  CliHostTokenFailure,
  { readonly kind: "not-a-member" | "not-admitted" | "sandbox-frozen" }
> {
  return (
    outcome.kind === "not-a-member" ||
    outcome.kind === "not-admitted" ||
    outcome.kind === "sandbox-frozen"
  );
}

export type CliHostBearer =
  | { readonly kind: "ok"; readonly bearer: OpenFrameBearerSource }
  | { readonly kind: "failed"; readonly failure: CliHostTokenFailure };

/**
 * The only credential this CLI presents to a host. Kept in `host-tokens` beside the
 * credentials file, under its lock, shared with the desktop. authn is asked only when
 * none is held or it ran out, at `traycer login`, and once after a sign-in refresh.
 * No dial waits for a mint authn has not answered.
 */
export interface CliHostTokens {
  /** Settles once the tokens on disk are read; nothing is minted. Await it before the first dial. */
  whenLoaded(): Promise<void>;
  /** A fresh token whatever is on disk: `traycer login`'s. */
  mintFresh(hostId: string, signal: AbortSignal | null): Promise<CliHostBearer>;
  /**
   * `WsRpcClientOptions.hostBearerFor` for `hostId`: a usable token at once.
   * With `waitForMint` false, a held one of any age while authn has not
   * answered, else `null` (the call probes), at once, with the mint in the
   * background. With `true` (asked only after a current host named its reason
   * for the probe), only a token the awaited mint bought.
   */
  hostBearerFor(
    hostId: string,
    waitForMint: boolean,
  ): Promise<OpenFrameBearerSource | null>;
  /** One lease per host, reading the held token on every frame: empty while none is held. */
  lease(hostId: string): OpenFrameBearerSource;
  /** Unary recovery for calls to `hostId`, read from the host's refusal. */
  unaryRecovery(hostId: string): RefusalAwareAuthRevalidator;
  /** Recovery of a stream's refused token; {@link admitted} resets its bounds. */
  streamRecovery(hostId: string): HostTokenSessionRevalidator;
  /**
   * The host admitted an open: a second refusal is final only between two
   * admissions, and a `not-admitted` of a mint begun before now ends nothing.
   */
  admitted(hostId: string): void;
  /**
   * A usable token, or a held one of any age while authn has not answered;
   * else `null`, and the transport probes while authn has not answered. Every
   * ask without a usable token starts a mint in the background.
   */
  streamBearer(hostId: string): BearerSourceProvider;
  /**
   * Tells `listener` of every mint refusal that ends the command, the ones a
   * recovery makes among them, until the returned stop is called. One rule for
   * every command: `not-a-member`, `sandbox-frozen`, a `sign-in-rejected` its
   * refresh could not answer, and `no-sign-in` end it at once. `not-admitted` (authn has no
   * row) ends it only when no sign-in can follow: the host named a reason in
   * this process, or declined this person's probe. It ends nothing once the
   * host admitted an open at or after that mint started, and otherwise waits
   * in {@link deferredNotAdmitted}; the next mint is judged again.
   */
  onRefusalEndingCommand(listener: CliMintRefusalListener): () => void;
  /** The `not-admitted` the command went on past, while no open was admitted after its mint started. */
  deferredNotAdmitted(hostId: string): CliHostTokenFailure | null;
  /**
   * Authn refused the refresh, or a mint again right after an accepted refresh. Until
   * then a refused mint is the sign-in recovering.
   */
  signInRejected(): boolean;
  /** The stored sign-in's refresh ahead of its expiry, judged as above. */
  refreshSignIn(): Promise<RevalidateOutcome>;
  /** `true` when one was minted; its refusal is judged like any other mint's. */
  renewAfterSignInRefresh(hostId: string): Promise<boolean>;
  /** The held token is presented past its end: authn could not be reached for a new one. */
  presentsHeldPastExpiry(hostId: string): boolean;
  /** See `hostTokenUnobtainable`. */
  hostTokenUnobtainable(hostId: string): boolean;
  /** See `ownerSignInEligible`. */
  ownerSignInEligible(hostId: string): boolean;
  /** See `ReleasedSignOn.heldTokenRefused`. */
  heldTokenRefused(hostId: string, presented: string): boolean;
  /** See `ReleasedSignOn.forgetHeldRefusal`. */
  forgetHeldRefusal(hostId: string): void;
}

function createSource(signIn: VerifiedSignIn | null): HostTokenSource {
  return createHostTokenSource({
    persistence: createHostTokenFilePersistence({
      environment: config.environment,
      lockWaitMs: CREDENTIALS_LOCK_WAIT_MS,
      lockPollIntervalMs: LOCK_POLL_INTERVAL_MS,
    }),
    mint: (hostId, signInToken, signal) =>
      mintHostTokenViaHttp(config.authnBaseUrl, hostId, signInToken, signal),
    signIn,
    now: Date.now,
  });
}

export function createCliHostTokens(signIn: CliSignIn): CliHostTokens {
  const userId = signIn.lease.identity.userId;
  const listeners = new Set<CliMintRefusalListener>();
  // When each host last admitted an open, and the `not-admitted` the command
  // went on past with when its mint started.
  const admittedAt = new Map<string, number>();
  const deferred = new Map<
    string,
    { readonly failure: CliHostTokenFailure; readonly startedAt: number }
  >();
  const admittedSince = (hostId: string, startedAt: number): boolean =>
    (admittedAt.get(hostId) ?? Number.NEGATIVE_INFINITY) >= startedAt;
  const endsCommand = (
    hostId: string,
    failure: CliHostTokenFailure,
    startedAt: number,
  ): boolean => {
    if (failure.kind !== "not-admitted") return true;
    if (admittedSince(hostId, startedAt)) return false;
    if (
      processReleasedHosts.namedReason(hostId) ||
      processReleasedHosts.probeDeclined(userId, hostId)
    )
      return true;
    deferred.set(hostId, { failure, startedAt });
    return false;
  };
  const report = (
    hostId: string,
    failure: CliHostTokenFailure,
    startedAt: number,
  ): void => {
    if (!endsCommand(hostId, failure, startedAt)) return;
    for (const listener of Array.from(listeners)) listener(hostId, failure);
  };
  const stored = createSource((id) =>
    id === userId ? readLeaseBearer(signIn.lease) : null,
  );
  // The one judge of a rejected sign-in, for every mint this process makes:
  // a refresh authn refused, or a 401 on the first mint after a refresh it
  // accepted. A token minted, or a refresh accepted, starts it again.
  let refreshRefused = false;
  let refreshedSinceLastMint = false;
  let refusedAfterRefresh = false;
  const refreshSignIn = async (): Promise<RevalidateOutcome> => {
    const outcome = await signIn.refresh();
    if (outcome === "rejected") refreshRefused = true;
    if (outcome === "rotated") {
      refreshRefused = false;
      refusedAfterRefresh = false;
      refreshedSinceLastMint = true;
    }
    return outcome;
  };
  // Every mint passes here, so a refusal for good is reported wherever asked. A token
  // that could not be saved is transient like an unreachable authn, never a rejected
  // sign-in. A mint with no signal of its own is cancelled with this process's mints.
  const source = trackHostTokenMints({
    current: (id, hostId) => stored.current(id, hostId),
    loaded: () => stored.loaded(),
    whenLoaded: () => stored.whenLoaded(),
    obtain: async (id, hostId, fresh, signal) => {
      const startedAt = Date.now();
      const outcome: HostTokenMintOutcome = await stored
        .obtain(id, hostId, fresh, signal ?? signIn.signal)
        .catch((): HostTokenMintOutcome => ({
          kind: "unavailable",
          detail: "host-only token not saved",
        }));
      if (outcome.kind === "sign-in-rejected" && refreshedSinceLastMint)
        refusedAfterRefresh = true;
      if (outcome.kind === "ok") refusedAfterRefresh = false;
      refreshedSinceLastMint = false;
      if (isHostRefusal(outcome)) report(hostId, outcome, startedAt);
      return outcome;
    },
  });
  const signInRejected = (): boolean => refreshRefused || refusedAfterRefresh;
  const signInRecovery = {
    revalidateForReconnect: refreshSignIn,
  };
  const bearerOf = (hostId: string): OpenFrameBearerSource => ({
    identity: { userId },
    getBearerToken: () => source.current(userId, hostId)?.token ?? "",
  });
  const presentsHeld = (hostId: string): boolean =>
    heldWhileAuthnUnreachable(source, userId, hostId) !== null;
  const answer = (
    hostId: string,
    outcome: HostTokenMintOutcome,
  ): CliHostBearer =>
    outcome.kind === "ok"
      ? { kind: "ok", bearer: bearerOf(hostId) }
      : { kind: "failed", failure: outcome };
  // A command presents whatever this process may hold, and keeps no state
  // of the door's: it ends with the refusal it was given.
  const onState = (): void => undefined;
  // One per host: each remembers the token it minted after the host's last
  // refusal, which is what makes a second refusal final.
  const recoveries = new Map<string, HostTokenSessionRevalidator>();
  const streamRecovery = (hostId: string): HostTokenSessionRevalidator => {
    let recovery = recoveries.get(hostId);
    if (recovery === undefined) {
      recovery = hostTokenRevalidator({
        tokens: source,
        currentUserId: () => userId,
        hostId,
        signInRecovery,
        onState,
        now: Date.now,
      });
      recoveries.set(hostId, recovery);
    }
    return recovery;
  };

  // One lease object per host, read afresh on every frame.
  const leases = new Map<string, OpenFrameBearerSource>();
  const leaseOf = (hostId: string): OpenFrameBearerSource => {
    let lease = leases.get(hostId);
    if (lease === undefined) {
      lease = bearerOf(hostId);
      leases.set(hostId, lease);
    }
    return lease;
  };
  const streamBearers = new Map<string, BearerSourceProvider>();

  // Refreshed once and asked once more. Only a refused refresh or a second 401 rejects
  // the sign-in; an unreachable refresh leaves it unjudged.
  const recoverRefusedSignIn = async (
    hostId: string,
    first: CliHostTokenFailure,
    firstStartedAt: number,
    signal: AbortSignal | null,
  ): Promise<CliHostBearer> => {
    const refreshed = await refreshSignIn();
    if (refreshed === "network-error")
      return answer(hostId, {
        kind: "unavailable",
        detail: "sign-in refresh unavailable",
      });
    if (refreshed === "rejected") {
      report(hostId, first, firstStartedAt);
      return answer(hostId, first);
    }
    const startedAt = Date.now();
    const second = await source.obtain(userId, hostId, true, signal);
    if (second.kind === "sign-in-rejected") report(hostId, second, startedAt);
    return answer(hostId, second);
  };

  const obtain = async (
    hostId: string,
    fresh: boolean,
    signal: AbortSignal | null,
  ): Promise<CliHostBearer> => {
    const startedAt = Date.now();
    const first = await source.obtain(userId, hostId, fresh, signal);
    if (first.kind === "no-sign-in") report(hostId, first, startedAt);
    if (first.kind !== "sign-in-rejected") return answer(hostId, first);
    return recoverRefusedSignIn(hostId, first, startedAt, signal);
  };

  // One background mint per host at a time, for the stream and the unary
  // asks alike; nothing that dials awaits it.
  const minting = new Map<string, Promise<CliHostBearer>>();
  const mintInBackground = (hostId: string): Promise<CliHostBearer> => {
    const running = minting.get(hostId);
    if (running !== undefined) return running;
    const started = obtain(hostId, false, null)
      .catch((): CliHostBearer => ({
        kind: "failed",
        failure: { kind: "unavailable", detail: "host-only token mint failed" },
      }))
      .finally(() => minting.delete(hostId));
    minting.set(hostId, started);
    return started;
  };

  return {
    whenLoaded: () => stored.whenLoaded(),
    lease: leaseOf,
    mintFresh: (hostId, signal) => obtain(hostId, true, signal),
    hostBearerFor: async (hostId, waitForMint) => {
      if (isUsableHostToken(source.current(userId, hostId), Date.now()))
        return leaseOf(hostId);
      const minted = mintInBackground(hostId);
      if (!waitForMint) return presentsHeld(hostId) ? leaseOf(hostId) : null;
      return (await minted).kind === "ok" ? leaseOf(hostId) : null;
    },
    unaryRecovery: (hostId) => {
      const recovery = streamRecovery(hostId);
      return {
        // The messenger asks this only when no refusal reached it: a token
        // already known to have run out.
        revalidateExpectedBearer: async (expected) =>
          expected.identity.userId === userId
            ? recovery.revalidateForReconnect()
            : "superseded",
        revalidateRefusedBearer: async (expected, _hostId, refusal) => {
          if (expected.identity.userId !== userId) return "superseded";
          // A refusal of this one call rather than at the door recovers
          // nothing: the call carried a token checked unexpired just before.
          if (refusal === null) return "rejected";
          return recovery.revalidateRefused(refusal);
        },
      };
    },
    streamRecovery,
    admitted: (hostId) => {
      admittedAt.set(hostId, Date.now());
      streamRecovery(hostId).admitted();
    },
    streamBearer: (hostId) => {
      let provider = streamBearers.get(hostId);
      if (provider === undefined) {
        const lease = leaseOf(hostId);
        provider = () => {
          if (isUsableHostToken(source.current(userId, hostId), Date.now()))
            return lease;
          void mintInBackground(hostId);
          return presentsHeld(hostId) ? lease : null;
        };
        streamBearers.set(hostId, provider);
      }
      return provider;
    },
    signInRejected,
    refreshSignIn,
    presentsHeldPastExpiry: presentsHeld,
    hostTokenUnobtainable: (hostId) =>
      hostTokenUnobtainable(source, userId, hostId),
    ownerSignInEligible: (hostId) =>
      ownerSignInEligible(source, userId, hostId),
    heldTokenRefused: (hostId, presented) =>
      heldTokenRefused(source, userId, hostId, presented),
    forgetHeldRefusal: (hostId) => source.forgetHeldRefused(userId, hostId),
    onRefusalEndingCommand: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    deferredNotAdmitted: (hostId) => {
      const held = deferred.get(hostId);
      return held === undefined || admittedSince(hostId, held.startedAt)
        ? null
        : held.failure;
    },
    // Once per refresh, through the reporting source. A 401 on the first mint after an
    // accepted refresh is a rejected sign-in; one another mint got to first recovers as any 401.
    renewAfterSignInRefresh: async (hostId) => {
      const startedAt = Date.now();
      const renewed = await source.obtain(userId, hostId, true, signIn.signal);
      if (renewed.kind === "no-sign-in") report(hostId, renewed, startedAt);
      if (renewed.kind !== "sign-in-rejected") return renewed.kind === "ok";
      if (refusedAfterRefresh) {
        report(hostId, renewed, startedAt);
        return false;
      }
      return (
        (await recoverRefusedSignIn(hostId, renewed, startedAt, null)).kind ===
        "ok"
      );
    },
  };
}

export interface CliHostSession {
  /** `tokens.lease` of this session's host. */
  readonly bearer: OpenFrameBearerSource;
  /**
   * The stored sign-in, for authn, and for a released host on this person's own
   * personal computer through {@link releasedSignOn}.
   */
  readonly signInLease: BearerLease;
  readonly tokens: CliHostTokens;
  /** This session's host's answer to a released host's refusal of the host-only token. */
  readonly releasedSignOn: ReleasedSignOn;
  dispose(): void;
}

/**
 * The stored sign-in, refreshed under the credentials lock, for this machine's
 * host. The CLI holds no row, and none is read: the sign-in goes only to a host
 * whose refusal in the same dial sequence showed the released level.
 */
export function cliReleasedSignOn(
  hostId: () => string | null,
  lease: BearerLease,
  tokens: Pick<
    CliHostTokens,
    | "refreshSignIn"
    | "hostTokenUnobtainable"
    | "ownerSignInEligible"
    | "heldTokenRefused"
    | "forgetHeldRefusal"
  >,
): ReleasedSignOn {
  return {
    signIn: () => (readLeaseBearer(lease) === null ? null : lease),
    recovery: { revalidateForReconnect: () => tokens.refreshSignIn() },
    hostTokenUnobtainable: () => {
      const id = hostId();
      return id !== null && tokens.hostTokenUnobtainable(id);
    },
    ownerSignInEligible: () => {
      const id = hostId();
      return id !== null && tokens.ownerSignInEligible(id);
    },
    heldTokenRefused: (presented) => {
      const id = hostId();
      return id !== null && tokens.heldTokenRefused(id, presented);
    },
    forgetHeldRefusal: () => {
      const id = hostId();
      if (id !== null) tokens.forgetHeldRefusal(id);
    },
    hosts: processReleasedHosts,
  };
}

export type CliHostSessionResult =
  | { readonly kind: "ok"; readonly session: CliHostSession }
  | { readonly kind: "failed"; readonly failure: CliHostTokenFailure };

/**
 * Disposed when its command ends, so a refresh's timer never outlives it. `signal`
 * ends every mint and the refresh's lock wait and request; an aborted refresh writes
 * nothing, and the armed marker settles a refresh token it may have spent.
 *
 * Opened once the tokens on disk are read, and nothing is minted first: its
 * dials present the held token at once, or probe with none, while the mint
 * runs in the background. A refusal that ends the command reaches
 * `tokens.onRefusalEndingCommand`, which every caller watches.
 */
export async function requireCliHostSession(
  auth: HostAuth,
  hostId: string,
  signal: AbortSignal | null,
): Promise<CliHostSession> {
  const lease = new MutableBearerLease(auth.token, auth.userId);
  const store = createCliCredentialsStore();
  // Typed to its own refresh: the shared `AuthRevalidator` it also satisfies
  // declares the same method as `Promise<unknown>`.
  const revalidator: SignInRevalidator = createStoreBackedRevalidator({
    store,
    lease,
    signal,
  });
  const tokens = createCliHostTokens({
    lease,
    refresh: () => revalidator.revalidateCurrentContext(),
    signal,
  });
  await tokens.whenLoaded();
  return {
    bearer: tokens.lease(hostId),
    signInLease: lease,
    tokens,
    releasedSignOn: cliReleasedSignOn(() => hostId, lease, tokens),
    dispose: () => store.dispose(),
  };
}

/**
 * Like {@link requireCliHostSession}; `fresh` (`traycer login`'s) also awaits a
 * fresh token, and fails with its refusal.
 */
export async function openCliHostSession(
  auth: HostAuth,
  hostId: string,
  fresh: boolean,
  signal: AbortSignal | null,
): Promise<CliHostSessionResult> {
  const session = await requireCliHostSession(auth, hostId, signal);
  if (!fresh) return { kind: "ok", session };
  const minted = await session.tokens
    .mintFresh(hostId, signal)
    .catch((error: unknown) => {
      session.dispose();
      throw error;
    });
  if (minted.kind === "ok") return { kind: "ok", session };
  session.dispose();
  return { kind: "failed", failure: minted.failure };
}

export async function forgetCliHostTokens(userId: string): Promise<void> {
  await createSource(null).forgetUser(userId);
}
