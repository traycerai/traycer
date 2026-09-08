import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { isRelayFuseRecoveryCandidate } from "@traycer-clients/shared/host-client/remote-fetcher";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { useHostBinding } from "@/lib/host";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useRemoteSessionsPollReadiness } from "@/hooks/host/use-remote-sessions-poll-readiness";
import { dialableHostEndpointFor } from "@/lib/host/transport-key";
import {
  absentListingProvesDeath,
  useLandingTerminalStore,
  type LandingTerminalPendingKill,
} from "@/stores/home/landing-terminal-store";
import {
  useLandingTerminalKill,
  type LandingTerminalKillVariables,
} from "@/components/home/terminal-panel/use-landing-terminal-kill-mutation";
import {
  LandingTerminalAuthorityFleet,
  type LandingTerminalAuthorityEntries,
  type LandingTerminalAuthorityEntry,
} from "@/components/home/terminal-panel/landing-terminal-authority-fleet";
import { terminalSessionKey } from "@/stores/home/landing-terminal-store";
import { getPlainTerminal } from "@/lib/terminals/plain-terminal-authority";
import { requestLandingTerminalClose } from "@/lib/terminals/landing-terminal-close-coordinator";

const CAPABLE_CLOSE_RETRY_BASE_MS = 500;
/**
 * Ceiling on the retry interval - and there is deliberately no ceiling on the
 * number of attempts, for every tombstone whose kill some answer can still
 * settle. (`PENDING_CREATE_KILL_ANSWER_BUDGET` is the one exception, and it
 * exists precisely because no answer can settle that shape.)
 *
 * A tombstone is a kill that is still owed, so the drain must not reach a state
 * it cannot leave. An attempt budget did exactly that: once spent, the three
 * ways back in are all shut for a host that stays dialable under one
 * capability, so a failure repaired by a credential refresh or a reconnect -
 * which replaces the authority without changing its protocol - would never be
 * retried, and the shell would outlive its tab until relaunch.
 *
 * What the budget was there to stop was the COST of a permanent failure
 * retrying every 8s forever. Growing the interval answers that directly: the
 * backoff reaches this ceiling after ~10 attempts and then costs a handful of
 * requests an hour, while a host that recovers is still picked up on its own.
 */
const CAPABLE_CLOSE_RETRY_MAX_MS = 300_000;

/**
 * How many `terminal.kill` answers a tombstone's PENDING-CREATE reprieve buys.
 *
 * `pendingCreate` is the one provenance that makes `killed: false` ambiguous -
 * "not created YET" rather than "gone" - so the kill mutation keeps the record
 * instead of clearing it. Every other shape retires itself on that answer.
 *
 * The reprieve needs a floor because the create's settlement is UNOBSERVABLE
 * from here: it is dispatched by the tile, and `useLandingTerminalDurableLifecycle`
 * invalidates its own request generation on unmount - which closing the tab
 * always causes - so a create that rejects, or one that lands and exits before
 * the next attempt, leaves `pendingCreate` true with nothing left to falsify it.
 * Unbounded, that is an RPC and a `terminal.list` invalidation every five
 * minutes, forever, for a session that can never appear.
 *
 * Counted in ANSWERS (`CapableCloseRetry.answers`), never in attempts. A
 * rejection is the transport failing to ask, which is the opposite of the host
 * reporting the session absent, so spending the budget on one would retire a
 * tombstone nobody ever answered for - and leak the PTY if the create had in
 * fact landed. Ten answers is the un-capped ladder, so this costs at least
 * ~4.25 minutes of the host continuously saying "no such session", and longer
 * whenever rejections stretch the backoff without earning anything.
 *
 * Counting answers also means the record retires on the same pass as the tenth
 * rather than arming an eleventh attempt it would only discard.
 *
 * A live projection outranks a spent budget - see `intendedCloseAction`. The
 * budget is absence-based evidence, and a terminal the host is publishing right
 * now is presence-based evidence that contradicts it.
 *
 * It rides the retry record, so it is scoped to one drain episode: a host that
 * goes undialable and returns starts a fresh ladder. That is deliberate. The
 * budget is a statement about how long a create can plausibly still be in
 * flight, and a host that just came back is a host whose create genuinely may
 * be. What it must not do - and no longer does - is let a STABLE host be asked
 * forever, which is the cost this bound exists to cap.
 */
const PENDING_CREATE_KILL_ANSWER_BUDGET = 10;

