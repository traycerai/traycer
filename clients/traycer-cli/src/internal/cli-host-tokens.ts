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
  hostTokenRevalidator,
  type HostTokenAccess,
  type HostTokenRevalidator,
} from "@traycer-clients/shared/auth/host-token-lease";
import {
  createHostTokenSource,
  type HostTokenMintOutcome,
  type HostTokenSource,
  type VerifiedSignIn,
} from "@traycer-clients/shared/auth/host-token-source";
import { isUsableHostToken } from "@traycer-clients/shared/auth/host-token-store";
import { mintHostTokenViaHttp } from "@traycer-clients/shared/host-transport/remote/grant-client";
import { config } from "../config";
import {
  CREDENTIALS_LOCK_WAIT_MS,
  createCliCredentialsStore,
  createStoreBackedRevalidator,
} from "../store/credentials-store";
import type { CliError } from "../runner/errors";
import type { HostAuth } from "./host-auth";

const LOCK_POLL_INTERVAL_MS = 50;

/** The sign-in this process spends at authn, and the step that refreshes it. */
export interface CliSignIn {
  readonly lease: BearerLease;
  /** Refreshes the sign-in under the credentials lock and rotates `lease`. */
  readonly refresh: () => Promise<RevalidateOutcome>;
}

/** The stored sign-in's refresh under the credentials lock. */
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
 * refused this person for that host, or refused the sign-in and its refresh.
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
 * The CLI's host-only tokens: the only credential this CLI presents to a
 * host. They live in the `host-tokens` file beside the credentials file,
 * written under that file's lock and shared with the desktop on the same
 * machine. A command reads the token on disk and asks authn for nothing;
 * authn is asked only when none is held for the host or it has run out, at
 * `traycer login`, and once right after the sign-in itself was refreshed.
 *
 * The sign-in token is spent at authn only. Every use of the shared token
 * source is in this module.
 */
export interface CliHostTokens {
  /** The token on disk, else one mint; a refused sign-in is refreshed once first. */
  bearerFor(hostId: string): Promise<CliHostBearer>;
  /** A fresh token whatever is on disk: `traycer login`'s. */
  mintFresh(hostId: string): Promise<CliHostBearer>;
  /** Unary recovery for calls to `hostId`, read from the host's refusal. */
  unaryRecovery(hostId: string): RefusalAwareAuthRevalidator;
  /** A stream's recovery for `hostId`, read from the host's refusal. */
  streamRecovery(hostId: string): HostTokenRevalidator;
  /**
   * A long-lived stream's credential for `hostId`: the token on disk, or
   * `null` while one is minted, which the transport waits out. A mint that
   * cannot reach authn is waited out the same way; one refused for good goes
   * to {@link onMintRefused}'s listeners.
   */
  streamBearer(hostId: string): BearerSourceProvider;
  /**
   * Tells `listener` of every mint refused for good from now on, the ones a
   * stream's recovery makes among them, until the returned stop is called.
   */
  onMintRefused(listener: CliMintRefusalListener): () => void;
  /** One fresh token for `hostId` after the sign-in was refreshed. */
  renewAfterSignInRefresh(hostId: string): Promise<void>;
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
  // Every mint, a recovery's included, passes here, so a refusal for good is
  // reported wherever it was asked.
  const source: HostTokenAccess = {
    current: (id, hostId) => stored.current(id, hostId),
    obtain: async (id, hostId, fresh, signal) => {
      const outcome = await stored.obtain(id, hostId, fresh, signal);
      if (isHostRefusal(outcome)) report(hostId, outcome);
      return outcome;
    },
  };
  const signInRecovery = {
    revalidateForReconnect: (): Promise<RevalidateOutcome> => signIn.refresh(),
  };
  const bearerOf = (hostId: string): OpenFrameBearerSource => ({
    identity: { userId },
    getBearerToken: () => source.current(userId, hostId)?.token ?? "",
  });
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
  const recoveries = new Map<string, HostTokenRevalidator>();
  const streamRecovery = (hostId: string): HostTokenRevalidator => {
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

  const obtain = async (
    hostId: string,
    fresh: boolean,
  ): Promise<CliHostBearer> => {
    const first = await source.obtain(userId, hostId, fresh, null);
    if (first.kind === "no-sign-in") report(hostId, first);
    if (first.kind !== "sign-in-rejected") return answer(hostId, first);
    // The step that refreshes an expired sign-in mints once more. A refresh
    // that could not reach authn leaves the sign-in unjudged, so only one
    // refused is final.
    const refreshed = await signIn.refresh();
    if (refreshed === "rejected") report(hostId, first);
    if (refreshed !== "rotated") return answer(hostId, first);
    return answer(hostId, await source.obtain(userId, hostId, true, null));
  };

  return {
    bearerFor: (hostId) => obtain(hostId, false),
    mintFresh: (hostId) => obtain(hostId, true),
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
          if (!minting.has(hostId)) {
            minting.add(hostId);
            void obtain(hostId, false)
              .then(
                () => undefined,
                () => undefined,
              )
              .finally(() => minting.delete(hostId));
          }
          return null;
        };
        streamBearers.set(hostId, provider);
      }
      return provider;
    },
    onMintRefused: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    renewAfterSignInRefresh: async (hostId) => {
      await stored.renew(userId, [hostId]);
    },
  };
}

