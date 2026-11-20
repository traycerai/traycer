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
  releasedLocalSignOnFromRegistry,
  type ReleasedSignOn,
  processReleasedHosts,
} from "@traycer-clients/shared/host-transport/released-sign-on";
import { config } from "../config";
import {
  CREDENTIALS_LOCK_WAIT_MS,
  createCliCredentialsStore,
  createStoreBackedRevalidator,
} from "../store/credentials-store";
import type { CliError } from "../runner/errors";
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
 * Told of every mint for a host that no wait can turn into a token: authn
 * refused this person for that host, or refused the sign-in and its refresh,
 * or none is held.
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
 */
export interface CliHostTokens {
  /** The token on disk, else one mint; a refused sign-in is refreshed once first. */
  bearerFor(hostId: string, signal: AbortSignal | null): Promise<CliHostBearer>;
  /** A fresh token whatever is on disk: `traycer login`'s. */
  mintFresh(hostId: string, signal: AbortSignal | null): Promise<CliHostBearer>;
  /** Unary recovery for calls to `hostId`, read from the host's refusal. */
  unaryRecovery(hostId: string): RefusalAwareAuthRevalidator;
  /** `admitted` hears every admitted open, so a second refusal is final only between two admissions. */
  streamRecovery(hostId: string): HostTokenSessionRevalidator;
  /**
   * `null` while one is minted, or while authn cannot be reached, which the transport
   * waits out; one refused for good goes to {@link onMintRefused}'s listeners.
   */
  streamBearer(hostId: string): BearerSourceProvider;
  /**
   * Tells `listener` of every mint refused for good from now on, the ones a
   * stream's recovery makes among them, until the returned stop is called.
   */
  onMintRefused(listener: CliMintRefusalListener): () => void;
  /**
   * Authn refused the refresh, or a mint again right after an accepted refresh. Until
   * then a refused mint is the sign-in recovering.
   */
  signInRejected(): boolean;
  /** The stored sign-in's refresh ahead of its expiry, judged as above. */
  refreshSignIn(): Promise<RevalidateOutcome>;
  /** `true` when one was minted; a mint refused for good reaches the listeners like any other. */
  renewAfterSignInRefresh(hostId: string): Promise<boolean>;
  /** The held token is presented past its end: authn could not be reached for a new one. */
  presentsHeldPastExpiry(hostId: string): boolean;
  /** See `hostTokenUnobtainable`. */
  hostTokenUnobtainable(hostId: string): boolean;
  /** See `ownerSignInEligible`. */
  ownerSignInEligible(hostId: string): boolean;
  /** See `ReleasedSignOn.heldTokenRefused`. */
  heldTokenRefused(hostId: string): boolean;
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
  const report = (hostId: string, failure: CliHostTokenFailure): void => {
    for (const listener of listeners) listener(hostId, failure);
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
    obtain: async (id, hostId, fresh, signal) => {
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
      if (isHostRefusal(outcome)) report(hostId, outcome);
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

  const streamBearers = new Map<string, BearerSourceProvider>();
  const minting = new Set<string>();

  // Refreshed once and asked once more. Only a refused refresh or a second 401 rejects
  // the sign-in; an unreachable refresh leaves it unjudged.
  const recoverRefusedSignIn = async (
    hostId: string,
    first: CliHostTokenFailure,
    signal: AbortSignal | null,
  ): Promise<CliHostBearer> => {
    const refreshed = await refreshSignIn();
    if (refreshed === "network-error")
      return answer(hostId, {
        kind: "unavailable",
        detail: "sign-in refresh unavailable",
      });
    if (refreshed === "rejected") {
      report(hostId, first);
      return answer(hostId, first);
    }
    const second = await source.obtain(userId, hostId, true, signal);
    if (second.kind === "sign-in-rejected") report(hostId, second);
    return answer(hostId, second);
  };

  const obtain = async (
    hostId: string,
    fresh: boolean,
    signal: AbortSignal | null,
  ): Promise<CliHostBearer> => {
    const first = await source.obtain(userId, hostId, fresh, signal);
    // `traycer login` asks for a fresh token, and only a fresh one will do.
    if (!fresh && presentsHeld(hostId))
      return { kind: "ok", bearer: bearerOf(hostId) };
    if (first.kind === "no-sign-in") report(hostId, first);
    if (first.kind !== "sign-in-rejected") return answer(hostId, first);
    return recoverRefusedSignIn(hostId, first, signal);
  };

  return {
    bearerFor: (hostId, signal) => obtain(hostId, false, signal),
    mintFresh: (hostId, signal) => obtain(hostId, true, signal),
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
    streamBearer: (hostId) => {
      let provider = streamBearers.get(hostId);
      if (provider === undefined) {
        // One lease object per host, read afresh on every frame.
        const lease = bearerOf(hostId);
        provider = () => {
          if (isUsableHostToken(source.current(userId, hostId), Date.now()))
            return lease;
          const held = presentsHeld(hostId);
          if (!minting.has(hostId)) {
            minting.add(hostId);
            void obtain(hostId, false, null)
              .then(
                () => undefined,
                () => undefined,
              )
              .finally(() => minting.delete(hostId));
          }
          return held ? lease : null;
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
    heldTokenRefused: (hostId) => heldTokenRefused(source, userId, hostId),
    onMintRefused: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    // Once per refresh, through the reporting source. A 401 on the first mint after an
    // accepted refresh is a rejected sign-in; one another mint got to first recovers as any 401.
    renewAfterSignInRefresh: async (hostId) => {
      const renewed = await source.obtain(userId, hostId, true, signIn.signal);
      if (renewed.kind === "no-sign-in") report(hostId, renewed);
      if (renewed.kind !== "sign-in-rejected") return renewed.kind === "ok";
      if (refusedAfterRefresh) {
        report(hostId, renewed);
        return false;
      }
      return (await recoverRefusedSignIn(hostId, renewed, null)).kind === "ok";
    },
  };
}

export interface CliHostSession {
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

/** The stored sign-in, refreshed under the credentials lock, for `releasedLocalSignOnFromRegistry`. */
export function cliReleasedSignOn(
  authnBaseUrl: string,
  hostId: () => string | null,
  lease: BearerLease,
  tokens: Pick<
    CliHostTokens,
    | "refreshSignIn"
    | "hostTokenUnobtainable"
    | "ownerSignInEligible"
    | "heldTokenRefused"
  >,
): ReleasedSignOn {
  return releasedLocalSignOnFromRegistry({
    authnBaseUrl,
    hostId,
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
    heldTokenRefused: () => {
      const id = hostId();
      return id !== null && tokens.heldTokenRefused(id);
    },
    hosts: processReleasedHosts,
  });
}

export type CliHostSessionResult =
  | { readonly kind: "ok"; readonly session: CliHostSession }
  | { readonly kind: "failed"; readonly failure: CliHostTokenFailure };

/**
 * Disposed when its command ends, so a refresh's timer never outlives it. `signal`
 * ends every mint and the refresh's lock wait and request; an aborted refresh writes
 * nothing, and the armed marker settles a refresh token it may have spent.
 */
export async function openCliHostSession(
  auth: HostAuth,
  hostId: string,
  fresh: boolean,
  signal: AbortSignal | null,
): Promise<CliHostSessionResult> {
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
  const pending = fresh
    ? tokens.mintFresh(hostId, signal)
    : tokens.bearerFor(hostId, signal);
  const held = await pending.catch((error: unknown) => {
    store.dispose();
    throw error;
  });
  const releasedSignOn = cliReleasedSignOn(
    auth.authnBaseUrl,
    () => hostId,
    lease,
    tokens,
  );
  // No token can be presented: a released CLI opened this machine's host with
  // the sign-in, so the session goes on with an empty token, which the
  // transports answer with the sign-in where `releasedSignOn` allows it.
  const signInOnly =
    held.kind === "failed" &&
    !fresh &&
    tokens.hostTokenUnobtainable(hostId) &&
    (await releasedSignOn.allowed().catch(() => false));
  if (held.kind === "failed" && !signInOnly) {
    store.dispose();
    return { kind: "failed", failure: held.failure };
  }
  return {
    kind: "ok",
    session: {
      bearer:
        held.kind === "ok"
          ? held.bearer
          : { identity: { userId: auth.userId }, getBearerToken: () => "" },
      signInLease: lease,
      tokens,
      releasedSignOn,
      dispose: () => store.dispose(),
    },
  };
}

export async function requireCliHostSession(
  auth: HostAuth,
  hostId: string,
  toError: (failure: CliHostTokenFailure) => CliError,
): Promise<CliHostSession> {
  const result = await openCliHostSession(auth, hostId, false, null);
  if (result.kind === "failed") throw toError(result.failure);
  return result.session;
}

export async function forgetCliHostTokens(userId: string): Promise<void> {
  await createSource(null).forgetUser(userId);
}
