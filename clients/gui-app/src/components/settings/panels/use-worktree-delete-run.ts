import { useCallback, useEffect, useMemo, useRef } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { WorktreeBusyHolder } from "@traycer/protocol/framework/worktree-busy-holders";
import type {
  WorktreeDeleteOutputChannel,
  WorktreeDeletePhase,
} from "@traycer/protocol/host/worktree-delete-stream";
import type { WorktreeHostEntry } from "@traycer/protocol/host/index";
import type { WorktreeEntryScripts } from "@traycer/protocol/host/worktree-schemas";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import { WorktreeDeleteStreamClient } from "@traycer-clients/shared/host-transport/worktree-delete-stream-client";
import { WorktreeDeleteBatchStreamClient } from "@traycer-clients/shared/host-transport/worktree-delete-batch-stream-client";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import { openOwnedDurableStreamClient } from "@/lib/host/owned-durable-stream-client";
import {
  Analytics,
  AnalyticsEvent,
  analyticsBlockerFromError,
} from "@/lib/analytics";
import { sanitizeHoldersRevision } from "@/lib/worktree/teardown-holder-copy";

export interface LogSegment {
  /** Monotonic per-run id (append-only), so React keys are stable. */
  readonly id: number;
  readonly channel: WorktreeDeleteOutputChannel;
  readonly text: string;
}

export interface WorktreeDeleteRunState {
  readonly status: "queued" | "running" | "complete" | "failed";
  /** Whether a teardown step runs - known once the `started` frame arrives. */
  readonly hasTeardown: boolean;
  readonly activePhase: WorktreeDeletePhase | null;
  readonly log: readonly LogSegment[];
  readonly deleted: boolean;
  readonly error: string | null;
  /**
   * Typed `WORKTREE_BUSY` inventory from a 1.1 refusal. Non-null means the
   * GUI should confirm stop-and-delete instead of showing the generic error.
   * `null` is the old-host path (prose reason only).
   */
  readonly pendingBusyHolders: readonly WorktreeBusyHolder[] | null;
  /**
   * Digest from the refusal that populated `pendingBusyHolders`. Echoed as
   * `expectedHoldersRevision` on the confirmed retry so the host stops the
   * consented inventory, not whatever exists now.
   */
  readonly pendingHoldersRevision: string | undefined;
}

const INITIAL_RUN: WorktreeDeleteRunState = {
  status: "running",
  hasTeardown: false,
  activePhase: null,
  log: [],
  deleted: false,
  error: null,
  pendingBusyHolders: null,
  pendingHoldersRevision: undefined,
};

const QUEUED_RUN: WorktreeDeleteRunState = {
  ...INITIAL_RUN,
  status: "queued",
};

// Fan-out cap for the FALLBACK path only (an older host with no batch
// command method). On a current host the same cap lives on the host, where it
// can actually bound the machine rather than one window's share of it.
const MAX_PARALLEL_DELETE_STREAMS = 2;
const CONNECTION_LOST_MESSAGE =
  "Lost connection to the host before the delete finished.";
// A target the host settled while this client was disconnected. The host does
// not replay per-target frames on re-attach, so its individual outcome is
// genuinely unknown here - the refreshed list is the authority, and inventing
// "deleted" or "failed" for it would be a guess presented as a result.
const REATTACHED_MESSAGE =
  "Reconnected after this delete finished. Check the refreshed list to see whether this worktree was removed.";

export interface WorktreeDeleteRunRecord {
  readonly key: string;
  readonly hostId: string;
  readonly batchKey: string | null;
  readonly target: WorktreeHostEntry;
  readonly run: WorktreeDeleteRunState;
  readonly backgrounded: boolean;
}

export interface WorktreeDeleteProgressSummary {
  /** Stable identities of the deletion actions included in this summary. */
  readonly scopeKeys: readonly string[];
  readonly total: number;
  readonly deleted: number;
  readonly failed: number;
  readonly active: number;
}

interface WorktreeDeleteRunStore {
  readonly runs: readonly WorktreeDeleteRunRecord[];
  readonly foregroundKey: string | null;
  readonly begin: (input: {
    readonly key: string;
    readonly hostId: string;
    readonly batchKey: string | null;
    readonly target: WorktreeHostEntry;
    readonly run: WorktreeDeleteRunState;
    readonly backgrounded: boolean;
  }) => void;
  readonly updateRun: (
    key: string,
    updater: (run: WorktreeDeleteRunState) => WorktreeDeleteRunState,
  ) => void;
  readonly completeRun: (key: string, deleted: boolean) => void;
  readonly failRun: (key: string, error: string) => void;
  readonly setBackgrounded: (key: string, backgrounded: boolean) => void;
  readonly backgroundForegroundForHost: (hostId: string) => void;
  readonly clearTerminalBackgroundedForHost: (hostId: string) => void;
  readonly clearSettledSuccessesForHostIfQuiescent: (hostId: string) => void;
  readonly clearCompletedDeletedMissingFromList: (
    hostId: string,
    visibleWorktreePaths: ReadonlySet<string>,
  ) => void;
  readonly clear: (key: string) => void;
  readonly clearAll: () => void;
  readonly setPendingBusyHolders: (
    key: string,
    holders: readonly WorktreeBusyHolder[],
    holdersRevision: string | undefined,
  ) => void;
}