/**
 * Which RPC a drain attempt used - NOT which capability its host reported.
 *
 * The two stopped being the same thing once an unacknowledged tombstone on a
 * CAPABLE host began routing to `terminal.kill`. Keying the retry state on host
 * capability made that case unretryable: the record said `legacy`, the host
 * said `capable`, and the predicate refused every attempt.
 *
 * - `plain` - `terminal.plain.close`, which names a terminal the host is
 *   publishing and REJECTS for one it does not know.
 * - `kill` - `terminal.kill`, which a legacy host serves directly and a capable
 *   host serves by trying its plain registry first and falling back, reporting
 *   an already-gone session as `killed: false` rather than as an error.
 */
type TombstoneCloseArm = "plain" | "kill";

interface CapableCloseRetry {
  attempt: number;
  /**
   * Settlements where the HOST ANSWERED - a close that resolved and still left
   * the tombstone outstanding, which for `terminal.kill` is `killed: false`.
   *
   * Deliberately not `attempt`. Both settlement arms schedule a retry, so the
   * attempt ladder counts rejections too, and a rejection is the transport
   * failing to ask - the opposite of the host reporting the session absent.
   * Spending an absence-based budget on those would discard a tombstone no one
   * ever answered for, and leak the PTY if the create had in fact landed.
   */
  answers: number;
  timer: number | null;
  due: boolean;
  /**
   * The arm these attempts were spent on. The budget is per-arm: a tombstone
   * that changes arm gets a fresh one, because the attempts that failed were
   * spent on a different request.
   */
  arm: TombstoneCloseArm;
}

/**
 * The slice of the kill mutation this file dispatches through. Named rather
 * than taken off the hook's result so the retry helpers state what they need.
 */
interface LandingTerminalKillDispatch {
  readonly mutateAsync: (
    variables: LandingTerminalKillVariables,
  ) => Promise<unknown>;
}

interface TombstoneRetryRefs {
  readonly authorityEntries: {
    current: LandingTerminalAuthorityEntries;
  };
  readonly dialable: { current: ReadonlyMap<string, TombstoneDrainability> };
  readonly inFlight: { current: ReadonlySet<string> };
  readonly mounted: { current: boolean };
  readonly retries: { current: Map<string, CapableCloseRetry> };
}

/**
 * Which arms this host can serve right now - deliberately NOT one boolean.
 *
 * `canMutate` tracks LIST-STREAM freshness, not liveness, and only one arm
 * reads the list: `terminal.plain.close` names a row in the projection, while
 * `terminal.kill` is unary and never consults it. Gating both on `canMutate`
 * left an unacknowledged tombstone parked for as long as a capable host's
 * stream was merely reconnecting - and cancelled its retry record on the way
 * past, so nothing was left to wake.
 */
interface TombstoneDrainability {
  /** `terminal.kill` can be sent: the route is up and an authority resolved. */
  readonly kill: boolean;
  /** `terminal.plain.close` can be sent: capable, with a fresh listing. */
  readonly plain: boolean;
}

function landingTerminalTombstoneDrainability(
  directoryEntry: HostDirectoryEntry,
  hasReadySession: boolean,
  authorityEntry: LandingTerminalAuthorityEntry | undefined,
): TombstoneDrainability {
  const routeReady =
    dialableHostEndpointFor(directoryEntry, hasReadySession) !== null &&
    (hasReadySession || !isRelayFuseRecoveryCandidate(directoryEntry));
  const authority = authorityEntry?.authority;
  const capability = authority?.capability.status;
  const kill =
    routeReady && (capability === "legacy" || capability === "capable");
  return {
    kill,
    plain: kill && capability === "capable" && authority?.canMutate === true,
  };
}

function clearCapableCloseRetry(
  retries: Map<string, CapableCloseRetry>,
  key: string,
): void {
  const retry = retries.get(key);
  if (retry !== undefined && retry.timer !== null) {
    clearTimeout(retry.timer);
  }
  retries.delete(key);
}

function cancelUndrainableCapableCloseRetries(args: {
  readonly retries: Map<string, CapableCloseRetry>;
  readonly pendingKeys: ReadonlySet<string>;
  readonly drainableByHostId: ReadonlyMap<string, TombstoneDrainability>;
}): void {
  for (const key of args.retries.keys()) {
    const hostId = key.slice(0, key.indexOf("\u0000"));
    // Keyed on the `kill` arm, the weaker of the two: a host whose listing has
    // merely gone stale can still serve a kill, so tearing its retry down here
    // would strand the arm that had no reason to stop.
    if (
      args.pendingKeys.has(key) &&
      args.drainableByHostId.get(hostId)?.kill === true
    ) {
      continue;
    }
    clearCapableCloseRetry(args.retries, key);
  }
}

