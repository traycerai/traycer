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
import { drawHostMintOrder } from "@traycer-clients/shared/auth/host-mint-order";
import { createHostTokenFilePersistence } from "@traycer-clients/shared/auth/host-token-file";
import {
  heldWhileAuthnUnreachable,
  hostTokenRevalidator,
  trackHostTokenMints,
  type CliHostTokenSessionRevalidator,
  type HostTokenRecoveryOutcome,
  type TrackedHostTokens,
} from "@traycer-clients/shared/auth/host-token-lease";
import {
  createHostTokenSource,
  hostSignInKey,
  type HostTokenAsk,
  type HostTokenMintOutcome,
  type IdentifiedMintOutcome,
  type IdentifyingHostTokenSource,
  type OrderedMintAnswer,
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
  type SignInRecovery,
  type SignInRecoveryOutcome,
  type SignInRefusal,
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
  /** The order drawn as this flight's request was sent; every joiner gets it. */
  readonly order: number;
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

/**
 * The request order of the newest purchase for each host process: a token a
 * live asker's own write kept, for a current owner. Kept for the process, so
 * every token instance reads one watermark. It only moves forward, and an
 * answer to an earlier request is outlived by it.
 */
const purchaseOrderByProcess = new WeakMap<HostInstance, number>();
const outlived = (owner: HostInstance, order: number): boolean =>
  (purchaseOrderByProcess.get(owner) ?? 0) > order;

/**
 * What this process has learned of each of a person's sign-ins, by sign-in
 * key ({@link hostSignInKey}). Every set only grows, so every order of the
 * same facts gives the same judgement, and a late fact counts whenever it
 * arrives. Kept for the process, as `processMintFlights` is, so every
 * `createCliHostTokens` in it reads one judge; held in memory only.
 * - `refused`: a mint refusal of it counted (see the tracker).
 * - `rotatedIn`: authn accepted this process's own refresh, which installed it.
 * - `bought`: authn answered a token to a mint request sent with it.
 * - `refreshRefused`: authn refused this process's refresh of it.
 */
interface SignInFacts {
  readonly refused: Set<string>;
  readonly rotatedIn: Set<string>;
  readonly bought: Set<string>;
  readonly refreshRefused: Set<string>;
}
const signInFactsByUser = new Map<string, SignInFacts>();
function processSignInFacts(userId: string): SignInFacts {
  let facts = signInFactsByUser.get(userId);
  if (facts === undefined) {
    facts = {
      refused: new Set(),
      rotatedIn: new Set(),
      bought: new Set(),
      refreshRefused: new Set(),
    };
    signInFactsByUser.set(userId, facts);
  }
  return facts;
}
const noteSignIn = (facts: Set<string>, signInToken: string): void => {
  const key = hostSignInKey(signInToken);
  if (key !== null) facts.add(key);
};
// Refused after this process's own refresh installed it, with nothing bought
// on it since: no further refresh can answer it.
const finalFor = (facts: SignInFacts, signIn: string): boolean =>
  facts.refused.has(signIn) &&
  facts.rotatedIn.has(signIn) &&
  !facts.bought.has(signIn);
// The one terminal predicate: its refresh refused, or final.
const rejectedFor = (facts: SignInFacts, signIn: string): boolean =>
  facts.refreshRefused.has(signIn) || finalFor(facts, signIn);

// What an asker whose signal ended was told when the request was its own.
const abandonedMint = (signal: AbortSignal): HostTokenMintOutcome => ({
  kind: "unavailable",
  detail: `the mint request never completed (${
    signal.reason instanceof Error ? signal.reason.name : "a non-Error throw"
  })`,
});

// An ask that sends no request: no order of ours, and nothing bought.
const unsentMint = (exit: AbortSignal): OrderedMintAnswer => ({
  outcome: abandonedMint(exit),
  order: null,
});

function sharedMint(
  userId: string,
  hostId: string,
  signInToken: string,
  signal: AbortSignal | null,
  callEnded: AbortSignal,
  sessionSignal: AbortSignal | null,
): Promise<OrderedMintAnswer> {
  const exits = [signal ?? callEnded];
  const gone = exits.find((exit) => exit.aborted);
  if (gone !== undefined) return Promise.resolve(unsentMint(gone));
  const mintFlights = processMintFlights(
    processReleasedHosts.currentInstance(hostId),
  );
  const key = `${hostId}\u0000${signInToken}`;
  let flight = mintFlights.get(key);
  if (flight === undefined) {
    // A NEW request starts only while its asker and its token session are both
    // live; a running one may still be joined.
    const ended =
      [signal, callEnded, sessionSignal].find(
        (exit) => exit?.aborted === true,
      ) ?? null;
    if (ended !== null) return Promise.resolve(unsentMint(ended));
    const controller = new AbortController();
    const started: MintFlight = {
      controller,
      askers: 0,
      order: drawHostMintOrder(),
      answer: mintHostTokenViaHttp(
        config.authnBaseUrl,
        hostId,
        signInToken,
        controller.signal,
      )
        .then((outcome) => {
          // Bought, in the turn authn's answer arrives: before any asker's
          // write of it, and whether or not any asker is still waiting. It
          // can only spare a sign-in a final verdict, never make one.
          if (outcome.kind === "ok")
            noteSignIn(processSignInFacts(userId).bought, signInToken);
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
  const running = flight;
  running.askers += 1;
  return new Promise<OrderedMintAnswer>((resolve, reject) => {
    const listeners = new Map<AbortSignal, () => void>();
    const detach = (): void => {
      for (const [exit, listener] of listeners)
        exit.removeEventListener("abort", listener);
    };
    for (const exit of exits) {
      const leave = (): void => {
        detach();
        running.askers -= 1;
        if (running.askers === 0) {
          if (mintFlights.get(key) === running) mintFlights.delete(key);
          running.controller.abort(exit.reason);
        }
        resolve(unsentMint(exit));
      };
      listeners.set(exit, leave);
      exit.addEventListener("abort", leave, { once: true });
    }
    running.answer.then(
      (outcome) => {
        detach();
        resolve({ outcome, order: running.order });
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

/** The CLI's recovery always judges a spent refusal by its sign-in's facts. */
export type JudgedSignInRecovery = SignInRecovery & {
  readonly signInRejectedFor: (
    refusal: SignInRefusal | null,
  ) => Promise<boolean>;
};

/**
 * The CLI's one mapping of the lease's two internal values for every caller
 * but the monitor: a recovery lost to a host process replacement answers as
 * an unreachable authn does, and a sign-in verdict as any rejection does.
 */
export const replacedAsNetworkError = (
  outcome: HostTokenRecoveryOutcome,
): RevalidateOutcome =>
  outcome === "process-replaced"
    ? "network-error"
    : outcome === "sign-in-rejected"
      ? "rejected"
      : outcome;

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
  streamRecovery(hostId: string): CliHostTokenSessionRevalidator;
  /**
   * `instance` admitted an open: a second refusal is final only between two
   * of its admissions, and a `not-admitted` ends nothing while that
   * connection is admitted, nor when its mint began before now. Another
   * process's bounds and counts are its own. Call the release when the
   * admitted connection leaves.
   */
  admitted(instance: HostInstance): DoorAdmissionRelease;
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
   * Whether the sign-in stored now (the credentials file is read first) is
   * rejected: its refresh was refused, or a mint refused it after this
   * process's own refresh installed it with nothing bought on it since. With
   * a refusal, only while the refused sign-in is the stored one. The one read
   * of this verdict outside the judge.
   */
  signInRejectedNow(refusal: SignInRefusal | null): Promise<boolean>;
  /**
   * The one sign-in recovery for every refusal these tokens recover: the
   * host-only token's, and a released host's refusal of the sign-in.
   */
  readonly signInRecovery: JudgedSignInRecovery;
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
  userId: string,
  signIn: VerifiedSignIn | null,
  callEnded: AbortSignal,
  sessionSignal: AbortSignal | null,
): IdentifyingHostTokenSource {
  return createHostTokenSource({
    persistence: createHostTokenFilePersistence({
      environment: config.environment,
      lockWaitMs: CREDENTIALS_LOCK_WAIT_MS,
      lockPollIntervalMs: LOCK_POLL_INTERVAL_MS,
    }),
    mint: (hostId, signInToken, signal) =>
      sharedMint(userId, hostId, signInToken, signal, callEnded, sessionSignal),
    signIn,
    now: Date.now,
  });
}

// An identified mint's answer, as the tracker reads it.
type Answered = Pick<
  IdentifiedMintOutcome,
  "outcome" | "signIn" | "order" | "purchase"
>;
type SignInRefused = Extract<
  HostTokenMintOutcome,
  { readonly kind: "sign-in-rejected" }
>;
// The tracker's answer to an ask: the owner it was recorded on (the process
// observed after a replacement), when the ask started among this instance's
// events, and the request order it is judged by. A refusal leaves only when
// it counted, with its sign-in key and request order.
interface AskedAt {
  readonly owner: HostInstance;
  readonly startedAt: number;
  /** The order of the request behind the answer; `null` when none was sent. */
  readonly order: number | null;
}
type Asked = AskedAt &
  (
    | { readonly refusal: null; readonly outcome: HostTokenMintOutcome }
    | { readonly refusal: SignInRefusal; readonly outcome: SignInRefused }
  );
type RefusedAsk = Extract<Asked, { readonly refusal: SignInRefusal }>;

export function createCliHostTokens(signIn: CliSignIn): CliHostTokens {
  const userId = signIn.lease.identity.userId;
  const hosts = processReleasedHosts;
  const facts = processSignInFacts(userId);
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
    {
      readonly failure: CliHostTokenFailure;
      readonly startedAt: number;
      readonly order: number | null;
    }
  >();
  const admittedSince = (owner: HostInstance, startedAt: number): boolean =>
    (admittedOpen.get(owner) ?? 0) > 0 ||
    (admittedAt.get(owner) ?? 0) > startedAt;
  // Each host process's latest counting refusal, by sign-in key and request
  // order: what its door's revocation, with no refusal in hand, recovers.
  const held = new WeakMap<HostInstance, SignInRefusal>();
  // Asked only while `owner` is current, so the memory's reads by host id
  // answer for it.
  const endsCommand = (
    owner: HostInstance,
    failure: CliHostTokenFailure,
    startedAt: number,
    order: number | null,
  ): boolean => {
    if (failure.kind !== "not-admitted") return true;
    if (admittedSince(owner, startedAt)) return false;
    if (
      (hosts.namedReason(owner.hostId) &&
        !hosts.invitedSignInPending(owner.hostId)) ||
      hosts.probeDeclined(userId, owner.hostId)
    )
      return true;
    deferred.set(owner, { failure, startedAt, order });
    return false;
  };
  // A mint's refusal concerns the host process it started for: once another
  // is observed, or a purchase for it on a later request, it ends nothing and
  // is deferred for nothing. An answer with no request behind it has no order
  // to be outlived.
  const report = (
    owner: HostInstance,
    failure: CliHostTokenFailure,
    startedAt: number,
    order: number | null,
  ): void => {
    if (
      !hosts.isCurrent(owner) ||
      (order !== null && outlived(owner, order)) ||
      !endsCommand(owner, failure, startedAt, order)
    )
      return;
    for (const listener of Array.from(listeners))
      listener(owner.hostId, failure);
  };
  const callEnded = new AbortController();
  const stored = createSource(
    userId,
    (id) => (id === userId ? readLeaseBearer(signIn.lease) : null),
    callEnded.signal,
    signIn.signal,
  );
  // The source syncs with the credentials file before it compares and records
  // a refused mint, so a refusal of a sign-in replaced on disk is dropped
  // there and never recorded against the stored one.
  stored.bindSignInSync(() => signIn.adoptStored());
  // The key of the sign-in stored now: the lease's, which follows the file.
  const storedKey = (): string | null =>
    hostSignInKey(readLeaseBearer(signIn.lease));
  // The session or command these tokens belong to has ended: no rotation
  // starts for it. A refresh already entered is left to finish.
  const sessionEnded = (): boolean =>
    callEnded.signal.aborted || signIn.signal?.aborted === true;
  // The exit that ended an ask, as an ended mint is told today.
  const endedExit = (signal: AbortSignal | null): AbortSignal | null =>
    [signal, signIn.signal, callEnded.signal].find(
      (exit) => exit?.aborted === true,
    ) ?? null;
  const refreshSignIn = async (): Promise<SignInRotation> => {
    if (sessionEnded()) return "network-error";
    const rotation = await signIn.refresh();
    // What authn answered this process's own refresh, whatever its save and
    // its retries then reported: the sign-in it issued, or the one it
    // refused. A sibling's rotation only adopted is neither.
    if (rotation.accepted !== null)
      noteSignIn(facts.rotatedIn, rotation.accepted);
    if (rotation.outcome === "rejected")
      noteSignIn(facts.refreshRefused, rotation.refused);
    return rotation.outcome;
  };

  // What may have moved while a refusal was out: another pass of an ask needs
  // one of them advanced, so no loop repeats a request nothing changed.
  interface Progress {
    readonly signIn: string | null;
    readonly process: HostInstance;
    readonly bearer: string | null;
    readonly minted: number;
  }
  const progressOf = (owner: HostInstance, hostId: string): Progress => ({
    signIn: storedKey(),
    process: hosts.currentInstance(hostId),
    bearer: stored.current(userId, hostId)?.token ?? null,
    minted: purchaseOrderByProcess.get(owner) ?? 0,
  });
  const advanced = (before: Progress, after: Progress): boolean =>
    before.signIn !== after.signIn ||
    before.process !== after.process ||
    before.bearer !== after.bearer ||
    before.minted !== after.minted;
  // Nothing moved since a refusal that counts for nobody: the current
  // process's usable held token is the answer, else a transient one.
  const unmoved = (hostId: string): HostTokenMintOutcome => {
    const token = stored.current(userId, hostId);
    const refused = processHeldRefusals(hosts.currentInstance(hostId)).get(
      userId,
    );
    return token !== null &&
      token.token !== refused &&
      isUsableHostToken(token, Date.now())
      ? { kind: "ok", token }
      : {
          kind: "unavailable",
          detail: "the sign-in was refused and nothing has changed since",
        };
  };

  // Every mint passes here, so a refusal for good is reported wherever asked.
  // A token that could not be saved is transient like an unreachable authn,
  // never a rejected sign-in. A mint belongs to the host process its asker
  // named, or to the one current when it started, and is carried to the
  // process observed after a replacement. A refusal leaves only when it
  // counts (see below), carrying its sign-in and request order; any other
  // outcome leaves with no refusal.
  const answerAsked = async (
    id: string,
    hostId: string,
    fresh: boolean,
    signal: AbortSignal | null,
    askedOwner: HostInstance | null,
  ): Promise<Asked> => {
    let owner = askedOwner ?? hosts.currentInstance(hostId);
    const askFor = (
      asker: HostInstance,
      freshAsk: boolean,
    ): Promise<Answered> =>
      stored
        .obtainIdentified(id, hostId, freshAsk, {
          signal: signal ?? signIn.signal,
          owner: asker,
          observedNow: () => hosts.currentInstance(hostId).observed,
        })
        .catch((): Answered => ({
          outcome: { kind: "unavailable", detail: "host-only token not saved" },
          signIn: null,
          order: null,
          purchase: null,
        }));
    let freshAsk = fresh;
    let replaced = false;
    for (;;) {
      const before = progressOf(owner, hostId);
      const startedAt = nextEvent();
      const answered = await askFor(owner, freshAsk);
      const { outcome } = answered;
      const settled = (settledOutcome: HostTokenMintOutcome): Asked => ({
        outcome: settledOutcome,
        refusal: null,
        owner,
        startedAt,
        order: answered.order,
      });
      // A token for a process since retired is never progress, nor the
      // replacement's bearer: it answers as a replaced process does, and the
      // redial reads the process current now.
      if (outcome.kind === "ok" && !hosts.isCurrent(owner))
        return settled({ kind: "process-replaced" });
      // The process was replaced before the mint could start: once more, for
      // the process observed now.
      if (outcome.kind === "process-replaced") {
        const exit = endedExit(signal);
        if (exit !== null) return settled(abandonedMint(exit));
        if (replaced)
          return settled({
            kind: "unavailable",
            detail: "the host process was replaced",
          });
        replaced = true;
        owner = hosts.currentInstance(hostId);
        continue;
      }
      if (outcome.kind === "ok") {
        // A usable answer, and the purchase it records, are a live asker's.
        const exit = endedExit(signal);
        if (exit !== null) return settled(abandonedMint(exit));
        const { purchase } = answered;
        // The source kept this asker's own write of the token the request
        // bought, for this owner; the owner is current (checked above, with
        // no await since) and the asker live.
        if (purchase !== null && purchase.owner === owner) {
          if ((purchaseOrderByProcess.get(owner) ?? 0) < purchase.order)
            purchaseOrderByProcess.set(owner, purchase.order);
          if (purchase.signIn === storedKey()) held.delete(owner);
        }
        return settled(outcome);
      }
      if (outcome.kind !== "sign-in-rejected") {
        if (isHostRefusal(outcome))
          report(owner, outcome, startedAt, answered.order);
        return settled(outcome);
      }
      // The stored sign-in is the credentials file's: read it first,
      // adopting one a sibling or the desktop saved.
      await signIn.adoptStored();
      const refused = answered.signIn;
      const order = answered.order;
      // A refusal counts only when, after the read, it was sent with the
      // stored sign-in, no purchase for this process on a later request has
      // outlived it, and its process is current. Liveness is last, with no
      // await between it and the write.
      const counts =
        refused !== null &&
        refused === storedKey() &&
        (order === null || !outlived(owner, order)) &&
        hosts.isCurrent(owner);
      const exit = endedExit(signal);
      if (exit !== null) return settled(abandonedMint(exit));
      if (counts) {
        facts.refused.add(refused);
        const refusal: SignInRefusal = { signIn: refused, order };
        held.set(owner, refusal);
        return {
          outcome,
          refusal,
          owner,
          startedAt,
          order,
        };
      }
      // A refusal that does not count records, judges, refreshes and
      // reports nothing. The mint is asked again on the stored sign-in for
      // the process current now, only once something moved.
      if (!advanced(before, progressOf(owner, hostId)))
        return settled(unmoved(hostId));
      // Outlived, the token a later purchase bought answers: it is newer
      // than this ask, so a fresh ask is satisfied by it.
      if (order !== null && outlived(owner, order)) freshAsk = false;
      if (!hosts.isCurrent(owner)) owner = hosts.currentInstance(hostId);
    }
  };
  // An ask this instance makes itself goes through the tracker as every ask
  // does, and its own frame reads the tracker's full answer back, keyed by
  // the ask object it made, deleting it as it reads: nothing holds it past
  // that call.
  const ownAsks = new WeakSet<HostTokenAsk>();
  const askedBy = new WeakMap<HostTokenAsk, Asked>();
  const tracked = trackHostTokenMints(
    {
      current: (id, hostId) => stored.current(id, hostId),
      loaded: () => stored.loaded(),
      whenLoaded: () => stored.whenLoaded(),
      lastFailureOf: (id, owner) => stored.lastFailureOf(id, owner),
      obtain: async (id, hostId, fresh, ask) => {
        const asked = await answerAsked(
          id,
          hostId,
          fresh,
          ask.signal,
          ask.owner,
        );
        if (ownAsks.has(ask)) askedBy.set(ask, asked);
        return asked.outcome;
      },
    },
    hosts,
  );
  const askTracked = async (
    id: string,
    hostId: string,
    fresh: boolean,
    signal: AbortSignal | null,
    owner: HostInstance | null,
  ): Promise<Asked> => {
    const ask: HostTokenAsk =
      owner === null
        ? { signal, owner: null }
        : {
            signal,
            owner,
            observedNow: () => hosts.currentInstance(hostId).observed,
          };
    ownAsks.add(ask);
    const outcome = await tracked.obtain(id, hostId, fresh, ask);
    const asked = askedBy.get(ask);
    askedBy.delete(ask);
    // Answered short of the tracker: nothing counted, nothing carried.
    return (
      asked ?? {
        outcome,
        refusal: null,
        owner: owner ?? hosts.currentInstance(hostId),
        startedAt: nextEvent(),
        order: null,
      }
    );
  };
  // The host's refusal of a held token is the process's, not this command's
  // tokens (see `processHeldRefusals`), and is kept on the host process that
  // refused; a read asks the one observed now. A refusal reaches the lease
  // with the sign-in and order it counted for and the owner it was recorded
  // on; one that counted for nobody never reaches it.
  const source: TrackedHostTokens = {
    ...tracked,
    obtainIdentified: async (id, hostId, fresh, { signal, owner }) => {
      const asked = await askTracked(id, hostId, fresh, signal, owner);
      return {
        outcome: asked.outcome,
        signIn: asked.refusal?.signIn ?? null,
        order: asked.refusal?.order ?? null,
        owner: asked.owner,
      };
    },
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
  // The one read of "is the sign-in rejected" for anything outside the judge:
  // the stored sign-in is the file's, so the file is read first. With a
  // refusal, only while its sign-in is the stored one.
  const signInRejectedNow = async (
    refusal: SignInRefusal | null,
  ): Promise<boolean> => {
    await signIn.adoptStored();
    const current = storedKey();
    return (
      current !== null &&
      (refusal === null || refusal.signIn === current) &&
      rejectedFor(facts, current)
    );
  };
  // The one sign-in recovery, for every refusal this process recovers. Its
  // owner and refusal are its caller's, never captured. What is stored, which
  // process is current, whether the owner still wants it and whether the
  // sign-in is final are all read after its last await, at the rotation. A
  // known refusal is the question asked: only the door's revocation, with
  // none in hand, reads the refusal this process holds for its owner. A
  // refusal of a host's open carries no request order, so no purchase
  // outlives it.
  // A refused refresh is answered terminally only if, after an adopting
  // read, the sign-in it tried is still the stored one and still rejected;
  // one a sibling replaced meanwhile is answered "adopted", and asked again.
  const rotateStored = async (): Promise<SignInRotation> => {
    const tried = storedKey();
    const outcome = await refreshSignIn();
    if (outcome !== "rejected") return outcome;
    await signIn.adoptStored();
    return tried !== null && tried === storedKey() && rejectedFor(facts, tried)
      ? "rejected"
      : "adopted";
  };
  // A replaced owner is the one reason it answers "process-replaced": every
  // other declined recovery is "network-error".
  const recoverSignIn = async (
    owner: HostInstance,
    refusal: SignInRefusal | null,
    stillWanted: () => boolean,
  ): Promise<SignInRecoveryOutcome> => {
    // None in hand and none held: the stored sign-in is rotated as it always
    // was, and the store's locked rotate adopts a newer file without
    // spending. Nothing is awaited before the action.
    if (refusal === null && !held.has(owner)) {
      if (!hosts.isCurrent(owner)) return "process-replaced";
      if (!stillWanted() || sessionEnded()) return "network-error";
      return rotateStored();
    }
    await signIn.adoptStored();
    const known = refusal ?? held.get(owner) ?? null;
    if (known !== null && known.signIn !== storedKey()) return "adopted";
    if (known !== null && known.order !== null && outlived(owner, known.order))
      return "network-error";
    if (!hosts.isCurrent(owner)) return "process-replaced";
    if (!stillWanted() || sessionEnded()) return "network-error";
    if (known !== null && finalFor(facts, known.signIn)) return "rejected";
    return rotateStored();
  };
  const signInRecovery: JudgedSignInRecovery = {
    revalidateForReconnect: recoverSignIn,
    signInRejectedFor: signInRejectedNow,
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
  // One per host process instance: each keeps its bounds, which make a second
  // refusal final. A restarted host starts with a recovery of its own, never
  // one an earlier instance spent; the process a recovery acts for is the
  // owner it is handed.
  const recoveries = new WeakMap<
    HostInstance,
    CliHostTokenSessionRevalidator
  >();
  const recoveryOf = (
    instance: HostInstance,
  ): CliHostTokenSessionRevalidator => {
    let recovery = recoveries.get(instance);
    if (recovery === undefined) {
      recovery = hostTokenRevalidator({
        tokens: source,
        hosts,
        currentUserId: () => userId,
        hostId: instance.hostId,
        signInRecovery,
        signInKey: storedKey,
        onState,
        now: Date.now,
      });
      recoveries.set(instance, recovery);
    }
    return recovery;
  };
  const streamRecovery = (hostId: string): CliHostTokenSessionRevalidator =>
    recoveryOf(hosts.currentInstance(hostId));

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

  // A counting refusal is a terminal effect, reported and handed to its
  // caller, only if it still is after the verdict read: its sign-in still the
  // stored one and rejected, its process current, no later purchase for that
  // process outliving it, and its asker live. Otherwise there is no terminal
  // effect at all: an outlived refusal is answered by the later purchase's
  // held token, and any other is asked again on the stored sign-in for the
  // current process.
  const reportRejected = async (
    refused: RefusedAsk,
    signal: AbortSignal | null,
  ): Promise<CliHostBearer> => {
    const { owner, refusal, outcome } = refused;
    const rejectedNow = await signInRejectedNow(refusal);
    const exit = endedExit(signal);
    if (exit !== null) return answer(owner.hostId, abandonedMint(exit));
    const current = hosts.isCurrent(owner);
    const overtaken = refusal.order !== null && outlived(owner, refusal.order);
    if (rejectedNow && current && !overtaken) {
      report(owner, outcome, refused.startedAt, refused.order);
      return answer(owner.hostId, outcome);
    }
    return current && overtaken
      ? obtain(owner, false, signal)
      : obtain(hosts.currentInstance(owner.hostId), true, signal);
  };

  // One recovery, then one more ask. A counting refusal of a final sign-in,
  // judged at the rotation, rotates nothing and is reported; any other earns
  // one recovery. The retry's own counting refusal earns another only when
  // the stored sign-in moved past the one refused. The recovery is its
  // asker's: once that call or the session has ended, it starts no rotation.
  const recoverRefusedSignIn = async (
    refused: RefusedAsk,
    signal: AbortSignal | null,
  ): Promise<CliHostBearer> => {
    const { owner, refusal } = refused;
    const hostId = owner.hostId;
    if (signal?.aborted === true || sessionEnded())
      return answer(hostId, {
        kind: "unavailable",
        detail: "sign-in refresh not started: its caller ended",
      });
    const recovered = await recoverSignIn(
      owner,
      refusal,
      () => signal?.aborted !== true,
    );
    // Declined because a later purchase for this process outlived the
    // refusal: that purchase's held token answers.
    if (
      recovered === "network-error" &&
      refusal.order !== null &&
      outlived(owner, refusal.order) &&
      hosts.isCurrent(owner)
    )
      return obtain(owner, false, signal);
    // Its one mapping: a recovery its owner's replacement declined is as
    // transient here as an unreachable refresh.
    if (recovered === "network-error" || recovered === "process-replaced")
      return answer(hostId, {
        kind: "unavailable",
        detail: "sign-in refresh unavailable",
      });
    if (recovered === "rejected") return reportRejected(refused, signal);
    // "rotated" or "adopted": the retry is sent only once the stored sign-in
    // is shown to have moved past the refused one. Unmoved after one more
    // read, nothing is sent and the held token or a transient answers.
    if (storedKey() === refusal.signIn) {
      await signIn.adoptStored();
      if (storedKey() === refusal.signIn)
        return answer(hostId, unmoved(hostId));
    }
    const retried = await askTracked(userId, hostId, true, signal, owner);
    if (retried.refusal === null) {
      if (retried.outcome.kind === "no-sign-in")
        report(
          retried.owner,
          retried.outcome,
          retried.startedAt,
          retried.order,
        );
      return answer(hostId, retried.outcome);
    }
    // The same sign-in refused again: final if it is final now (the
    // recovery's gate reports it); otherwise nothing moved, and no further
    // recovery starts.
    if (
      retried.refusal.signIn === refusal.signIn &&
      !finalFor(facts, refusal.signIn)
    )
      return answer(hostId, {
        kind: "unavailable",
        detail: "the sign-in was refused again and nothing has changed since",
      });
    return recoverRefusedSignIn(retried, signal);
  };

  const obtain = async (
    owner: HostInstance,
    fresh: boolean,
    signal: AbortSignal | null,
  ): Promise<CliHostBearer> => {
    const asked = await askTracked(userId, owner.hostId, fresh, signal, owner);
    if (asked.refusal !== null) return recoverRefusedSignIn(asked, signal);
    if (asked.outcome.kind === "no-sign-in")
      report(asked.owner, asked.outcome, asked.startedAt, asked.order);
    return answer(owner.hostId, asked.outcome);
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

  // The session's own: a unary call's recovery starts no rotation once the
  // command or the session has ended.
  const sessionWanted = (): boolean => !sessionEnded();

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
            ? replacedAsNetworkError(
                await recovery.revalidateForReconnect(sessionWanted),
              )
            : "superseded",
        revalidateRefusedBearer: async (expected, _hostId, refusal) => {
          if (expected.identity.userId !== userId) return "superseded";
          // A refusal of this one call rather than at the door recovers
          // nothing: the call carried a token checked unexpired just before.
          if (refusal === null) return "rejected";
          return replacedAsNetworkError(
            await recovery.revalidateRefused(refusal, sessionWanted),
          );
        },
      };
    },
    streamRecovery,
    // The process the door heard admit; its release leaves that process's
    // count alone.
    admitted: (owner) => {
      admittedAt.set(owner, nextEvent());
      admittedOpen.set(owner, (admittedOpen.get(owner) ?? 0) + 1);
      recoveryOf(owner).admitted();
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
    signInRejectedNow,
    signInRecovery,
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
      const waiting = deferred.get(owner);
      return waiting === undefined ||
        admittedSince(owner, waiting.startedAt) ||
        (waiting.order !== null && outlived(owner, waiting.order))
        ? null
        : waiting.failure;
    },
    // Once per refresh. A counting refusal of the sign-in this process's own
    // refresh installed, with nothing bought on it, is final at the recovery's
    // gate; any other recovers as any refusal does.
    renewAfterSignInRefresh: async (hostId) => {
      const owner = hosts.currentInstance(hostId);
      const renewed = await askTracked(
        userId,
        hostId,
        true,
        signIn.signal,
        owner,
      );
      if (renewed.refusal === null) {
        if (renewed.outcome.kind === "no-sign-in")
          report(
            renewed.owner,
            renewed.outcome,
            renewed.startedAt,
            renewed.order,
          );
        return renewed.outcome.kind === "ok";
      }
      return (await recoverRefusedSignIn(renewed, null)).kind === "ok";
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
    | "signInRecovery"
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
    // The tokens' one recovery: a refusal of a sign-in the person no longer
    // holds refreshes nothing ("adopted"), and the redial presents the
    // stored one.
    recovery: tokens.signInRecovery,
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
  await createSource(
    userId,
    null,
    new AbortController().signal,
    null,
  ).forgetUser(userId);
}