const useWorktreeDeleteRunStore = create<WorktreeDeleteRunStore>((set) => ({
  runs: [],
  foregroundKey: null,
  begin: (input) =>
    set((state) => ({
      runs: upsertRun(state.runs, {
        key: input.key,
        hostId: input.hostId,
        batchKey: input.batchKey,
        target: input.target,
        run: input.run,
        backgrounded: input.backgrounded,
      }),
      foregroundKey: input.backgrounded ? state.foregroundKey : input.key,
    })),
  updateRun: (key, updater) =>
    set((state) => ({
      runs: state.runs.map((record) =>
        record.key === key ? { ...record, run: updater(record.run) } : record,
      ),
    })),
  completeRun: (key, deleted) => {
    // Emission rides the natural non-terminal -> terminal transition (state
    // read before the synchronous update); a replayed/duplicate settle can't
    // double-count and no reporting ledger is needed.
    const existing = useWorktreeDeleteRunStore
      .getState()
      .runs.find((candidate) => candidate.key === key);
    const wasTerminal =
      existing === undefined || worktreeRunIsTerminal(existing.run);
    set((state) => {
      const record = state.runs.find((candidate) => candidate.key === key);
      if (record === undefined) return state;
      const updated: WorktreeDeleteRunRecord = {
        ...record,
        run: {
          ...record.run,
          status: "complete",
          deleted,
          activePhase: null,
          pendingBusyHolders: null,
          pendingHoldersRevision: undefined,
        },
      };
      return {
        runs: state.runs.map((candidate) =>
          candidate.key === key ? updated : candidate,
        ),
        // Re-surface a SINGLE backgrounded delete's modal on a soft failure so
        // the user sees why. A batch item (`batchKey !== null`) stays in the
        // background - popping a modal over the still-running siblings is the
        // bug we are avoiding; its failure shows in the progress strip/toast.
        foregroundKey:
          record.backgrounded && !deleted && record.batchKey === null
            ? key
            : state.foregroundKey,
      };
    });
    if (!wasTerminal) {
      reportTerminalDeleteOutcome(
        key,
        useWorktreeDeleteRunStore.getState().runs,
      );
    }
  },
  failRun: (key, error) => {
    const existing = useWorktreeDeleteRunStore
      .getState()
      .runs.find((candidate) => candidate.key === key);
    const wasTerminal =
      existing === undefined || worktreeRunIsTerminal(existing.run);
    set((state) => {
      const record = state.runs.find((candidate) => candidate.key === key);
      if (record === undefined) return state;
      if (record.run.status === "complete" || record.run.status === "failed") {
        return state;
      }
      return {
        runs: state.runs.map((candidate) =>
          candidate.key === key
            ? {
                ...candidate,
                run: {
                  ...candidate.run,
                  status: "failed",
                  error,
                  pendingBusyHolders: null,
                  pendingHoldersRevision: undefined,
                },
              }
            : candidate,
        ),
        // Same rule as `completeRun`: re-surface a single backgrounded delete's
        // modal on failure, but never pop one for a batch item - batch failures
        // surface non-modally in the progress strip/toast.
        foregroundKey:
          record.backgrounded && record.batchKey === null
            ? key
            : state.foregroundKey,
      };
    });
    if (!wasTerminal) {
      reportTerminalDeleteOutcome(
        key,
        useWorktreeDeleteRunStore.getState().runs,
      );
    }
  },
  setBackgrounded: (key, backgrounded) =>
    set((state) => ({
      runs: state.runs.map((record) =>
        record.key === key ? { ...record, backgrounded } : record,
      ),
      foregroundKey:
        backgrounded && state.foregroundKey === key
          ? null
          : state.foregroundKey,
    })),
  backgroundForegroundForHost: (hostId) =>
    set((state) => {
      const key = state.foregroundKey;
      if (key === null) return state;
      const record = state.runs.find(
        (candidate) => candidate.key === key && candidate.hostId === hostId,
      );
      if (record === undefined || worktreeRunIsTerminal(record.run)) {
        return state;
      }
      return {
        runs: state.runs.map((candidate) =>
          candidate.key === key
            ? { ...candidate, backgrounded: true }
            : candidate,
        ),
        foregroundKey: null,
      };
    }),
  // Acknowledge path for the per-host progress strip: drop every settled
  // (deleted / failed / soft-failed) backgrounded run for the host so a batch
  // that finished with failures stops occupying the strip and the app-wide
  // toast.
  clearTerminalBackgroundedForHost: (hostId) =>
    set((state) => {
      const runs = state.runs.filter(
        (record) =>
          !(
            record.hostId === hostId &&
            record.backgrounded &&
            worktreeRunIsTerminal(record.run)
          ),
      );
      if (runs.length === state.runs.length) return state;
      return {
        runs,
        foregroundKey:
          state.foregroundKey !== null &&
          !runs.some((record) => record.key === state.foregroundKey)
            ? null
            : state.foregroundKey,
      };
    }),
  // Drop a host's successfully-deleted backgrounded runs when nothing for that
  // host is still in flight. The mounted list prunes these via
  // `clearCompletedDeletedMissingFromList`, but a host the user has navigated
  // away from has no mounted list, so without this its successes linger in the
  // app-wide toast forever. Gated on quiescence so it never drops the deleted
  // tally of a batch that is still running.
  clearSettledSuccessesForHostIfQuiescent: (hostId) =>
    set((state) => {
      const hostBackgrounded = state.runs.filter(
        (record) => record.hostId === hostId && record.backgrounded,
      );
      const anyActive = hostBackgrounded.some(
        (record) => !worktreeRunIsTerminal(record.run),
      );
      if (anyActive) return state;
      const runs = state.runs.filter(
        (record) =>
          !(
            record.hostId === hostId &&
            record.backgrounded &&
            record.run.status === "complete" &&
            record.run.deleted
          ),
      );
      if (runs.length === state.runs.length) return state;
      return {
        runs,
        foregroundKey:
          state.foregroundKey !== null &&
          !runs.some((record) => record.key === state.foregroundKey)
            ? null
            : state.foregroundKey,
      };
    }),
  clearCompletedDeletedMissingFromList: (hostId, visibleWorktreePaths) =>
    set((state) => {
      const runs = state.runs.filter((record) => {
        const shouldKeep =
          record.hostId !== hostId ||
          !record.backgrounded ||
          record.run.status !== "complete" ||
          !record.run.deleted ||
          visibleWorktreePaths.has(record.target.worktreePath);
        return shouldKeep;
      });
      if (runs.length === state.runs.length) return state;
      return {
        runs,
        foregroundKey:
          state.foregroundKey !== null &&
          !runs.some((record) => record.key === state.foregroundKey)
            ? null
            : state.foregroundKey,
      };
    }),
  clear: (key) =>
    set((state) => ({
      runs: state.runs.filter((record) => record.key !== key),
      foregroundKey: state.foregroundKey === key ? null : state.foregroundKey,
    })),
  clearAll: () => set({ runs: [], foregroundKey: null }),
  setPendingBusyHolders: (key, holders, holdersRevision) =>
    set((state) => {
      const record = state.runs.find((candidate) => candidate.key === key);
      if (record === undefined) return state;
      return {
        runs: state.runs.map((candidate) =>
          candidate.key === key
            ? {
                ...candidate,
                run: {
                  ...candidate.run,
                  status: "failed",
                  pendingBusyHolders: holders,
                  pendingHoldersRevision: holdersRevision,
                  error: null,
                  activePhase: null,
                },
              }
            : candidate,
        ),
        // Surface the force-delete dialog even for a batch item — holders
        // are consent, not a strip tally.
        foregroundKey: key,
      };
    }),
}));