/**
 * Whether another attempt at this tombstone could still land.
 *
 * Both arms require the tombstone to be outstanding and the route to still be
 * there. Only the PLAIN arm additionally demands a projection: its close names a
 * terminal the host is publishing, so for a session that host acknowledged, a
 * vanished projection means the session is already gone.
 *
 * The `kill` arm demands only that SOME authority has resolved, because both
 * capabilities serve `terminal.kill`. Requiring a projection there would make it
 * unretryable - it is reached precisely when no projection exists - and
 * requiring a `legacy` host would make it unretryable on the capable host that
 * an unacknowledged tombstone is routed to.
 */
function closeRetryStillWarranted(args: {
  readonly pending: LandingTerminalPendingKill;
  readonly refs: TombstoneRetryRefs;
  readonly arm: TombstoneCloseArm;
}): boolean {
  const stillPending = useLandingTerminalStore
    .getState()
    .pendingKills.some(
      (candidate) =>
        candidate.hostId === args.pending.hostId &&
        candidate.sessionId === args.pending.sessionId,
    );
  if (!stillPending) return false;
  // Per-arm, so a stale listing stops only the arm that reads one.
  const drainable = args.refs.dialable.current.get(args.pending.hostId);
  if (drainable === undefined) return false;
  if (!(args.arm === "kill" ? drainable.kill : drainable.plain)) {
    return false;
  }
  const currentEntry = args.refs.authorityEntries.current[args.pending.hostId];
  if (currentEntry === undefined) return false;
  const capability = currentEntry.authority.capability.status;
  if (args.arm === "kill") {
    return capability === "legacy" || capability === "capable";
  }
  if (capability !== "capable" || !currentEntry.authority.canMutate) {
    return false;
  }
  return (
    getPlainTerminal(
      currentEntry.authority.collection,
      args.pending.hostId,
      args.pending.sessionId,
    ) !== undefined
  );
}

function scheduleCloseRetry(args: {
  readonly key: string;
  readonly pending: LandingTerminalPendingKill;
  readonly refs: TombstoneRetryRefs;
  readonly arm: TombstoneCloseArm;
  /** The host answered and the tombstone survived it. A rejection is not one. */
  readonly answered: boolean;
  readonly signalRetry: () => void;
}): void {
  if (!args.refs.mounted.current) return;
  if (!closeRetryStillWarranted(args)) return;
  // A record belonging to the OTHER arm is discarded outright, timer and all.
  // Keeping it would block this arm twice over: its armed timer makes the guard
  // below return, and its attempt count would hand a tombstone that just
  // switched arm the long interval the failed arm ran up. A different request
  // deserves a prompt attempt on a clean schedule.
  const stale = args.refs.retries.current.get(args.key);
  if (stale !== undefined && stale.arm !== args.arm) {
    clearCapableCloseRetry(args.refs.retries.current, args.key);
  }
  const prior = args.refs.retries.current.get(args.key);
  if (prior !== undefined && prior.timer !== null) return;
  const attempt = (prior?.attempt ?? 0) + 1;
  const retryDelay = Math.min(
    CAPABLE_CLOSE_RETRY_BASE_MS * 2 ** (attempt - 1),
    CAPABLE_CLOSE_RETRY_MAX_MS,
  );
  const nextRetry: CapableCloseRetry = {
    attempt,
    // Carried across attempts on the same arm, and reset with the record when
    // the arm changes - a `plain` rejection says nothing about what `kill` was
    // told.
    answers: (prior?.answers ?? 0) + (args.answered ? 1 : 0),
    timer: null,
    due: false,
    arm: args.arm,
  };
  nextRetry.timer = window.setTimeout(() => {
    if (!args.refs.mounted.current) return;
    nextRetry.timer = null;
    nextRetry.due = true;
    args.signalRetry();
  }, retryDelay);
  args.refs.retries.current.set(args.key, nextRetry);
}

/**
 * What a drain attempt should do about this tombstone right now.
 *
 * `discard` and `wait` are deliberately distinct: both send nothing, but one
 * drops a record the host has answered and the other keeps a kill that is still
 * owed. Collapsing them is how a tombstone gets lost in front of a live PTY.
 *
 * ONE decider, read by two callers: the drain effect marks a key with the arm
 * it is about to use, and `dispatchTombstoneClose` routes on the same value.
 * Deriving it separately is how the mark and the request drift - a `kill`-arm
 * backoff stayed parked for up to its full interval after the projection it was
 * waiting for had already appeared, because the mark recorded the host's
 * CAPABILITY, which had not changed.
 */
type TombstoneCloseAction = TombstoneCloseArm | "discard" | "wait";

