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
  type TrackedHostTokens,
} from "@traycer-clients/shared/auth/host-token-lease";
import {
  createHostTokenSource,
  type HostTokenMintOutcome,
  type HostTokenSource,
  type VerifiedSignIn,
} from "@traycer-clients/shared/auth/host-token-source";
import { isUsableHostToken } from "@traycer-clients/shared/auth/host-token-store";
import type { DoorAdmissionRelease } from "@traycer-clients/shared/host-transport/host-door-state";
import { mintHostTokenViaHttp } from "@traycer-clients/shared/host-transport/remote/grant-client";
import {
  heldTokenRefused,
  hostTokenUnobtainable,
  ownerSignInEligible,
  type HostInstance,
  type ReleasedSignOn,
  processReleasedHosts,
} from "@traycer-clients/shared/host-transport/released-sign-on";
import { config } from "../config";
import {
  CREDENTIALS_LOCK_WAIT_MS,
  createCliCredentialsStore,
  createStoreBackedRevalidator,
  type SignInRotation,
  type SignInRotationResult,
} from "../store/credentials-store";
import type { HostAuth } from "./host-auth";

const LOCK_POLL_INTERVAL_MS = 50;

/**
 * The held host-only token each person had refused by a host, for this
 * process: every unary call builds its own tokens, and one call's refusal must
 * still keep the next call from presenting that token. Kept on the host
 * process that refused it, so a restarted host is asked afresh.
 */
const heldRefusals = new WeakMap<HostInstance, Map<string, string>>();
function processHeldRefusals(instance: HostInstance): Map<string, string> {
  let refusals = heldRefusals.get(instance);
  if (refusals === undefined) {
    refusals = new Map();
    heldRefusals.set(instance, refusals);
  }
  return refusals;
}

/**
 * One mint request per host process and sign-in at a time for this process: every
 * unary call builds its own tokens, so without it each call that found no
 * usable token sent its own. The request ends when its last asker stops
 * waiting, or on its own timeout. Each asker stops on its own signal, as when
 * the request was its own, or, with none, when the call that asked ends; it is
 * not cut short by another call's. A signal outlives its call only where the
 * command means it to (a give's budget, which its next try joins); no request
 * outlives every asker that wants it. Kept on the host process observed when
 * the mint starts, so a replacement never joins its predecessor's.
 */
interface MintFlight {
  readonly answer: Promise<HostTokenMintOutcome>;
  readonly controller: AbortController;
  askers: number;
}
const mintFlightsByProcess = new WeakMap<
  HostInstance,
  Map<string, MintFlight>
>();
function processMintFlights(instance: HostInstance): Map<string, MintFlight> {
  let flights = mintFlightsByProcess.get(instance);
  if (flights === undefined) {
    flights = new Map();
    mintFlightsByProcess.set(instance, flights);
  }
  return flights;
}

// The sign-in each mint request was sent with, read by its answer's recovery:
// a refusal refreshes only the sign-in it was refused for.
const mintSentWith = new WeakMap<HostTokenMintOutcome, string>();

// What an asker whose signal ended was told when the request was its own.
const abandonedMint = (signal: AbortSignal): HostTokenMintOutcome => ({
  kind: "unavailable",
  detail: `the mint request never completed (${
    signal.reason instanceof Error ? signal.reason.name : "a non-Error throw"
  })`,
});