/**
 * Module-level registry for live per-target delete stream clients (the
 * older-host fallback only). Each host/worktree pair owns its own stream, so
 * backgrounding one delete does not release or overwrite another in-flight
 * delete.
 */
const clientRefs = new Map<string, { close(): void }>();

/**
 * Live command streams, keyed by command id. One entry per user action on a
 * current host, however many worktrees it covers.
 */
const commandRefs = new Map<string, { close(): void }>();

/**
 * Every run key (host + worktree path) currently owned by a command or by the
 * fallback queue.
 *
 * Replaces the old "is there a `clientRefs` entry or a queue entry" check,
 * which no longer answers the question: a target inside a batch command has
 * neither of those, yet starting a second delete for it would be exactly the
 * duplicate destructive action the check exists to prevent.
 */
const activeTargetKeys = new Set<string>();

interface QueuedWorktreeDelete {
  readonly key: string;
  readonly hostId: string;
  readonly target: WorktreeHostEntry;
  readonly scripts: WorktreeEntryScripts | null;
  readonly stopOwners: boolean;
  readonly expectedHoldersRevision: string | undefined;
  readonly openStreamTransport: (hostId: string) => DurableStreamTransport;
  readonly onSettled: () => void;
}

const queuedDeletes: QueuedWorktreeDelete[] = [];
let activeDeleteStreamCount = 0;
let activeCommandCount = 0;
const pendingSettledCallbacks = new Set<() => void>();

/**
 * Owns `worktree.deleteByPath` stream lifecycles for Settings deletes. Each
 * stream is started imperatively from the confirm action (a user event, fired
 * exactly once) rather than a mount effect, so a StrictMode double-invoke can
 * never open the stream twice and trigger two server-side deletes.
 *
 * The run state is global to the Settings surface instead of section-local:
 * switching Settings sections or closing/reopening Settings must not abort a
 * backgrounded delete or lose its row/modal state.
 */