function intendedCloseAction(args: {
  readonly entry: LandingTerminalAuthorityEntry | undefined;
  readonly killAnswers: number;
  readonly pending: LandingTerminalPendingKill;
  readonly plainDrainable: boolean;
}): TombstoneCloseAction {
  const authority = args.entry?.authority;
  if (authority === undefined) return "wait";
  const capability = authority.capability.status;
  if (capability !== "legacy" && capability !== "capable") return "wait";
  // A terminal the host is publishing RIGHT NOW outranks every absence-based
  // decision below, the spent reprieve included. The final `killed: false` can
  // race the create landing, and the pass that observes both must believe the
  // positive evidence: discarding there would drop the tombstone in front of a
  // PTY the host is actively reporting as live.
  const projected =
    capability === "capable" &&
    args.plainDrainable &&
    getPlainTerminal(
      authority.collection,
      args.pending.hostId,
      args.pending.sessionId,
    ) !== undefined;
  if (projected) return "plain";
  // Only now, with no live projection to contradict it. Ahead of the capability
  // split because a `pendingCreate` record routes to `terminal.kill` whether the
  // host came back legacy or capable, so bounding it under only one of them
  // would leave the other asking forever.
  if (
    args.pending.pendingCreate &&
    args.killAnswers >= PENDING_CREATE_KILL_ANSWER_BUDGET
  ) {
    return "discard";
  }
  if (capability === "legacy") return "kill";
  if (!args.plainDrainable) {
    // A stale listing blocks only the arm that READS a listing. A tombstone
    // this host acknowledged is answered by `plain`, so it waits for freshness
    // - the pre-existing decision, unchanged. One that `plain` could never
    // answer has nothing to wait for, and `terminal.kill` is unary.
    return absentListingProvesDeath(args.pending) ? "wait" : "kill";
  }
  // No projection, and absence proves nothing for this shape - so `kill`, not
  // `plain`. `terminal.plain.close` would REJECT for a terminal this host does
  // not know, which is the wrong answer for both shapes that land here: a
  // create still in flight (whose terminal will exist under this exact session
  // id, because the client supplied it) and a legacy session on a host that
  // came back upgraded (which never had a plain projection at all).
  // `terminal.kill` covers both - the capable host tries its plain registry
  // first and falls back to the legacy manager.
  return absentListingProvesDeath(args.pending) ? "discard" : "kill";
}

interface TombstoneDispatchDecision {
  readonly action: TombstoneCloseAction;
  /** The arm about to be spent, or `null` when this pass sends nothing. */
  readonly arm: TombstoneCloseArm | null;
  /** This pass may send: an arm recovered, the arm changed, or a retry is due. */
  readonly admitted: boolean;
  /** This arm is not the one this key was last dispatched on. */
  readonly firstSight: boolean;
}

/**
 * What to do with one tombstone on one pass, and whether this pass may do it.
 *
 * Three independent ways in, because each covers a gap the others leave:
 *
 * - an ARM RECOVERY. Deliberately the arm's own drainability and not the
 *   host's: `kill` is the weaker arm and is true whenever `plain` is, so keying
 *   the edge on it lost the plain arm's stale -> fresh return entirely. A
 *   `plain` close that rejected while the listing was stale could schedule no
 *   retry (its arm was undrainable at the time), still carried a `plain` mark,
 *   and saw `kill` true throughout - no edge to ride, and the PTY outlived its
 *   tombstone.
 * - FIRST SIGHT of this arm. A tombstone recorded while its host was ALREADY
 *   drainable has no transition to ride in on and no retry record yet, so
 *   without this it would wait for the host to flap. That was survivable while
 *   a close could only be recorded against a resolved authority - the panel's
 *   fast path had already sent the kill - but a close under an unresolved probe
 *   records the tombstone and dispatches nothing, leaving the bridge as the only
 *   thing that will ever send it.
 *
 *   The mark records the ARM, not the host's capability. Those stopped being the
 *   same thing once a capable host could serve either: a tombstone whose
 *   in-flight create finally appeared in the projection moves from `kill` to
 *   `plain` with the capability unchanged, so a capability-keyed mark said
 *   "already attempted" and the new arm sat out the old one's backoff, up to the
 *   full 300s ceiling.
 * - a DUE retry, the ordinary backoff path.
 */
function tombstoneDispatchDecision(args: {
  readonly attempted: ReadonlyMap<string, TombstoneCloseArm>;
  readonly drainable: TombstoneDrainability;
  readonly entry: LandingTerminalAuthorityEntry | undefined;
  readonly key: string;
  readonly pending: LandingTerminalPendingKill;
  readonly previous: TombstoneDrainability | undefined;
  readonly retry: CapableCloseRetry | undefined;
}): TombstoneDispatchDecision {
  const action = intendedCloseAction({
    entry: args.entry,
    // Only answers on THIS arm count. A `plain` record's settlements were spent
    // on a request that answers a different question, and the reprieve is about
    // how many times the host has said "no such session".
    killAnswers: args.retry?.arm === "kill" ? args.retry.answers : 0,
    pending: args.pending,
    plainDrainable: args.drainable.plain,
  });
  const arm = action === "plain" || action === "kill" ? action : null;
  const armRecovered =
    arm === "plain"
      ? args.previous?.plain !== true
      : args.previous?.kill !== true;
  const firstSight = args.attempted.get(args.key) !== arm;
  return {
    action,
    arm,
    admitted: armRecovered || firstSight || args.retry?.due === true,
    firstSight,
  };
}