function sharedMint(
  hostId: string,
  signInToken: string,
  signal: AbortSignal | null,
  callEnded: AbortSignal,
): Promise<HostTokenMintOutcome> {
  const exits = [signal ?? callEnded];
  const gone = exits.find((exit) => exit.aborted);
  if (gone !== undefined) return Promise.resolve(abandonedMint(gone));
  const mintFlights = processMintFlights(
    processReleasedHosts.currentInstance(hostId),
  );
  const key = `${hostId}\u0000${signInToken}`;
  let flight = mintFlights.get(key);
  if (flight === undefined) {
    const controller = new AbortController();
    const started: MintFlight = {
      controller,
      askers: 0,
      answer: mintHostTokenViaHttp(
        config.authnBaseUrl,
        hostId,
        signInToken,
        controller.signal,
      )
        .then((outcome) => {
          mintSentWith.set(outcome, signInToken);
          return outcome;
        })
        .finally(() => {
          if (mintFlights.get(key) === started) mintFlights.delete(key);
        }),
    };
    // Settled for nobody once every asker has left.
    started.answer.catch(() => undefined);
    mintFlights.set(key, started);
    flight = started;
  }
  const joined = flight;
  joined.askers += 1;
  return new Promise<HostTokenMintOutcome>((resolve, reject) => {
    const listeners = new Map<AbortSignal, () => void>();
    const detach = (): void => {
      for (const [exit, listener] of listeners)
        exit.removeEventListener("abort", listener);
    };
    for (const exit of exits) {
      const leave = (): void => {
        detach();
        joined.askers -= 1;
        if (joined.askers === 0) {
          if (mintFlights.get(key) === joined) mintFlights.delete(key);
          joined.controller.abort(exit.reason);
        }
        resolve(abandonedMint(exit));
      };
      listeners.set(exit, leave);
      exit.addEventListener("abort", leave, { once: true });
    }
    joined.answer.then(
      (outcome) => {
        detach();
        resolve(outcome);
      },
      (cause: unknown) => {
        detach();
        reject(cause);
      },
    );
  });
}

export interface CliSignIn {
  readonly lease: BearerLease;
  /** Refreshes the sign-in under the credentials lock and rotates `lease`, answering with the sign-in its save wrote. */
  readonly refresh: () => Promise<SignInRotationResult>;
  /** Adopts into `lease` the sign-in the credentials file holds now, when it is newer. */
  readonly adoptStored: () => Promise<void>;
  /** Cancels this process's own mints, so an abandoned one cannot hold the CLI open; `null` lives as long as the command. */
  readonly signal: AbortSignal | null;
}

export interface SignInRevalidator {
  revalidateCurrentContext(): Promise<RevalidateOutcome>;
  rotateSignIn(): Promise<SignInRotationResult>;
  adoptStoredSignIn(): Promise<void>;
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
   * `WsRpcClientOptions.hostBearerFor` for `hostId`: a usable token the host
   * has not refused, at once.
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
   * admissions, and a `not-admitted` ends nothing while that connection is
   * admitted, nor when its mint began before now. Call the release when the
   * admitted connection leaves.
   */
  admitted(hostId: string): DoorAdmissionRelease;
  /**
   * A usable token the host has not refused, or a held one of any age while
   * authn has not answered and the host has not refused it; else `null`, and
   * the transport probes. Every other ask starts a mint in the background.
   */
  streamBearer(hostId: string): BearerSourceProvider;
  /**
   * Tells `listener` of every mint refusal that ends the command, the ones a
   * recovery makes among them, until the returned stop is called. One rule for
   * every command: `not-a-member`, `sandbox-frozen`, a `sign-in-rejected` its
   * refresh could not answer, and `no-sign-in` end it at once. `not-admitted` (authn has no
   * row) ends it only when no sign-in can follow: the host named a reason in
   * this process and no sign-in it invited is on the wire unanswered, or it
   * declined this person's probe. Once authn answered `not-admitted` no new
   * invited sign-in is written, so only one already on the wire can still be
   * admitted. It ends nothing while an open of that host is admitted, or once
   * one was admitted after that mint started, and otherwise waits in
   * {@link deferredNotAdmitted}; the next mint is judged again.
   */
  onRefusalEndingCommand(listener: CliMintRefusalListener): () => void;
  /** The `not-admitted` the command went on past, while no open was admitted after its mint started. */
  deferredNotAdmitted(hostId: string): CliHostTokenFailure | null;
  /**
   * Authn refused the refresh, or a mint again right after an accepted refresh. Until
   * then a refused mint is the sign-in recovering.
   */
  signInRejected(): boolean;
  /**
   * The stored sign-in's refresh, judged as above: "adopted" when it took a
   * sibling's rotation from the store, which authn did not answer for this
   * caller, so it spends none of any budget.
   */
  refreshSignIn(): Promise<SignInRotation>;
  /** Adopts into the lease the sign-in the credentials file holds now, when it is newer. */
  adoptStoredSignIn(): Promise<void>;
  /** `true` when one was minted; its refusal is judged like any other mint's. */
  renewAfterSignInRefresh(hostId: string): Promise<boolean>;
  /** See `hostTokenUnobtainable`. */
  hostTokenUnobtainable(hostId: string): boolean;
  /** See `ownerSignInEligible`. */
  ownerSignInEligible(hostId: string): boolean;
  /** See `ReleasedSignOn.heldTokenRefused`. */
  heldTokenRefused(instance: HostInstance, presented: string): boolean;
  /** See `ReleasedSignOn.forgetHeldRefusal`. */
  forgetHeldRefusal(hostId: string): void;
  /** The call these tokens were built for ended: every mint it asked for stops waiting. */
  dispose(): void;
}