export function useWorktreeDeleteRun(
  hostId: string,
  openStreamTransport: (hostId: string) => DurableStreamTransport,
  onSettled: () => void,
): {
  readonly target: WorktreeHostEntry | null;
  readonly run: WorktreeDeleteRunState | null;
  readonly backgrounded: boolean;
  readonly runs: readonly WorktreeDeleteRunRecord[];
  readonly start: (
    target: WorktreeHostEntry,
    scripts: WorktreeEntryScripts | null,
    stopOwners: boolean,
    expectedHoldersRevision: string | undefined,
  ) => void;
  readonly startBatchBackgrounded: (
    targets: ReadonlyArray<WorktreeHostEntry>,
    scriptsByPath: ReadonlyMap<string, WorktreeEntryScripts>,
  ) => void;
  readonly clearCompletedDeletedMissingFromList: (
    visibleWorktreePaths: ReadonlySet<string>,
  ) => void;
  readonly background: () => void;
  readonly close: () => void;
  readonly dismissTerminalBackgrounded: () => void;
} {
  const { runs, foregroundKey, begin, setBackgrounded, clear } =
    useWorktreeDeleteRunStore(
      useShallow((state) => ({
        runs: state.runs,
        foregroundKey: state.foregroundKey,
        begin: state.begin,
        setBackgrounded: state.setBackgrounded,
        clear: state.clear,
      })),
    );
  const clearCompletedDeletedMissingFromStore = useWorktreeDeleteRunStore(
    (state) => state.clearCompletedDeletedMissingFromList,
  );
  const onSettledRef = useRef(onSettled);
  useEffect(() => {
    onSettledRef.current = onSettled;
  }, [onSettled]);

  const visibleRuns = runs.filter((record) => record.hostId === hostId);
  const visibleRecord =
    foregroundKey === null
      ? null
      : (visibleRuns.find(
          (record) =>
            record.key === foregroundKey && shouldShowProgress(record),
        ) ?? null);

  const background = useCallback(() => {
    if (visibleRecord === null) return;
    setBackgrounded(visibleRecord.key, true);
  }, [setBackgrounded, visibleRecord]);

  // Dismisses the modal's record. On the fallback path that also drops the
  // target's own socket (its historical abort-on-close behaviour, which
  // settles the run and releases its key through the status handler). A target
  // inside a command has no socket of its own, and closing the command's
  // stream here would silence its SIBLINGS - so the command keeps running and
  // releases the key when the target actually settles, which is both the
  // detach-not-cancel contract and what stops a dismissed modal from letting
  // the same worktree be deleted twice concurrently.
  const close = useCallback(() => {
    if (visibleRecord === null) return;
    closeDeleteClient(visibleRecord.key);
    discardQueuedDelete(visibleRecord.key);
    clear(visibleRecord.key);
  }, [clear, visibleRecord]);

  const startDelete = useCallback(
    (
      targets: ReadonlyArray<WorktreeDeleteRequestTarget>,
      backgrounded: boolean,
      batchKey: string | null,
    ) => {
      // Freeze the settle callback at start so a host swap mid-delete can't
      // redirect the cache invalidation to the wrong host scope (the live
      // `onSettledRef` would otherwise rebind to the newly-selected host).
      startWorktreeDeleteCommand({
        hostId,
        batchKey,
        backgrounded,
        targets,
        begin,
        openStreamTransport,
        onSettled: onSettledRef.current,
      });
    },
    [begin, hostId, openStreamTransport],
  );
  const start = useCallback(
    (
      target: WorktreeHostEntry,
      scripts: WorktreeEntryScripts | null,
      stopOwners: boolean,
      expectedHoldersRevision: string | undefined,
    ) => {
      startDelete(
        [{ target, scripts, stopOwners, expectedHoldersRevision }],
        false,
        null,
      );
    },
    [startDelete],
  );
  const startBatchBackgrounded = useCallback(
    (
      targets: ReadonlyArray<WorktreeHostEntry>,
      scriptsByPath: ReadonlyMap<string, WorktreeEntryScripts>,
    ) => {
      startDelete(
        targets.map((target) => ({
          target,
          scripts: scriptsByPath.get(target.worktreePath) ?? null,
          stopOwners: false,
          expectedHoldersRevision: undefined,
        })),
        true,
        nextWorktreeDeleteBatchKey(hostId),
      );
    },
    [hostId, startDelete],
  );
  const clearCompletedDeletedMissingFromList = useCallback(
    (visibleWorktreePaths: ReadonlySet<string>): void => {
      clearCompletedDeletedMissingFromStore(hostId, visibleWorktreePaths);
    },
    [clearCompletedDeletedMissingFromStore, hostId],
  );
  const dismissTerminalBackgrounded = useCallback(() => {
    clearTerminalBackgroundedWorktreeDeletesForHost(hostId);
  }, [hostId]);

  return {
    target: visibleRecord?.target ?? null,
    run: visibleRecord?.run ?? null,
    backgrounded: visibleRecord?.backgrounded ?? false,
    runs: visibleRuns,
    start,
    startBatchBackgrounded,
    clearCompletedDeletedMissingFromList,
    background,
    close,
    dismissTerminalBackgrounded,
  };
}

export function __resetWorktreeDeleteRunForTests(): void {
  clientRefs.forEach((client) => client.close());
  clientRefs.clear();
  commandRefs.forEach((client) => client.close());
  commandRefs.clear();
  activeTargetKeys.clear();
  queuedDeletes.length = 0;
  activeDeleteStreamCount = 0;
  activeCommandCount = 0;
  pendingSettledCallbacks.clear();
  batchSequence = 0;
  useWorktreeDeleteRunStore.getState().clearAll();
}

interface WorktreeDeleteRequestTarget {
  readonly target: WorktreeHostEntry;
  readonly scripts: WorktreeEntryScripts | null;
  readonly stopOwners: boolean;
  readonly expectedHoldersRevision: string | undefined;
}