/** Sends `terminal.plain.close`. Reached only for a projection that exists. */
function dispatchCapableClose(args: {
  readonly entry: LandingTerminalAuthorityEntry;
  readonly key: string;
  readonly pending: LandingTerminalPendingKill;
  readonly retry: CapableCloseRetry | undefined;
  readonly refs: TombstoneRetryRefs;
  readonly signalRetry: () => void;
}): void {
  if (args.retry !== undefined) args.retry.due = false;
  args.refs.inFlight.current = new Set([
    ...args.refs.inFlight.current,
    args.key,
  ]);
  void requestLandingTerminalClose({
    hostId: args.pending.hostId,
    sessionId: args.pending.sessionId,
    // Joins the panel's fast path when that gesture is still in flight, rather
    // than racing it to the same terminal. A joined settlement belongs to the
    // OTHER request though, so only the owner may read it as an answer.
    close: () =>
      args.entry.mutations.close
        .mutateAsync({
          hostId: args.pending.hostId,
          terminalId: args.pending.sessionId,
        })
        .then(() => undefined),
  })
    .then(
      (outcome) => {
        // Only the OWNER retires the record. The coordinator keys by the
        // terminal's lifetime rather than by RPC, so this close can join an
        // in-flight `terminal.kill` - which reports an already-gone session as
        // `killed: false` DATA, and for a `pendingCreate` record the kill
        // mutation keeps the tombstone on exactly that answer. Clearing here off
        // a joined promise would overrule the owner and strand the PTY the
        // create is about to produce.
        //
        // A joiner also learned NOTHING about its own arm, so it has to leave
        // the drain able to send one. Merely declining to clear stranded the
        // tombstone just as thoroughly: the retry was dropped while the `plain`
        // mark stayed in `attemptedRef`, and the drain admits a key only on a
        // drainability edge, on FIRST SIGHT of the arm, or on a due retry -
        // none of which a joined settlement produces. So the newly created PTY
        // outlived the record with nothing left to send its close.
        //
        // This is the backoff a REJECTION earns, for the same reason: no answer
        // to this arm's question. `scheduleCloseRetry` stands down on its own if
        // the owner did retire the tombstone.
        if (!outcome.owned) {
          scheduleCloseRetry({ ...args, answered: false, arm: "plain" });
          return;
        }
        useLandingTerminalStore
          .getState()
          .clearPendingKill(args.pending.hostId, args.pending.sessionId);
        clearCapableCloseRetry(args.refs.retries.current, args.key);
      },
      () => scheduleCloseRetry({ ...args, answered: false, arm: "plain" }),
    )
    .finally(() => {
      const next = new Set(args.refs.inFlight.current);
      next.delete(args.key);
      args.refs.inFlight.current = next;
      // Clearing a ref renders nothing, so without this the drain never looks
      // at this key again on its own: an authority change that arrived while
      // the request was in flight was skipped for being in flight, and the
      // settlement that released it is invisible.
      args.signalRetry();
    });
}

/**
 * The legacy arm of the same drain, with the same backoff.
 *
 * It used to be a bare `mutate` with no rejection handling, which was survivable
 * only because an offline close could not be recorded in the first place: the
 * close affordance gated on a resolved authority, so this path ran almost
 * exclusively for a host that was already answering. Now that a tab bound to an
 * offline host is closable, this IS the path a legacy host's deferred kill
 * travels, and one transient rejection would have stranded the PTY until an
 * unrelated route flap or a reload.
 *
 * The tombstone is cleared by the mutation's own `onSuccess`, not here: an
 * acknowledgement is the durable boundary, and only the mutation sees it.
 */