function createSource(
  signIn: VerifiedSignIn | null,
  callEnded: AbortSignal,
): HostTokenSource {
  return createHostTokenSource({
    persistence: createHostTokenFilePersistence({
      environment: config.environment,
      lockWaitMs: CREDENTIALS_LOCK_WAIT_MS,
      lockPollIntervalMs: LOCK_POLL_INTERVAL_MS,
    }),
    mint: (hostId, signInToken, signal) =>
      sharedMint(hostId, signInToken, signal, callEnded),
    signIn,
    now: Date.now,
  });
}

export function createCliHostTokens(signIn: CliSignIn): CliHostTokens {
  const userId = signIn.lease.identity.userId;
  const hosts = processReleasedHosts;
  const listeners = new Set<CliMintRefusalListener>();
  // When each host process last admitted an open, how many of its admitted
  // connections have not left, and the `not-admitted` the command went on past
  // with when its mint started. "When" is this process's order of admissions
  // and mint starts, not the clock: two in one millisecond must still be
  // ordered. Kept on the host process, so a replacement starts with none.
  let events = 0;
  const nextEvent = (): number => ++events;
  const admittedAt = new WeakMap<HostInstance, number>();
  const admittedOpen = new WeakMap<HostInstance, number>();
  const deferred = new WeakMap<
    HostInstance,
    { readonly failure: CliHostTokenFailure; readonly startedAt: number }
  >();
  const admittedSince = (owner: HostInstance, startedAt: number): boolean =>
    (admittedOpen.get(owner) ?? 0) > 0 ||
    (admittedAt.get(owner) ?? 0) > startedAt;
  // When the newest mint that bought a token for each host process started. A
  // mint that started before it answers late: its answer is not recorded, so a
  // late refusal never ends a command after a newer success.
  const mintedAt = new WeakMap<HostInstance, number>();
  const outlived = (owner: HostInstance, startedAt: number): boolean =>
    (mintedAt.get(owner) ?? 0) > startedAt;
  // Asked only while `owner` is current, so the memory's reads by host id
  // answer for it.
  const endsCommand = (
    owner: HostInstance,
    failure: CliHostTokenFailure,
    startedAt: number,
  ): boolean => {
    if (failure.kind !== "not-admitted") return true;
    if (admittedSince(owner, startedAt)) return false;
    if (
      (hosts.namedReason(owner.hostId) &&
        !hosts.invitedSignInPending(owner.hostId)) ||
      hosts.probeDeclined(userId, owner.hostId)
    )
      return true;
    deferred.set(owner, { failure, startedAt });
    return false;
  };
  // A mint's refusal concerns the host process it started for: once another
  // is observed, or a mint for it that started later bought a token, it ends
  // nothing and is deferred for nothing.
  const report = (
    owner: HostInstance,
    failure: CliHostTokenFailure,
    startedAt: number,
  ): void => {
    if (
      !hosts.isCurrent(owner) ||
      outlived(owner, startedAt) ||
      !endsCommand(owner, failure, startedAt)
    )
      return;
    for (const listener of Array.from(listeners))
      listener(owner.hostId, failure);
  };
  const callEnded = new AbortController();
  const stored = createSource(
    (id) => (id === userId ? readLeaseBearer(signIn.lease) : null),
    callEnded.signal,
  );
  // The source syncs with the credentials file before it compares and records
  // a refused mint, so a refusal of a sign-in replaced on disk is dropped
  // there and never recorded against the stored one.
  stored.bindSignInSync(() => signIn.adoptStored());
  // The one judge of a rejected sign-in, for every mint this process makes:
  // a refresh authn refused, or a 401 on the first mint after a refresh it
  // accepted for this process, sent with the very sign-in that refresh
  // installed. A token minted, or a refresh accepted (a sibling's adopted
  // included), starts it again; an adopted one spends nothing, so a 401 after
  // it is not yet the judge's, nor is a 401 for a sign-in a sibling installed.
  let refreshRefused = false;
  let refreshedSinceLastMint = false;
  let refusedAfterRefresh = false;
  // The sign-in this process's latest accepted rotation installed, as its own
  // save answered; `null` when it answered none.
  let installedByRefresh: string | null = null;
  // The session or command these tokens belong to has ended: no rotation
  // starts for it. A refresh already entered is left to finish.
  const sessionEnded = (): boolean =>
    callEnded.signal.aborted || signIn.signal?.aborted === true;
  // Whether a refused mint was sent with a sign-in since replaced: then nothing
  // is refreshed, and the mint is asked again on the stored one.
  const refusedSignInReplaced = (refused: HostTokenMintOutcome): boolean => {
    const sentWith = mintSentWith.get(refused);
    return sentWith !== undefined && sentWith !== readLeaseBearer(signIn.lease);
  };
  // Whether a refused mint was sent with the sign-in this process's own
  // rotation installed, and so refused after that refresh. A refusal with no
  // recorded sign-in, or after a rotation that answered none, is judged as
  // after our refresh: telling it apart would take a sign-in nobody recorded,
  // and judging it so keeps the second refusal final, never another refresh.
  const refusedOurRefresh = (refused: HostTokenMintOutcome): boolean => {
    const sentWith = mintSentWith.get(refused);
    return (
      sentWith === undefined ||
      installedByRefresh === null ||
      sentWith === installedByRefresh
    );
  };
  // The sign-in the latest refused mint was sent with, for the transports'
  // recovery, which is asked to refresh with no outcome in hand.
  let lastRefused: HostTokenMintOutcome | null = null;
  const refreshSignIn = async (): Promise<SignInRotation> => {
    if (sessionEnded()) return "network-error";
    const { outcome, installed } = await signIn.refresh();
    if (outcome === "rejected") refreshRefused = true;
    if (outcome === "rotated" || outcome === "adopted") {
      refreshRefused = false;
      refusedAfterRefresh = false;
      refreshedSinceLastMint = outcome === "rotated";
      installedByRefresh = installed;
    }
    return outcome;
  };
  // Every mint passes here, so a refusal for good is reported wherever asked. A token
  // that could not be saved is transient like an unreachable authn, never a rejected
  // sign-in. A mint with no signal of its own is cancelled with this process's mints.
  // A mint belongs to the host process its asker named, or to the one current
  // when it started.
  const tracked = trackHostTokenMints(
    {
      current: (id, hostId) => stored.current(id, hostId),
      loaded: () => stored.loaded(),
      whenLoaded: () => stored.whenLoaded(),
      lastFailureOf: (id, owner) => stored.lastFailureOf(id, owner),
      obtain: async (id, hostId, fresh, { signal, owner: mintOwner }) => {
        const askFor = (asker: HostInstance): Promise<HostTokenMintOutcome> =>
          stored
            .obtain(id, hostId, fresh, {
              signal: signal ?? signIn.signal,
              owner: asker,
              observedNow: () => hosts.currentInstance(hostId).observed,
            })
            .catch((): HostTokenMintOutcome => ({
              kind: "unavailable",
              detail: "host-only token not saved",
            }));
        let owner = mintOwner ?? hosts.currentInstance(hostId);
        // The process was replaced before the mint could start: once more, for the
        // process observed now.
        const ask = async (): Promise<HostTokenMintOutcome> => {
          const asked = await askFor(owner);
          if (asked.kind !== "process-replaced") return asked;
          owner = hosts.currentInstance(hostId);
          const again = await askFor(owner);
          return again.kind === "process-replaced"
            ? { kind: "unavailable", detail: "the host process was replaced" }
            : again;
        };
        let startedAt = nextEvent();
        let outcome = await ask();
        for (;;) {
          // The stored sign-in is the credentials file's: a refusal whose
          // sign-in is known reads it first, adopting one a sibling or the
          // desktop saved, before anything below compares, judges or reports.
          if (outcome.kind === "sign-in-rejected" && mintSentWith.has(outcome))
            await signIn.adoptStored();
          if (outlived(owner, startedAt)) return outcome;
          if (outcome.kind === "sign-in-rejected") lastRefused = outcome;
          // The comparison comes first. A refusal of a sign-in already replaced
          // when its answer arrived is not a refusal for anyone: it judges,
          // spends and reports nothing, and is never handed upward. The mint is
          // asked again on the stored sign-in, and that answer is the one every
          // reader above sees. Each further pass needs the stored sign-in to
          // have been replaced again while the mint was out.
          if (
            outcome.kind !== "sign-in-rejected" ||
            !refusedSignInReplaced(outcome)
          )
            break;
          startedAt = nextEvent();
          outcome = await ask();
        }
        if (outcome.kind === "ok") mintedAt.set(owner, startedAt);
        if (
          outcome.kind === "sign-in-rejected" &&
          refreshedSinceLastMint &&
          refusedOurRefresh(outcome)
        )
          refusedAfterRefresh = true;
        if (outcome.kind === "ok") refusedAfterRefresh = false;
        refreshedSinceLastMint = false;
        if (isHostRefusal(outcome)) report(owner, outcome, startedAt);
        return outcome;
      },
    },
    hosts,
  );
  // The host's refusal of a held token is the process's, not this command's
  // tokens (see `processHeldRefusals`), and is kept on the host process that
  // refused; a read asks the one observed now.
  const source: TrackedHostTokens = {
    ...tracked,
    noteHeldRefused: (instance, id, presented) => {
      processHeldRefusals(instance).set(id, presented);
    },
    forgetHeldRefused: (id, hostId) => {
      processHeldRefusals(hosts.currentInstance(hostId)).delete(id);
    },
    heldRefused: (id, hostId) => {
      const refused = processHeldRefusals(hosts.currentInstance(hostId)).get(
        id,
      );
      return (
        refused !== undefined && tracked.current(id, hostId)?.token === refused
      );
    },
  };
  const signInRejected = (): boolean => refreshRefused || refusedAfterRefresh;
  // A refused mint's recovery: nothing is refreshed for a sign-in already
  // replaced, and the mint is asked again as after a sibling's rotation.
  // The file is read first, so a sign-in saved elsewhere since counts as
  // replaced; with no refusal known it is not, and the store's own locked
  // rotate adopts a newer file without spending.
  const signInRecovery = {
    revalidateForReconnect: async (): Promise<SignInRotation> => {
      const refused = lastRefused;
      if (refused === null || !mintSentWith.has(refused))
        return refreshSignIn();
      await signIn.adoptStored();
      return refusedSignInReplaced(refused) ? "adopted" : refreshSignIn();
    },
  };
  const bearerOf = (hostId: string): OpenFrameBearerSource => ({
    identity: { userId },
    getBearerToken: () => source.current(userId, hostId)?.token ?? "",
  });
  const presentsHeld = (hostId: string): boolean =>
    heldWhileAuthnUnreachable(source, userId, hostId) !== null;
  // A held token the host refused is no token held, however usable it reads.
  const presentsAsIs = (hostId: string): boolean =>
    !source.heldRefused(userId, hostId) &&
    isUsableHostToken(source.current(userId, hostId), Date.now());
  const answer = (
    hostId: string,
    outcome: HostTokenMintOutcome,
  ): CliHostBearer =>
    // The bearer carries no minted token: bearerOf reads the one held when it presents.
    outcome.kind === "ok"
      ? { kind: "ok", bearer: bearerOf(hostId) }
      : { kind: "failed", failure: outcome };
  // A command presents whatever this process may hold, and keeps no state
  // of the door's: it ends with the refusal it was given.
  const onState = (): void => undefined;
  // One per host process instance: each remembers the token it minted after
  // that instance's last refusal, which is what makes a second refusal final.
  // A restarted host starts with a recovery of its own, never one an earlier
  // instance spent. Asked only once the transport has checked the refusal is
  // the current instance's.
  const recoveries = new WeakMap<HostInstance, HostTokenSessionRevalidator>();
  const streamRecovery = (hostId: string): HostTokenSessionRevalidator => {
    const instance = hosts.currentInstance(hostId);
    let recovery = recoveries.get(instance);
    if (recovery === undefined) {
      recovery = hostTokenRevalidator({
        tokens: source,
        hosts,
        currentUserId: () => userId,
        hostId,
        signInRecovery,
        onState,
        now: Date.now,
      });
      recoveries.set(instance, recovery);
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
  // the sign-in; an unreachable refresh leaves it unjudged. A sibling's rotation
  // adopted from the store is no refresh of this one: a 401 after it still earns
  // the one authn answers. A refusal of a sign-in since replaced refreshes
  // nothing and asks again on the stored one, judging nothing. The recovery is
  // its asker's: once that call or the session has ended, it starts no rotation.
  const recoverRefusedSignIn = async (
    owner: HostInstance,
    first: CliHostTokenFailure,
    firstStartedAt: number,
    signal: AbortSignal | null,
  ): Promise<CliHostBearer> => {
    const hostId = owner.hostId;
    if (signal?.aborted === true || sessionEnded())
      return answer(hostId, {
        kind: "unavailable",
        detail: "sign-in refresh not started: its caller ended",
      });
    const refreshed = refusedSignInReplaced(first)
      ? "replaced"
      : await refreshSignIn();
    if (refreshed === "network-error")
      return answer(hostId, {
        kind: "unavailable",
        detail: "sign-in refresh unavailable",
      });
    if (refreshed === "rejected") {
      report(owner, first, firstStartedAt);
      return answer(hostId, first);
    }
    const startedAt = nextEvent();
    const second = await source.obtain(userId, hostId, true, {
      signal,
      owner,
      observedNow: () => hosts.currentInstance(hostId).observed,
    });
    if (second.kind !== "sign-in-rejected") return answer(hostId, second);
    // The retry is judged by its own sign-in: one replaced while it was
    // pending is no second refusal of the stored one, and is asked again; one
    // a sibling installed is that sign-in's first refusal, and earns its own
    // refresh. Only a refusal of the sign-in this rotation installed is final.
    if (
      refreshed === "adopted" ||
      refreshed === "replaced" ||
      refusedSignInReplaced(second) ||
      !refusedOurRefresh(second)
    )
      return recoverRefusedSignIn(owner, second, startedAt, signal);
    report(owner, second, startedAt);
    return answer(hostId, second);
  };

  const obtain = async (
    owner: HostInstance,
    fresh: boolean,
    signal: AbortSignal | null,
  ): Promise<CliHostBearer> => {
    const startedAt = nextEvent();
    const first = await source.obtain(userId, owner.hostId, fresh, {
      signal,
      owner,
      observedNow: () => hosts.currentInstance(owner.hostId).observed,
    });
    if (first.kind === "no-sign-in") report(owner, first, startedAt);
    if (first.kind !== "sign-in-rejected") return answer(owner.hostId, first);
    return recoverRefusedSignIn(owner, first, startedAt, signal);
  };

  // One background mint per host process at a time, for the stream and the
  // unary asks alike; nothing that dials awaits it, and a replacement never
  // joins its predecessor's. Fresh while the host has refused the held token:
  // a mint that is not would hand that token back.
  const minting = new WeakMap<HostInstance, Promise<CliHostBearer>>();
  const mintInBackground = (hostId: string): Promise<CliHostBearer> => {
    const owner = hosts.currentInstance(hostId);
    const running = minting.get(owner);
    if (running !== undefined) return running;
    const started = obtain(owner, source.heldRefused(userId, hostId), null)
      .catch((): CliHostBearer => ({
        kind: "failed",
        failure: { kind: "unavailable", detail: "host-only token mint failed" },
      }))
      .finally(() => minting.delete(owner));
    minting.set(owner, started);
    return started;
  };

  return {
    whenLoaded: () => stored.whenLoaded(),
    lease: leaseOf,
    mintFresh: (hostId, signal) =>
      obtain(hosts.currentInstance(hostId), true, signal),
    hostBearerFor: async (hostId, waitForMint) => {
      if (presentsAsIs(hostId)) return leaseOf(hostId);
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
    // Reached only through the door fence, so the current host process is the
    // one that admitted; its release leaves that process's count alone.
    admitted: (hostId) => {
      const owner = hosts.currentInstance(hostId);
      admittedAt.set(owner, nextEvent());
      admittedOpen.set(owner, (admittedOpen.get(owner) ?? 0) + 1);
      streamRecovery(hostId).admitted();
      let left = false;
      return () => {
        if (left) return;
        left = true;
        admittedOpen.set(owner, (admittedOpen.get(owner) ?? 1) - 1);
      };
    },
    streamBearer: (hostId) => {
      let provider = streamBearers.get(hostId);
      if (provider === undefined) {
        const lease = leaseOf(hostId);
        provider = () => {
          if (presentsAsIs(hostId)) return lease;
          void mintInBackground(hostId);
          return presentsHeld(hostId) ? lease : null;
        };
        streamBearers.set(hostId, provider);
      }
      return provider;
    },
    signInRejected,
    refreshSignIn,
    adoptStoredSignIn: () => signIn.adoptStored(),
    hostTokenUnobtainable: (hostId) =>
      hostTokenUnobtainable(source, userId, hostId),
    ownerSignInEligible: (hostId) =>
      ownerSignInEligible(source, userId, hostId),
    heldTokenRefused: (instance, presented) =>
      heldTokenRefused(source, userId, instance, presented),
    forgetHeldRefusal: (hostId) => source.forgetHeldRefused(userId, hostId),
    dispose: () => callEnded.abort(),
    onRefusalEndingCommand: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    deferredNotAdmitted: (hostId) => {
      const owner = hosts.currentInstance(hostId);
      const held = deferred.get(owner);
      return held === undefined ||
        admittedSince(owner, held.startedAt) ||
        outlived(owner, held.startedAt)
        ? null
        : held.failure;
    },
    // Once per refresh, through the reporting source. A 401 on the first mint after an
    // accepted refresh is a rejected sign-in; one another mint got to first recovers as any 401.
    renewAfterSignInRefresh: async (hostId) => {
      const owner = hosts.currentInstance(hostId);
      const startedAt = nextEvent();
      const renewed = await source.obtain(userId, hostId, true, {
        signal: signIn.signal,
        owner,
        observedNow: () => hosts.currentInstance(hostId).observed,
      });
      if (renewed.kind === "no-sign-in") report(owner, renewed, startedAt);
      if (renewed.kind !== "sign-in-rejected") return renewed.kind === "ok";
      if (refusedAfterRefresh && !refusedSignInReplaced(renewed)) {
        report(owner, renewed, startedAt);
        return false;
      }
      return (
        (await recoverRefusedSignIn(owner, renewed, startedAt, null)).kind ===
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
 * whose refusal in the same dial sequence showed the released level. Each
 * question is asked about the host the transport's socket was selected for.
 */
export function cliReleasedSignOn(
  lease: BearerLease,
  tokens: Pick<
    CliHostTokens,
    | "refreshSignIn"
    | "adoptStoredSignIn"
    | "hostTokenUnobtainable"
    | "ownerSignInEligible"
    | "heldTokenRefused"
    | "forgetHeldRefusal"
  >,
): ReleasedSignOn {
  return {
    signIn: () => (readLeaseBearer(lease) === null ? null : lease),
    // No row is held, so none refuses it, as `opensReleasedWayOnThisMachine`
    // reads a missing row.
    mayPresentSignIn: () => true,
    // The transport's own: it reads "adopted" as no refresh spent. A refusal
    // of a sign-in the person no longer holds is not of the one stored, so it
    // refreshes nothing; the redial presents the stored one.
    recovery: {
      revalidateForReconnect: async (refused) => {
        // With the refused sign-in known, the file is read first: one saved
        // elsewhere since is the stored one. Unknown, the lease stands, and
        // the store's locked rotate adopts a newer file without spending.
        if (refused === null) return tokens.refreshSignIn();
        await tokens.adoptStoredSignIn();
        const stored = readLeaseBearer(lease);
        return stored !== null && refused !== stored
          ? "adopted"
          : tokens.refreshSignIn();
      },
    },
    hostTokenUnobtainable: (hostId) => tokens.hostTokenUnobtainable(hostId),
    ownerSignInEligible: (hostId) => tokens.ownerSignInEligible(hostId),
    heldTokenRefused: (instance, presented) =>
      tokens.heldTokenRefused(instance, presented),
    forgetHeldRefusal: (hostId) => tokens.forgetHeldRefusal(hostId),
    hosts: processReleasedHosts,
  };
}

/** A host's process as its pid.json names it: a restart writes another. */
export interface HostProcess {
  readonly hostId: string;
  readonly pid: number;
  readonly startedAt: string;
}

/**
 * For a command that re-reads pid.json while it runs. A host whose process
 * changed may be another release, so what its earlier process named no longer
 * says what it will answer: the memory starts a new instance, and every
 * attempt carrying the old one marks and plans nothing. A refusal never
 * starts one, or a team's computer could then be handed the sign-in.
 *
 * Observed before the endpoint it came with is published, so a dial that
 * reads the new endpoint carries the new instance.
 */
export function observeHostInstance(hostProcess: HostProcess): void {
  processReleasedHosts.observeInstance(
    hostProcess.hostId,
    `${hostProcess.pid}\u0000${hostProcess.startedAt}`,
  );
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
    refresh: () => revalidator.rotateSignIn(),
    adoptStored: () => revalidator.adoptStoredSignIn(),
    signal,
  });
  await tokens.whenLoaded();
  return {
    bearer: tokens.lease(hostId),
    signInLease: lease,
    tokens,
    releasedSignOn: cliReleasedSignOn(lease, tokens),
    dispose: () => {
      tokens.dispose();
      store.dispose();
    },
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
  // Forgetting mints nothing, so no call's end is ever signalled.
  await createSource(null, new AbortController().signal).forgetUser(userId);
}