interface StartWorktreeDeleteCommandInput {
  readonly hostId: string;
  readonly batchKey: string | null;
  readonly backgrounded: boolean;
  readonly targets: ReadonlyArray<WorktreeDeleteRequestTarget>;
  readonly begin: (input: {
    readonly key: string;
    readonly hostId: string;
    readonly batchKey: string | null;
    readonly target: WorktreeHostEntry;
    readonly run: WorktreeDeleteRunState;
    readonly backgrounded: boolean;
  }) => void;
  readonly openStreamTransport: (hostId: string) => DurableStreamTransport;
  readonly onSettled: () => void;
}

/**
 * Opens ONE host-owned deletion command for a user action - a single delete or
 * a bulk selection alike.
 *
 * This replaces the renderer-side queue of N sockets as the primary path. The
 * queue was never really scheduling: it was the only place that knew a bulk
 * delete was one user action, so nothing durable could ever describe it. Here
 * the host holds that identity, which is what lets the work outlive this
 * window and produce one completion notification instead of N or zero.
 *
 * The old queue survives underneath as the older-host fallback, entered only
 * on `onUnsupported` - i.e. only when the host proved it has no such method,
 * before it was asked to delete anything.
 */
function startWorktreeDeleteCommand(
  input: StartWorktreeDeleteCommandInput,
): void {
  const accepted = input.targets.filter(
    (item) =>
      !activeTargetKeys.has(
        worktreeDeleteRunKey(input.hostId, item.target.worktreePath),
      ),
  );
  if (accepted.length === 0) return;

  accepted.forEach((item) => {
    const key = worktreeDeleteRunKey(input.hostId, item.target.worktreePath);
    activeTargetKeys.add(key);
    input.begin({
      key,
      hostId: input.hostId,
      batchKey: input.batchKey,
      target: item.target,
      run: QUEUED_RUN,
      backgrounded: input.backgrounded,
    });
  });

  const forceTargets = accepted.filter((item) => item.stopOwners);
  const batchTargets = accepted.filter((item) => !item.stopOwners);
  // `stopOwners` is a deleteByPath@1.1 open-request field; the batch
  // command has no equivalent, so force-delete retries ride the per-target
  // stream.
  if (forceTargets.length > 0) {
    enqueueFallbackDeletes(input, forceTargets);
    drainDeleteQueue();
  }
  if (batchTargets.length === 0) {
    flushSettledCallbacksIfIdle();
    return;
  }

  const commandId = crypto.randomUUID();
  const keyFor = (worktreePath: string): string =>
    worktreeDeleteRunKey(input.hostId, worktreePath);
  const unsettled = new Set(
    batchTargets.map((item) => keyFor(item.target.worktreePath)),
  );
  activeCommandCount += 1;

  // A holder rather than a plain `let`: the settle happens inside callbacks the
  // stream client owns, and the post-build guard below has to read the value as
  // of THEN, not as of the last assignment the compiler can see.
  const command = { settled: false };
  /**
   * Ends the command and drives every target that never reported a terminal
   * frame into `unsettledReason`.
   *
   * That leftover set is NOT just an error path. The host does not replay
   * per-target frames to an observer that attached late, so a run that lost
   * its socket for a few seconds mid-batch legitimately reaches
   * `command.complete` with targets it never saw settle. Leaving them
   * non-terminal is what strands the progress strip, blocks the acknowledge
   * control, and stops settled successes from ever being pruned - so the
   * honest thing is to settle them as failures whose copy sends the user to
   * the refreshed list, which `onSettled` invalidates moments later.
   */
  const settleCommand = (unsettledReason: string): void => {
    if (command.settled) return;
    command.settled = true;
    activeCommandCount = Math.max(0, activeCommandCount - 1);
    closeCommandClient(commandId);
    unsettled.forEach((key) => {
      useWorktreeDeleteRunStore.getState().failRun(key, unsettledReason);
      releaseTargetKey(key);
    });
    unsettled.clear();
    pendingSettledCallbacks.add(input.onSettled);
    drainDeleteQueue();
    flushSettledCallbacksIfIdle();
  };
  /**
   * Ends the command WITHOUT settling anything: this host has no such method,
   * so the fallback queue is about to run the work per target instead.
   *
   * Only STILL-UNSETTLED targets are handed over. On the common path that is
   * all of them - the compatibility check rejects the very first openAck,
   * before anything can settle. It matters on the path where the host is
   * replaced mid-command by a build without the method: the observe session's
   * compat check reports unsupported, and re-queueing a target that already
   * reported a terminal frame would let a stale entry act on whatever record
   * holds that path LATER. If the user has since started a fresh delete for it,
   * that record is `queued`, and the stale entry would start a second,
   * uncoordinated per-target stream for someone else's run. Filtering here
   * keeps the invariant local instead of leaning on store state observed from
   * the drain.
   *
   * Reservations stay held across the hand-off rather than being released and
   * re-acquired, which would let a concurrent action slip a second delete for
   * the same path in between. The settled-callback flush deliberately happens
   * after the queue has the items, so an earlier run's pending invalidation
   * cannot fire in the gap where the system looks idle but is not.
   */
  const handOffToFallback = (): void => {
    if (command.settled) return;
    command.settled = true;
    activeCommandCount = Math.max(0, activeCommandCount - 1);
    closeCommandClient(commandId);
    const remaining = batchTargets.filter((item) =>
      unsettled.has(keyFor(item.target.worktreePath)),
    );
    if (remaining.length === 0) {
      // A replacement host can report unsupported after every target already
      // settled. There is then no fallback item that can add this callback,
      // but the completed command still changed the worktree list and needs
      // its usual invalidation once the system is idle.
      pendingSettledCallbacks.add(input.onSettled);
    } else {
      enqueueFallbackDeletes(input, remaining);
    }
    drainDeleteQueue();
    flushSettledCallbacksIfIdle();
  };

  try {
    const client = openOwnedDurableStreamClient(
      input.openStreamTransport,
      input.hostId,
      (wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>) =>
        new WorktreeDeleteBatchStreamClient({
          wsStreamClient,
          commandId,
          source: "settings",
          targets: batchTargets.map((item) => ({
            worktreePath: item.target.worktreePath,
            scripts: item.scripts,
          })),
          callbacks: {
            onTargetStarted: (worktreePath, hasTeardown) =>
              useWorktreeDeleteRunStore
                .getState()
                .updateRun(keyFor(worktreePath), (run) => ({
                  ...run,
                  status: "running",
                  hasTeardown,
                })),
            onTargetPhase: (worktreePath, phase) =>
              useWorktreeDeleteRunStore
                .getState()
                .updateRun(keyFor(worktreePath), (run) => ({
                  ...run,
                  activePhase: phase,
                })),
            onTargetOutput: (worktreePath, channel, chunk) =>
              useWorktreeDeleteRunStore
                .getState()
                .updateRun(keyFor(worktreePath), (run) => ({
                  ...run,
                  log: [
                    ...run.log,
                    { id: run.log.length, channel, text: chunk },
                  ],
                })),
            onTargetComplete: (worktreePath, deleted) => {
              const key = keyFor(worktreePath);
              useWorktreeDeleteRunStore.getState().completeRun(key, deleted);
              unsettled.delete(key);
              releaseTargetKey(key);
            },
            onTargetFailed: (worktreePath, reason, holders) => {
              const key = keyFor(worktreePath);
              if (takePendingBusyHolders(key, holders, undefined)) {
                unsettled.delete(key);
                releaseTargetKey(key);
                return;
              }
              useWorktreeDeleteRunStore.getState().failRun(key, reason);
              unsettled.delete(key);
              releaseTargetKey(key);
            },
            // Terminal for the command. Anything still open here is a target
            // whose own frames were missed while this client was away.
            onCommandComplete: () => settleCommand(REATTACHED_MESSAGE),
            onCommandFailed: (reason) => settleCommand(reason),
            onUnsupported: () => handOffToFallback(),
            onConnectionStatus: (status, reason) => {
              // Only a terminal stream close BEFORE the command's terminal
              // frame is an error. A recoverable drop surfaces as
              // "reconnecting", and the batch client answers it by re-opening
              // in observe mode - which can re-attach to a live command but
              // can never start this one again.
              if (status !== "closed" || reason === null) return;
              settleCommand(CONNECTION_LOST_MESSAGE);
            },
          },
        }),
    );
    commandRefs.set(commandId, client);
    // A callback can settle the command DURING the build - in production the
    // handshake is async, but nothing in the contract promises that, and a
    // settle that ran before this registry entry existed would leave the
    // transport open with nobody holding it.
    if (command.settled) closeCommandClient(commandId);
  } catch (error) {
    settleCommand(startStreamErrorMessage(error));
  }
}