function dispatchLegacyClose(args: {
  readonly kill: LandingTerminalKillDispatch;
  readonly key: string;
  readonly pending: LandingTerminalPendingKill;
  readonly retry: CapableCloseRetry | undefined;
  readonly refs: TombstoneRetryRefs;
  readonly signalRetry: () => void;
}): void {
  if (args.retry !== undefined) args.retry.due = false;
  args.refs.inFlight.current = new Set([
    ...args.refs.inFlight.current,
    args.key,
  ]);
  void requestLandingTerminalClose({
    hostId: args.pending.hostId,
    sessionId: args.pending.sessionId,
    // Same boundary the capable arm uses. `terminal.kill` is scheduled `fifo`
    // and `selectJob` returns null for fifo rather than joining an identical
    // queued job, so an unmediated duplicate is two real RPCs and two
    // invalidations for one gesture.
    close: () =>
      args.kill
        .mutateAsync({
          hostId: args.pending.hostId,
          sessionId: args.pending.sessionId,
        })
        .then(() => undefined),
  })
    .then(
      // Resolution is not proof the kill happened. `terminal.kill` reports an
      // already-gone session as DATA (`killed: false`), and the mutation's
      // `onSuccess` deliberately KEEPS the tombstone for the one shape where
      // that answer means "not created yet" rather than "gone" - a session
      // whose `terminal.plain.create` had not settled, whose terminal lands
      // afterwards under this same client-supplied id.
      //
      // Clearing the retry there stranded it: the promise resolved, so the
      // reject arm never ran, and the outer drain skips a key it has already
      // attempted on this arm - leaving nothing at all to send the kill until
      // an unrelated route or capability flap. An outstanding record after a
      // resolved close is a kill that is still owed, so it is retried on the
      // same backoff a rejection would have earned.
      () => {
        if (
          useLandingTerminalStore
            .getState()
            .pendingKills.some(
              (candidate) =>
                candidate.hostId === args.pending.hostId &&
                candidate.sessionId === args.pending.sessionId,
            )
        ) {
          scheduleCloseRetry({ ...args, answered: true, arm: "kill" });
          return;
        }
        clearCapableCloseRetry(args.refs.retries.current, args.key);
      },
      () => scheduleCloseRetry({ ...args, answered: false, arm: "kill" }),
    )
    .finally(() => {
      const next = new Set(args.refs.inFlight.current);
      next.delete(args.key);
      args.refs.inFlight.current = next;
      // Clearing a ref renders nothing, so without this the drain never looks
      // at this key again on its own: an authority change that arrived while
      // the request was in flight was skipped for being in flight, and the
      // settlement that released it is invisible.
      args.signalRetry();
    });
}

/** Routes a tombstone to whatever `intendedCloseAction` selected for it. */
function dispatchTombstoneClose(args: {
  readonly action: TombstoneCloseAction;
  readonly entry: LandingTerminalAuthorityEntry | undefined;
  readonly kill: LandingTerminalKillDispatch;
  readonly key: string;
  readonly pending: LandingTerminalPendingKill;
  readonly retry: CapableCloseRetry | undefined;
  readonly refs: TombstoneRetryRefs;
  readonly signalRetry: () => void;
}): void {
  const { entry } = args;
  if (entry === undefined) return;
  if (args.action === "wait") return;
  if (args.action === "discard") {
    // Two shapes reach here, both of them a record the host has ANSWERED:
    //
    // - a capable host with a FRESH listing that does not name a session it had
    //   already acknowledged. That host published the session once, so its
    //   disappearance is the host saying it is gone.
    // - a `pendingCreate` record whose reprieve is spent
    //   (`PENDING_CREATE_KILL_ANSWER_BUDGET`). The host has answered "no such
    //   session" for the whole attempt ladder, and the create that could have
    //   contradicted it can no longer be observed from here.
    useLandingTerminalStore
      .getState()
      .clearPendingKill(args.pending.hostId, args.pending.sessionId);
    clearCapableCloseRetry(args.refs.retries.current, args.key);
    return;
  }
  if (args.action === "plain") {
    dispatchCapableClose({
      entry,
      key: args.key,
      pending: args.pending,
      retry: args.retry,
      refs: args.refs,
      signalRetry: args.signalRetry,
    });
    return;
  }
  dispatchLegacyClose({
    kill: args.kill,
    key: args.key,
    pending: args.pending,
    retry: args.retry,
    refs: args.refs,
    signalRetry: args.signalRetry,
  });
}

/**
 * Drains durable landing-terminal close tombstones when their bound host
 * returns. This lives above the router so leaving the landing page cannot
 * strand an offline-close shell until the user happens to return home.
 */
