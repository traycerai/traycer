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
/** Retry-interval ceiling. No attempt ceiling except `PENDING_CREATE_KILL_ANSWER_BUDGET`. */
const CAPABLE_CLOSE_RETRY_MAX_MS = 300_000;

/** `terminal.kill` answers a pending-create tombstone may spend. Count answers, never attempts. A live projection outranks a spent budget. */
const PENDING_CREATE_KILL_ANSWER_BUDGET = 10;

/** RPC a drain attempt used, not the host's reported capability. */
type TombstoneCloseArm = "plain" | "kill";

interface CapableCloseRetry {
  attempt: number;
  /** Host-answered settlements that left the tombstone outstanding. Not attempts: rejections are not answers. */
  answers: number;
  timer: number | null;
  due: boolean;
  /** Arm these attempts were spent on. Changing arm gets a fresh budget. */
  arm: TombstoneCloseArm;
}

/** Kill-mutation slice this file dispatches through. */
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
 * Arms this host can serve right now. Not one boolean: `canMutate` is list-stream freshness, and only `plain` reads the list.
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
    // Keyed on the `kill` arm: a stale listing can still serve a kill.
    if (
      args.pendingKeys.has(key) &&
      args.drainableByHostId.get(hostId)?.kill === true
    ) {
      continue;
    }
    clearCapableCloseRetry(args.retries, key);
  }
}

/** Whether another attempt could still land. Both arms need an outstanding tombstone and a route. Only `plain` also needs a projection; `kill` needs some resolved authority. */
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
  // Per-arm: a stale listing stops only the arm that reads one.
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
  /** Host answered and the tombstone survived. A rejection is not an answer. */
  readonly answered: boolean;
  readonly signalRetry: () => void;
}): void {
  if (!args.refs.mounted.current) return;
  if (!closeRetryStillWarranted(args)) return;
  // Discard the other arm's record: keeping it would block this arm with the failed arm's timer and interval.
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
    // Carried across same-arm attempts; reset when the arm changes.
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

/** `discard` and `wait` both send nothing: one drops an answered record, the other keeps an owed kill. One decider for both the drain mark and `dispatchTombstoneClose`. */
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
  // A live projection outranks every absence-based decision, including a spent reprieve.
  const projected =
    capability === "capable" &&
    args.plainDrainable &&
    getPlainTerminal(
      authority.collection,
      args.pending.hostId,
      args.pending.sessionId,
    ) !== undefined;
  if (projected) return "plain";
  // Bound pending-create before the capability split: it routes to `terminal.kill` on both arms.
  if (
    args.pending.pendingCreate &&
    args.killAnswers >= PENDING_CREATE_KILL_ANSWER_BUDGET
  ) {
    return "discard";
  }
  if (capability === "legacy") return "kill";
  if (!args.plainDrainable) {
    // A stale listing blocks only the arm that reads a listing.
    return absentListingProvesDeath(args.pending) ? "wait" : "kill";
  }
  // No projection: `plain` would reject a terminal this host does not know. `kill` covers in-flight create and upgraded-legacy.
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

/** Admit a send on arm recovery, first sight of this arm, or a due retry. Key the edge on the arm's own drainability, not the host's; the mark records the arm, not capability. */
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
    // Only answers on this arm count toward the pending-create reprieve.
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
    // Join the panel's in-flight close rather than racing it. Only the owner may treat the settlement as an answer.
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
        // Only the owner retires the record. A joiner must leave the drain able to send; schedule the rejection backoff.
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
      // Clearing a ref renders nothing; signal so the drain re-looks at this key after in-flight settlement.
      args.signalRetry();
    });
}

/**
 * Legacy arm of the same drain. Tombstone is cleared by the mutation's `onSuccess`, not here.
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
    // Same join boundary as the capable arm: `fifo` does not join identical queued jobs.
    close: () =>
      args.kill
        .mutateAsync({
          hostId: args.pending.hostId,
          sessionId: args.pending.sessionId,
        })
        .then(() => undefined),
  })
    .then(
      // Resolution is not proof of kill: `killed: false` keeps a pending-create tombstone. Retry an outstanding record.
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
      // Clearing a ref renders nothing; signal so the drain re-looks at this key after in-flight settlement.
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
    // Host has answered: a fresh listing no longer names the session, or the pending-create reprieve is spent.
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

/** Drains close tombstones when the bound host returns. Lives above the router so leaving landing cannot strand a shell. */
export function LandingTerminalTombstoneRecoveryBridge(): ReactNode {
  const directory = useHostDirectoryList();
  const binding = useHostBinding();
  const pendingKills = useLandingTerminalStore((state) => state.pendingKills);
  const kill = useLandingTerminalKill();
  const killRef = useRef(kill);
  const inFlightRef = useRef<ReadonlySet<string>>(new Set());
  /** Dispatched keys keyed by arm, so an arm change makes the key eligible again. */
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
  // Edge is "became dialable", not "became available". Exclude relay-fuse `offline` (speculative); a ready remote session overrides that exclusion.
  const dialableRef = useRef<ReadonlyMap<string, TombstoneDrainability>>(
    new Map(),
  );
  const directoryHostIds = useMemo(
    () => (directory.data ?? []).map((entry) => entry.hostId),
    [directory.data],
  );
  // Probe tombstoned hosts still in the fleet. Never drop the tombstone. An unsettled fleet probes everything.
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

  // Subscribe to settlement: structural sharing can keep the same `data` array, so a row-keyed derivation would miss the flag.
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
    // Forget keys that are no longer outstanding so a later tombstone of the same session is seen fresh.
    attemptedRef.current = new Map(
      [...attemptedRef.current].filter(([key]) => pendingKeys.has(key)),
    );

    if (pendingKills.length === 0) return;

    for (const pending of pendingKills) {
      // Gate on the `kill` arm: a stale listing can still serve `terminal.kill`.
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
      // Only a real arm is marked. A discard sends nothing.
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