/**
 * Older-host fallback: hand the command's targets to the per-target queue that
 * predates the batch method.
 *
 * Safe to run after `onUnsupported` precisely because that signal comes from
 * the openAck compatibility check - the host never received a subscribe frame,
 * so no deletion was attempted and re-issuing the work cannot double it.
 */
function enqueueFallbackDeletes(
  input: StartWorktreeDeleteCommandInput,
  accepted: ReadonlyArray<WorktreeDeleteRequestTarget>,
): void {
  accepted.forEach((item) => {
    queuedDeletes.push({
      key: worktreeDeleteRunKey(input.hostId, item.target.worktreePath),
      hostId: input.hostId,
      target: item.target,
      scripts: item.scripts,
      stopOwners: item.stopOwners,
      expectedHoldersRevision: item.expectedHoldersRevision,
      openStreamTransport: input.openStreamTransport,
      onSettled: input.onSettled,
    });
  });
  // Draining is the caller's, so the enqueue → drain → flush ordering stays
  // visible in one place.
}

/**
 * Called exactly once per run's non-terminal -> terminal transition (the
 * store actions observe the transition inside their state update). A batch
 * emits when the member that just settled was its last non-terminal one.
 */
function reportTerminalDeleteOutcome(
  key: string,
  runs: readonly WorktreeDeleteRunRecord[],
): void {
  const record = runs.find((candidate) => candidate.key === key);
  if (record === undefined || !worktreeRunIsTerminal(record.run)) return;
  if (record.batchKey === null) {
    Analytics.getInstance().track(
      AnalyticsEvent.WorktreeDeleted,
      record.run.deleted
        ? { outcome: "succeeded", blocker: null }
        : {
            outcome: "failed",
            blocker: analyticsBlockerFromError(record.run.error),
          },
    );
    return;
  }
  const batch = runs.filter(
    (candidate) => candidate.batchKey === record.batchKey,
  );
  if (batch.some((candidate) => !worktreeRunIsTerminal(candidate.run))) {
    return;
  }
  const succeededCount = batch.filter(
    (candidate) => candidate.run.deleted,
  ).length;
  Analytics.getInstance().track(AnalyticsEvent.WorktreesBulkDeleted, {
    requested_count: batch.length,
    succeeded_count: succeededCount,
    failed_count: batch.length - succeededCount,
  });
}