export function LandingTerminalTombstoneRecoveryBridge(): ReactNode {
  const directory = useHostDirectoryList();
  const binding = useHostBinding();
  const pendingKills = useLandingTerminalStore((state) => state.pendingKills);
  const kill = useLandingTerminalKill();
  const killRef = useRef(kill);
  const inFlightRef = useRef<ReadonlySet<string>>(new Set());
  /**
   * Tombstone keys this bridge has dispatched, against the ARM each was
   * dispatched on - so anything that changes the arm makes the key eligible
   * again rather than resting on a mark left by a different request.
   *
   * The arm, not the host's capability: those stopped being the same thing once
   * a capable host could serve either. Marking by capability left a `kill`-arm
   * backoff parked after an in-flight create finally appeared in the
   * projection, because the host had been `capable` throughout.
   */
  const attemptedRef = useRef<ReadonlyMap<string, TombstoneCloseArm>>(
    new Map(),
  );
  const retriesRef = useRef<Map<string, CapableCloseRetry>>(new Map());
  const mountedRef = useRef(true);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const [fleetSettled, setFleetSettled] = useState(false);
  const [authorityEntries, setAuthorityEntries] =
    useState<LandingTerminalAuthorityEntries>({});
  const handleAuthorityEntry = useCallback(
    (hostId: string, entry: LandingTerminalAuthorityEntry | null): void => {
      setAuthorityEntries((current) => {
        if (entry !== null) {
          if (current[hostId] === entry) return current;
          return { ...current, [hostId]: entry };
        }
        if (current[hostId] === undefined) return current;
        const next = { ...current };
        delete next[hostId];
        return next;
      });
    },
    [],
  );
  // Coarse, through the canonical rule. The edge this watches is "a route to
  // that host exists again", because what it does on that edge is send an RPC —
  // there is no copy here and nobody sees this. Asking `dialableHostEndpoint`
  // rather than the bit keeps it agreeing with the layer that will carry the
  // kill: an `indeterminate` host is dialable, so the tombstone drains and the
  // mutation either lands or fails on its own evidence, instead of waiting
  // forever on a liveness read that may never come back.
  //
  // It is also why the edge is "became DIALABLE" rather than "became
  // available": a host recovering from a stall goes unavailable -> busy and may
  // sit there, and busy is dialable, so an `=== "available"` edge would simply
  // never fire and would strand the tombstone with the host terminal alive.
  //
  // One dial-permission state is deliberately EXCLUDED from the recorded bit:
  // a registry-`offline` host inside the relay-fuse window
  // (`isRelayFuseRecoveryCandidate`). There the endpoint is non-null because a
  // recovery dial is PERMITTED, not because the host is there - recording that
  // speculative permission as `true` made a close-during-grace followed by a
  // genuine offline -> connectable recovery a `true -> true` non-edge, so the
  // kill never re-fired and the tombstoned PTY outlived its tab until
  // relaunch. `indeterminate` keeps recording `true` (the paragraph above),
  // because unlike a fuse-window `offline` it may never resolve.
  //
  // A READY remote session overrides that exclusion: it is proof the host is
  // actually attached, not speculation - the recovery dial the fuse window
  // kept open has SUCCEEDED. If the registry stays `offline` for the rest of
  // the credential-plane incident, that session is the only evidence of the
  // recovery there will be, and it is also the very route the kill travels.
  // The session cache is pull-only, so the subscription below - not the
  // directory - is what re-runs this effect when a session becomes ready.
  const dialableRef = useRef<ReadonlyMap<string, TombstoneDrainability>>(
    new Map(),
  );
  const directoryHostIds = useMemo(
    () => (directory.data ?? []).map((entry) => entry.hostId),
    [directory.data],
  );
  // Which hosts get an authority probe mounted below. A tombstone names the one
  // host that can drain it, so ordinarily that is simply "every host with a
  // tombstone" - but a host that has LEFT the account cannot answer, and
  // probing it forever is the cost an outstanding tombstone would otherwise
  // impose indefinitely.
  //
  // Scoping the PROBE is the whole remedy; the tombstone itself is never
  // dropped. Deregistration is not destruction: `host-deregister-fetcher`
  // revokes the credential and nothing else - "the `hostId` survives, so
  // nothing about the machine changes", and "re-enrollment re-adopts the SAME
  // id". So a departed host's PTY can genuinely still be running, and the
  // machine can come back under the id its tombstone already names. Deleting
  // the tombstone would destroy the only record that shell needs killing,
  // exactly when it would have become useful again. Withholding the probe costs
  // a probe; withholding it wrongly costs nothing, because the host reappears
  // in the fleet and the probe mounts on the next snapshot.
  //
  // An UNSETTLED fleet - nobody has reached the registry yet, including after a
  // `signed-out` clear while auth settles - probes everything, because absence
  // from a fleet nobody has answered for is not evidence of anything. The rows
  // cannot carry that distinction themselves, which is what `hasSettledFleet()`
  // is for: a machine with a local host renders one ordinary row whether the
  // registry answered or not.
  //
  // The flag and the rows are read separately and the rows can lag it by a
  // beat. That is fine HERE and only because nothing is destroyed: the worst a
  // stale pairing does is withhold a probe until the next snapshot, which also
  // makes an auth-identity transition harmless.
  const authorityHostIds = useMemo(() => {
    const tombstoned = [
      ...new Set(pendingKills.map((pending) => pending.hostId)),
    ];
    if (!fleetSettled) return tombstoned;
    const fleet = new Set(directoryHostIds);
    return tombstoned.filter((hostId) => fleet.has(hostId));
  }, [directoryHostIds, fleetSettled, pendingKills]);
  const hasReadySessionFor = useRemoteSessionsPollReadiness(directoryHostIds);
  const authorityEntriesRef = useRef(authorityEntries);

  useEffect(() => {
    killRef.current = kill;
  }, [kill]);

  // Settlement has to be SUBSCRIBED, not read during render. The flag flips on
  // a committed listing, and the service emits for exactly that reason - but
  // the rows it emits can be deeply equal to the previous ones (a desktop whose
  // one local host is the whole snapshot, with an empty remote listing), and
  // TanStack's structural sharing then hands back the SAME `data` array. A
  // derivation keyed on the rows would never see the flag move, and would keep
  // probing departed hosts for the rest of the session.
  useEffect(() => {
    const directoryService = binding?.directory ?? null;
    if (directoryService === null) return;
    const syncFleetSettled = (): void => {
      setFleetSettled(directoryService.hasSettledFleet());
    };
    syncFleetSettled();
    const subscription = directoryService.onChange(syncFleetSettled);
    return () => {
      subscription.dispose();
    };
  }, [binding]);

  useEffect(() => {
    authorityEntriesRef.current = authorityEntries;
  }, [authorityEntries]);

  useEffect(() => {
    mountedRef.current = true;
    const retries = retriesRef.current;
    return () => {
      mountedRef.current = false;
      for (const retry of retries.values()) {
        if (retry.timer !== null) clearTimeout(retry.timer);
      }
      retries.clear();
    };
  }, []);

  useEffect(() => {
    const entries = directory.data ?? [];
    const currentDrainable = new Map(
      entries.map((entry) => [
        entry.hostId,
        landingTerminalTombstoneDrainability(
          entry,
          hasReadySessionFor(entry.hostId),
          authorityEntries[entry.hostId],
        ),
      ]),
    );
    const previousDialable = dialableRef.current;
    dialableRef.current = currentDrainable;
    const retryRefs: TombstoneRetryRefs = {
      authorityEntries: authorityEntriesRef,
      dialable: dialableRef,
      inFlight: inFlightRef,
      mounted: mountedRef,
      retries: retriesRef,
    };

    const pendingKeys = new Set(
      pendingKills.map((pending) =>
        terminalSessionKey(pending.hostId, pending.sessionId),
      ),
    );
    cancelUndrainableCapableCloseRetries({
      retries: retriesRef.current,
      pendingKeys,
      drainableByHostId: currentDrainable,
    });
    // Forget keys that are no longer outstanding, so a session id that is
    // tombstoned again later is seen fresh rather than inheriting the earlier
    // close's "already dispatched" mark.
    attemptedRef.current = new Map(
      [...attemptedRef.current].filter(([key]) => pendingKeys.has(key)),
    );

    if (pendingKills.length === 0) return;

    for (const pending of pendingKills) {
      // The `kill` arm is the gate, not both arms: a capable host whose listing
      // has merely gone stale can still serve `terminal.kill`, and waiting for
      // freshness parked the tombstones that never needed it.
      const drainable = currentDrainable.get(pending.hostId);
      if (drainable?.kill !== true) continue;
      const key = terminalSessionKey(pending.hostId, pending.sessionId);
      const retry = retriesRef.current.get(key);
      const entry = authorityEntries[pending.hostId];
      const decision = tombstoneDispatchDecision({
        attempted: attemptedRef.current,
        drainable,
        entry,
        key,
        pending,
        previous: previousDialable.get(pending.hostId),
        retry,
      });
      if (decision.action === "wait" || !decision.admitted) continue;
      if (inFlightRef.current.has(key)) continue;
      // Only a real arm is marked. A discard sends nothing, so there is no
      // attempt to record against it.
      if (decision.firstSight && decision.arm !== null) {
        attemptedRef.current = new Map([
          ...attemptedRef.current,
          [key, decision.arm],
        ]);
      }
      dispatchTombstoneClose({
        action: decision.action,
        entry,
        kill: killRef.current,
        key,
        pending,
        retry,
        refs: retryRefs,
        signalRetry: () => setRetryGeneration((current) => current + 1),
      });
    }
  }, [
    authorityEntries,
    directory.data,
    pendingKills,
    hasReadySessionFor,
    retryGeneration,
  ]);

  return (
    <LandingTerminalAuthorityFleet
      hostIds={authorityHostIds}
      onEntry={handleAuthorityEntry}
    />
  );
}
