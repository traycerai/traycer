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
 * Ceiling on the retry interval - and there is deliberately NO ceiling on the
 * number of attempts.
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

interface CapableCloseRetry {
  attempt: number;
  timer: number | null;
  due: boolean;
  /**
   * The protocol these attempts were spent on. The budget is per-protocol: a
   * host that changes capability gets a fresh one, because the attempts that
   * failed were spent on a different request against a different arm.
   */
  capability: "capable" | "legacy";
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
  readonly dialable: { current: ReadonlyMap<string, boolean> };
  readonly inFlight: { current: ReadonlySet<string> };
  readonly mounted: { current: boolean };
  readonly retries: { current: Map<string, CapableCloseRetry> };
}

function hostCanDrainLandingTerminalTombstones(
  directoryEntry: HostDirectoryEntry,
  hasReadySession: boolean,
  authorityEntry: LandingTerminalAuthorityEntry | undefined,
): boolean {
  const routeReady =
    dialableHostEndpointFor(directoryEntry, hasReadySession) !== null &&
    (hasReadySession || !isRelayFuseRecoveryCandidate(directoryEntry));
  const authority = authorityEntry?.authority;
  const authorityReady =
    authority?.capability.status === "legacy" ||
    (authority?.capability.status === "capable" && authority.canMutate);
  return routeReady && authorityReady;
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
  readonly drainableByHostId: ReadonlyMap<string, boolean>;
}): void {
  for (const key of args.retries.keys()) {
    const hostId = key.slice(0, key.indexOf("\u0000"));
    if (
      args.pendingKeys.has(key) &&
      args.drainableByHostId.get(hostId) === true
    ) {
      continue;
    }
    clearCapableCloseRetry(args.retries, key);
  }
}

/**
 * Whether another attempt at this tombstone could still land.
 *
 * Both capabilities require the tombstone to be outstanding and the route to
 * still be there. Only the CAPABLE arm additionally demands a projection: its
 * close names a terminal the host is publishing, so a vanished projection means
 * the session is already gone. Legacy has no projection to consult - the kill
 * is addressed to the host by session id alone - so requiring one would make
 * the legacy arm unretryable, which is the state this replaced.
 */
function closeRetryStillWarranted(args: {
  readonly pending: LandingTerminalPendingKill;
  readonly refs: TombstoneRetryRefs;
  readonly capability: "capable" | "legacy";
}): boolean {
  const stillPending = useLandingTerminalStore
    .getState()
    .pendingKills.some(
      (candidate) =>
        candidate.hostId === args.pending.hostId &&
        candidate.sessionId === args.pending.sessionId,
    );
  if (!stillPending) return false;
  if (args.refs.dialable.current.get(args.pending.hostId) !== true) {
    return false;
  }
  const currentEntry = args.refs.authorityEntries.current[args.pending.hostId];
  if (args.capability === "legacy") {
    return currentEntry?.authority.capability.status === "legacy";
  }
  if (
    currentEntry?.authority.capability.status !== "capable" ||
    !currentEntry.authority.canMutate
  ) {
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
  readonly capability: "capable" | "legacy";
  readonly signalRetry: () => void;
}): void {
  if (!args.refs.mounted.current) return;
  if (!closeRetryStillWarranted(args)) return;
  // A record belonging to the OTHER protocol is discarded outright, timer and
  // all. Keeping it would block this arm twice over: its armed timer makes the
  // guard below return, and its attempt count would hand a host that just
  // changed protocol the long interval the failed arm ran up. A protocol change
  // deserves a prompt attempt on a clean schedule.
  const stale = args.refs.retries.current.get(args.key);
  if (stale !== undefined && stale.capability !== args.capability) {
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
    timer: null,
    due: false,
    capability: args.capability,
  };
  nextRetry.timer = window.setTimeout(() => {
    if (!args.refs.mounted.current) return;
    nextRetry.timer = null;
    nextRetry.due = true;
    args.signalRetry();
  }, retryDelay);
  args.refs.retries.current.set(args.key, nextRetry);
}