export function useWorktreeDeleteProgressSummary(): WorktreeDeleteProgressSummary {
  // Select the records before summarizing so the nested `scopeKeys` array is
  // stable while the underlying records are unchanged. Returning a freshly
  // allocated nested array from the store selector would defeat `useShallow`.
  const backgroundedRuns = useWorktreeDeleteRunStore(
    useShallow((state) => state.runs.filter((record) => record.backgrounded)),
  );
  return useMemo(() => summarizeProgress(backgroundedRuns), [backgroundedRuns]);
}

export function summarizeWorktreeDeleteRuns(
  runs: readonly WorktreeDeleteRunRecord[],
): WorktreeDeleteProgressSummary {
  return summarizeProgress(runs.filter((record) => record.backgrounded));
}

export function backgroundForegroundWorktreeDeleteForHost(
  hostId: string,
): void {
  useWorktreeDeleteRunStore.getState().backgroundForegroundForHost(hostId);
}

export function clearTerminalBackgroundedWorktreeDeletesForHost(
  hostId: string,
): void {
  useWorktreeDeleteRunStore.getState().clearTerminalBackgroundedForHost(hostId);
}

export function clearSettledWorktreeDeleteSuccessesForHostIfQuiescent(
  hostId: string,
): void {
  useWorktreeDeleteRunStore
    .getState()
    .clearSettledSuccessesForHostIfQuiescent(hostId);
}

/**
 * Detail line shared by the in-panel progress strip and the app-wide progress
 * toast so the two surfaces cannot drift (e.g. one pluralizing "failed"). Reads
 * "2/5 deleted" or "2/5 deleted, 1 failed".
 */
export function worktreeDeleteProgressDetail(
  summary: WorktreeDeleteProgressSummary,
): string {
  const base = `${summary.deleted}/${summary.total} deleted`;
  if (summary.failed === 0) return base;
  return `${base}, ${summary.failed} failed`;
}

function drainDeleteQueue(): void {
  while (
    activeDeleteStreamCount < MAX_PARALLEL_DELETE_STREAMS &&
    queuedDeletes.length > 0
  ) {
    const next = queuedDeletes.shift();
    if (next === undefined) return;
    const record = useWorktreeDeleteRunStore
      .getState()
      .runs.find((candidate) => candidate.key === next.key);
    if (record === undefined || record.run.status !== "queued") {
      // Dropped before it ever ran (its modal was dismissed, or the record was
      // pruned). Nothing started, so the reservation has to go with it -
      // otherwise that host+worktree pair stays un-deletable for the rest of
      // the session. Before commands existed the queue entry WAS the
      // reservation and shifting it released it; now the two are separate and
      // the release has to be explicit.
      releaseTargetKey(next.key);
      continue;
    }
    startQueuedDelete(next);
  }
}

function startQueuedDelete(item: QueuedWorktreeDelete): void {
  activeDeleteStreamCount += 1;
  useWorktreeDeleteRunStore
    .getState()
    .updateRun(item.key, (run) => ({ ...run, status: "running" }));

  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    activeDeleteStreamCount = Math.max(0, activeDeleteStreamCount - 1);
    releaseTargetKey(item.key);
    pendingSettledCallbacks.add(item.onSettled);
    drainDeleteQueue();
    flushSettledCallbacksIfIdle();
  };

  try {
    const client = openOwnedDurableStreamClient(
      item.openStreamTransport,
      item.hostId,
      (wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>) =>
        new WorktreeDeleteStreamClient({
          wsStreamClient,
          worktreePath: item.target.worktreePath,
          scripts: item.scripts,
          stopOwners: item.stopOwners,
          expectedHoldersRevision: item.stopOwners
            ? sanitizeHoldersRevision(item.expectedHoldersRevision)
            : undefined,
          callbacks: {
            onStarted: (hasTeardown) =>
              useWorktreeDeleteRunStore
                .getState()
                .updateRun(item.key, (run) => ({ ...run, hasTeardown })),
            onPhase: (phase) =>
              useWorktreeDeleteRunStore
                .getState()
                .updateRun(item.key, (run) => ({ ...run, activePhase: phase })),
            onOutput: (channel, chunk) =>
              useWorktreeDeleteRunStore
                .getState()
                .updateRun(item.key, (run) => ({
                  ...run,
                  log: [
                    ...run.log,
                    { id: run.log.length, channel, text: chunk },
                  ],
                })),
            onComplete: (deleted) => {
              useWorktreeDeleteRunStore
                .getState()
                .completeRun(item.key, deleted);
              closeDeleteClient(item.key);
              settle();
            },
            onFailed: (reason, holders, _code, holdersRevision) => {
              if (takePendingBusyHolders(item.key, holders, holdersRevision)) {
                closeDeleteClient(item.key);
                settle();
                return;
              }
              useWorktreeDeleteRunStore.getState().failRun(item.key, reason);
              closeDeleteClient(item.key);
              settle();
            },
            onConnectionStatus: (status, reason) => {
              // Only a terminal stream close BEFORE an app-level terminal frame
              // is an error. Recoverable reconnects surface as "reconnecting".
              if (status !== "closed" || reason === null) return;
              useWorktreeDeleteRunStore
                .getState()
                .failRun(item.key, CONNECTION_LOST_MESSAGE);
              closeDeleteClient(item.key);
              settle();
            },
          },
        }),
    );
    clientRefs.set(item.key, client);
  } catch (error) {
    useWorktreeDeleteRunStore
      .getState()
      .failRun(item.key, startStreamErrorMessage(error));
    settle();
  }
}

function startStreamErrorMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : "Unknown error.";
  return `Failed to start delete stream. ${detail}`;
}

function closeDeleteClient(key: string): void {
  const client = clientRefs.get(key);
  clientRefs.delete(key);
  client?.close();
}

function closeCommandClient(commandId: string): void {
  const client = commandRefs.get(commandId);
  commandRefs.delete(commandId);
  client?.close();
}

function releaseTargetKey(key: string): void {
  activeTargetKeys.delete(key);
}

/**
 * Drops a fallback-queue entry that has not started yet and frees its
 * reservation. No-op for a target inside a command (never queued) and for one
 * whose stream is already live - both settle through their own paths, and a
 * live delete must keep its reservation until it actually ends.
 */
function discardQueuedDelete(key: string): void {
  const index = queuedDeletes.findIndex((queued) => queued.key === key);
  if (index === -1) return;
  queuedDeletes.splice(index, 1);
  releaseTargetKey(key);
}

function summarizeProgress(
  runs: readonly WorktreeDeleteRunRecord[],
): WorktreeDeleteProgressSummary {
  const scopedRuns = activeProgressScope(runs);
  const scopeKeys = [
    ...new Set(scopedRuns.map((record) => progressGroupKey(record))),
  ];
  const total = scopedRuns.length;
  const deleted = scopedRuns.filter(
    (record) => record.run.status === "complete" && record.run.deleted,
  ).length;
  const failed = scopedRuns.filter(
    (record) =>
      (record.run.status === "failed" &&
        record.run.pendingBusyHolders === null) ||
      (record.run.status === "complete" && !record.run.deleted),
  ).length;
  return {
    scopeKeys,
    total,
    deleted,
    failed,
    active: Math.max(0, total - deleted - failed),
  };
}

function worktreeRunIsTerminal(run: WorktreeDeleteRunState): boolean {
  return run.status === "complete" || run.status === "failed";
}

function activeProgressScope(
  runs: readonly WorktreeDeleteRunRecord[],
): readonly WorktreeDeleteRunRecord[] {
  const groups = progressGroups(runs);
  const activeGroups = groups.filter((group) =>
    group.some((record) => !worktreeRunIsTerminal(record.run)),
  );
  if (activeGroups.length > 0) {
    return activeGroups.flatMap((group) => group);
  }
  if (groups.length === 0) return [];
  return groups[groups.length - 1];
}

function progressGroups(
  runs: readonly WorktreeDeleteRunRecord[],
): ReadonlyArray<ReadonlyArray<WorktreeDeleteRunRecord>> {
  const groups = new Map<string, WorktreeDeleteRunRecord[]>();
  runs.forEach((record) => {
    const key = progressGroupKey(record);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, [record]);
      return;
    }
    existing.push(record);
  });
  return [...groups.values()];
}

function progressGroupKey(record: WorktreeDeleteRunRecord): string {
  return record.batchKey ?? record.key;
}

function flushSettledCallbacksIfIdle(): void {
  if (
    activeDeleteStreamCount > 0 ||
    activeCommandCount > 0 ||
    queuedDeletes.length > 0
  ) {
    return;
  }
  const callbacks = [...pendingSettledCallbacks];
  pendingSettledCallbacks.clear();
  callbacks.forEach((callback) => callback());
}

function upsertRun(
  runs: readonly WorktreeDeleteRunRecord[],
  next: WorktreeDeleteRunRecord,
): readonly WorktreeDeleteRunRecord[] {
  const exists = runs.some((record) => record.key === next.key);
  if (!exists) return [...runs, next];
  return runs.map((record) => (record.key === next.key ? next : record));
}

function shouldShowProgress(record: WorktreeDeleteRunRecord): boolean {
  if (!record.backgrounded) return true;
  return (
    record.run.status === "failed" ||
    (record.run.status === "complete" && !record.run.deleted)
  );
}

function takePendingBusyHolders(
  key: string,
  holders: readonly WorktreeBusyHolder[] | undefined,
  holdersRevision: string | undefined,
): boolean {
  if (holders === undefined || holders.length === 0) return false;
  useWorktreeDeleteRunStore
    .getState()
    .setPendingBusyHolders(
      key,
      holders,
      sanitizeHoldersRevision(holdersRevision),
    );
  return true;
}

function worktreeDeleteRunKey(hostId: string, worktreePath: string): string {
  return `${hostId}\u0000${worktreePath}`;
}

let batchSequence = 0;

function nextWorktreeDeleteBatchKey(hostId: string): string {
  batchSequence += 1;
  return `${hostId}\u0000batch\u0000${batchSequence}`;
}