/**
 * One command's hold on a host: the host-only token it presents, the tokens
 * it recovers through, and the stored sign-in they are bought with.
 */
export interface CliHostSession {
  readonly bearer: OpenFrameBearerSource;
  /** The stored sign-in, for authn alone: never presented to a host. */
  readonly signInLease: BearerLease;
  readonly tokens: CliHostTokens;
  /** Whether a refresh of the stored sign-in was refused during this hold. */
  readonly signInRejected: () => boolean;
  dispose(): void;
}

export type CliHostSessionResult =
  | { readonly kind: "ok"; readonly session: CliHostSession }
  | { readonly kind: "failed"; readonly failure: CliHostTokenFailure };

/**
 * The host-only token for `hostId`, bought with the stored sign-in `auth`:
 * the one on disk, or with `fresh` a new one whatever is on disk. The caller
 * disposes the session when its command ends, so a refresh's continuation
 * timer never outlives it.
 */
export async function openCliHostSession(
  auth: HostAuth,
  hostId: string,
  fresh: boolean,
): Promise<CliHostSessionResult> {
  const lease = new MutableBearerLease(auth.token, auth.userId);
  // `signal: null`: the session lives as long as its command.
  const store = createCliCredentialsStore();
  // Typed to its own refresh: the shared `AuthRevalidator` it also satisfies
  // declares the same method as `Promise<unknown>`.
  const revalidator: SignInRevalidator = createStoreBackedRevalidator({
    store,
    lease,
    signal: null,
  });
  let rejected = false;
  const refreshSignIn = async (): Promise<RevalidateOutcome> => {
    const outcome = await revalidator.revalidateCurrentContext();
    if (outcome === "rejected") rejected = true;
    return outcome;
  };
  const tokens = createCliHostTokens({ lease, refresh: refreshSignIn });
  const pending = fresh ? tokens.mintFresh(hostId) : tokens.bearerFor(hostId);
  const held = await pending.catch((error: unknown) => {
    store.dispose();
    throw error;
  });
  if (held.kind === "failed") {
    store.dispose();
    return { kind: "failed", failure: held.failure };
  }
  return {
    kind: "ok",
    session: {
      bearer: held.bearer,
      signInLease: lease,
      tokens,
      signInRejected: () => rejected,
      dispose: () => store.dispose(),
    },
  };
}

/** Like {@link openCliHostSession}, throwing the refusal as a command's error. */
export async function requireCliHostSession(
  auth: HostAuth,
  hostId: string,
  toError: (failure: CliHostTokenFailure) => CliError,
): Promise<CliHostSession> {
  const result = await openCliHostSession(auth, hostId, false);
  if (result.kind === "failed") throw toError(result.failure);
  return result.session;
}

/** Signing out removes that person's host-only tokens with their sign-in. */
export async function forgetCliHostTokens(userId: string): Promise<void> {
  await createSource(null).forgetUser(userId);
}