function dispatchCapableClose(args: {
  readonly entry: LandingTerminalAuthorityEntry;
  readonly key: string;
  readonly pending: LandingTerminalPendingKill;
  readonly retry: CapableCloseRetry | undefined;
  readonly refs: TombstoneRetryRefs;
  readonly signalRetry: () => void;
}): void {
  if (
    getPlainTerminal(
      args.entry.authority.collection,
      args.pending.hostId,
      args.pending.sessionId,
    ) === undefined
  ) {
    useLandingTerminalStore
      .getState()
      .clearPendingKill(args.pending.hostId, args.pending.sessionId);
    clearCapableCloseRetry(args.refs.retries.current, args.key);
    return;
  }
  if (args.retry !== undefined) args.retry.due = false;
  args.refs.inFlight.current = new Set([
    ...args.refs.inFlight.current,
    args.key,
  ]);
  void requestLandingTerminalClose({
    hostId: args.pending.hostId,
    sessionId: args.pending.sessionId,
    // Joins the panel's fast path when that gesture is still in flight, rather
    // than racing it to the same terminal. Either way this observes the real
    // settlement below.
    close: () =>
      args.entry.mutations.close
        .mutateAsync({
          hostId: args.pending.hostId,
          terminalId: args.pending.sessionId,
        })
        .then(() => undefined),
  })
    .then(
      () => {
        useLandingTerminalStore
          .getState()
          .clearPendingKill(args.pending.hostId, args.pending.sessionId);
        clearCapableCloseRetry(args.refs.retries.current, args.key);
      },
      () => scheduleCloseRetry({ ...args, capability: "capable" }),
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
      () => clearCapableCloseRetry(args.refs.retries.current, args.key),
      () => scheduleCloseRetry({ ...args, capability: "legacy" }),
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

/** Routes a drainable tombstone to the arm its host's capability calls for. */
function dispatchTombstoneClose(args: {
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
  if (entry.authority.capability.status === "capable") {
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
  if (entry.authority.capability.status !== "legacy") return;
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
   * Tombstone keys this bridge has dispatched, against the CAPABILITY each was
   * dispatched under - a host that changes protocol makes its key eligible
   * again rather than resting on a mark left by the other arm.
   */
  const attemptedRef = useRef<
    ReadonlyMap<string, "unknown" | "legacy" | "capable">
  >(new Map());
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
  const dialableRef = useRef<ReadonlyMap<string, boolean>>(new Map());
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
        hostCanDrainLandingTerminalTombstones(
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
      if (currentDrainable.get(pending.hostId) !== true) continue;
      const key = terminalSessionKey(pending.hostId, pending.sessionId);
      const retry = retriesRef.current.get(key);
      const routeRecovered = previousDialable.get(pending.hostId) !== true;
      // A tombstone recorded while its host was ALREADY drainable has no route
      // transition to ride in on and no retry record yet, so the two conditions
      // above would skip it until the host happened to flap. That was
      // survivable while a close could only be recorded against a resolved
      // authority - the panel's fast path had already sent the kill - but a
      // close under an unresolved probe records the tombstone and dispatches
      // nothing, and the bridge is then the only thing that will ever send it.
      //
      // The mark records the CAPABILITY it was dispatched under, so a host that
      // changes protocol while staying dialable is seen fresh again. Without
      // that, a close rejected after the authority flipped is abandoned:
      // `closeRetryStillWarranted` refuses to schedule a retry because the
      // capability no longer matches the one that dispatched, the
      // authority-change render skipped this key while it was still in
      // `inFlightRef`, and clearing that ref renders nothing - so the
      // capability-correct close would never be sent.
      const entry = authorityEntries[pending.hostId];
      const capability = entry?.authority.capability.status;
      const firstSight = attemptedRef.current.get(key) !== capability;
      if (!routeRecovered && !firstSight && retry?.due !== true) continue;
      if (inFlightRef.current.has(key)) continue;
      // Reached only where the host is drainable, which already required the
      // authority entry to be `legacy` or capable+`canMutate` - so this marks a
      // key that one of the two branches below is about to dispatch, never one
      // parked waiting for its probe.
      if (firstSight && capability !== undefined) {
        attemptedRef.current = new Map([
          ...attemptedRef.current,
          [key, capability],
        ]);
      }
      dispatchTombstoneClose({
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
