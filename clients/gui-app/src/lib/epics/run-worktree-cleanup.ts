import { WorktreeDeleteStreamClient } from "@traycer-clients/shared/host-transport/worktree-delete-stream-client";
import { WorktreeDeleteBatchStreamClient } from "@traycer-clients/shared/host-transport/worktree-delete-batch-stream-client";
import type { WorktreeBusyHolder } from "@traycer/protocol/framework/worktree-busy-holders";
import type { WorktreeDeletionSource } from "@traycer/protocol/host/worktree-delete-batch-stream";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import { openOwnedDurableStreamClient } from "@/lib/host/owned-durable-stream-client";
import { appLogger } from "@/lib/logger";
import { sanitizeHoldersRevision } from "@/lib/worktree/teardown-holder-copy";

export interface WorktreeCleanupOutcome {
  readonly removed: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<string>;
  /**
   * Paths whose outcome this client never learned: the command reached the
   * host and then the observation dropped, so the removal may or may not have
   * happened.
   *
   * Kept apart from `failed` because the two demand different copy. "Couldn't
   * be removed" is a claim about the filesystem; this is a claim about what we
   * observed. The host owns the command either way and writes the durable
   * completion notification with the real counts.
   */
  readonly uncertain: ReadonlyArray<string>;
  /**
   * Force paths the host refused with `WORKTREE_HOLDERS_CHANGED` (fresh
   * inventory attached). The GUI must return to review — never toast this
   * as a generic failure or auto-retry.
   */
  readonly holdersChanged: ReadonlyArray<HoldersChangedPath>;
}

export interface HoldersChangedPath {
  readonly worktreePath: string;
  readonly holders: readonly WorktreeBusyHolder[];
  readonly holdersRevision: string | undefined;
}

const EMPTY_OUTCOME: WorktreeCleanupOutcome = {
  removed: [],
  failed: [],
  uncertain: [],
  holdersChanged: [],
};

// Fan-out cap for the FALLBACK path only (an older host with no batch command
// method). On a current host the cleanup is one command and the host schedules
// its targets, where the cap can actually bound the machine rather than one
// window's share of it.
const MAX_PARALLEL_CLEANUP_STREAMS = 2;

/**
 * Runs one user-approved, multi-path worktree cleanup, resolving once every
 * path has an observed outcome.
 *
 * On a current host this is ONE `worktree.deleteBatchByPath@1.0` command. That
 * is the point of the migration: the renderer used to be the only place that
 * knew the paths were one user action, so the host could not attribute a
 * durable completion notification to it and could not finish the work if this
 * window went away. Now it can do both. The caller supplies the durable source
 * (`task_cleanup` after deleting Tasks, `task_sweep` for the standalone Sweep
 * action) so telemetry and future presentation can distinguish the workflows
 * without adding a notification kind.
 *
 * On an older host - one whose handshake rejects the batch method outright,
 * before any subscribe frame asks it to delete anything - the previous bounded
 * per-path fan-out runs instead, unchanged.
 *
 * This is intentionally NOT wired into the Settings `useWorktreeDeleteRun`
 * store: that store owns the Settings progress modal / strip / backgrounding
 * UX. Task deletion and Sweep only need a tally for their summary toasts, so
 * they drive the stream clients directly with `scripts: null` (the host
 * resolves each worktree's own committed teardown scripts).
 *
 * The host-side busy-check stays intact on both paths: a path that became
 * in-use after the dialog opened is declined and lands in `failed`, never
 * silently force-removed.
 */
export interface WorktreeCleanupRequest {
  readonly hostId: string;
  readonly paths: ReadonlyArray<string>;
  readonly source: WorktreeDeletionSource;
  readonly stopOwnersPaths: ReadonlySet<string>;
  readonly expectedHoldersRevisionByPath: ReadonlyMap<string, string>;
}

export function runWorktreeCleanup(
  openStreamTransport: (hostId: string) => DurableStreamTransport,
  request: WorktreeCleanupRequest,
): Promise<WorktreeCleanupOutcome> {
  // No approved paths is not a command. Opening one would burn a `commandId`
  // and ask the host for a "you deleted nothing" notification row.
  if (request.paths.length === 0) return Promise.resolve(EMPTY_OUTCOME);
  const forcePaths = request.paths.filter((path) =>
    request.stopOwnersPaths.has(path),
  );
  const normalPaths = request.paths.filter(
    (path) => !request.stopOwnersPaths.has(path),
  );
  if (forcePaths.length === 0) {
    return runCleanupCommand(
      openStreamTransport,
      request.hostId,
      normalPaths,
      request.source,
    );
  }
  // Force paths first: a HOLDERS_CHANGED refusal must not start the batch
  // delete of the remaining selection.
  return runFallbackCleanup({
    openStreamTransport,
    hostId: request.hostId,
    paths: forcePaths,
    stopOwners: true,
    expectedHoldersRevisionByPath: request.expectedHoldersRevisionByPath,
  }).then((force) => {
    if (force.holdersChanged.length > 0 || normalPaths.length === 0) {
      return force;
    }
    return runCleanupCommand(
      openStreamTransport,
      request.hostId,
      normalPaths,
      request.source,
    ).then((normal) => ({
      removed: [...normal.removed, ...force.removed],
      failed: [...normal.failed, ...force.failed],
      uncertain: [...normal.uncertain, ...force.uncertain],
      holdersChanged: force.holdersChanged,
    }));
  });
}

/**
 * Opens one host-owned deletion command over every approved path and reports
 * what it observed.
 *
 * Observation and execution are separate here, which is what makes the drop
 * handling safe. Detaching never cancels: whatever this promise resolves with,
 * the host keeps deleting the remaining targets and still writes the completion
 * notification. So when the socket drops there is nothing to replay and nothing
 * to wait for - the honest move is to stop observing, report the unfinished
 * paths as uncertain, and let the durable row carry the real result.
 */
function runCleanupCommand(
  openStreamTransport: (hostId: string) => DurableStreamTransport,
  hostId: string,
  paths: ReadonlyArray<string>,
  source: WorktreeDeletionSource,
): Promise<WorktreeCleanupOutcome> {
  return new Promise<WorktreeCleanupOutcome>((resolve) => {
    const removed: string[] = [];
    const failed: string[] = [];
    const pending = new Set(paths);
    const holder = newCloseHolder();
    const state = { settled: false, reachedHost: false };

    const settle = (unsettledAre: "failed" | "uncertain"): void => {
      if (state.settled) return;
      state.settled = true;
      requestClose(holder);
      const unsettled = [...pending];
      pending.clear();
      resolve({
        removed,
        failed: unsettledAre === "failed" ? [...failed, ...unsettled] : failed,
        uncertain: unsettledAre === "uncertain" ? unsettled : [],
        holdersChanged: [],
      });
    };
    /**
     * This host has no such method, so the per-path fallback runs the work
     * instead.
     *
     * Safe precisely because `onUnsupported` comes from the openAck
     * compatibility check - the host never received a subscribe frame, so
     * nothing was attempted and re-issuing the work cannot double it. Only
     * still-pending paths are handed over, so a path that somehow already
     * settled is never deleted twice.
     */
    const handOffToFallback = (): void => {
      if (state.settled) return;
      state.settled = true;
      requestClose(holder);
      const remaining = [...pending];
      pending.clear();
      void runFallbackCleanup({
        openStreamTransport,
        hostId,
        paths: remaining,
        stopOwners: false,
        expectedHoldersRevisionByPath: new Map(),
      }).then(
        (fallback) =>
          resolve({
            removed: [...removed, ...fallback.removed],
            failed: [...failed, ...fallback.failed],
            uncertain: fallback.uncertain,
            holdersChanged: fallback.holdersChanged,
          }),
        (error: unknown) => {
          // `runFallbackCleanup` has no rejecting path today - every
          // `deleteOneWorktree` settles, and its open failure is handled inside
          // the executor. This branch keeps "the result promise always settles"
          // a property of THIS function rather than one inherited from a
          // callee's current shape: without it, a future throw anywhere in the
          // fan-out would strand the combined toast and the cache invalidation
          // silently, with the Tasks already deleted.
          //
          // Resolve BEFORE logging. This handler is the last thing standing
          // between an unexpected failure and feedback the user never gets, so
          // nothing in it - not even the log sink - may be able to throw first.
          //
          // The remaining paths are uncertain, not failed: the fan-out aborted
          // at an unknown point, so removals that already happened are real and
          // claiming "couldn't be removed" would be a false statement about the
          // filesystem. Nothing is retried - a destructive operation whose
          // outcome we do not know is exactly what must not be replayed.
          resolve({
            removed,
            failed,
            uncertain: remaining,
            holdersChanged: [],
          });
          appLogger.warn(
            "[worktree-cleanup] the per-target fallback failed unexpectedly; those worktrees may or may not have been removed",
            {
              hostId,
              remainingCount: remaining.length,
              error: error instanceof Error ? error.message : String(error),
            },
          );
        },
      );
    };
    const settleTarget = (worktreePath: string, deleted: boolean): void => {
      if (!pending.delete(worktreePath)) return;
      if (deleted) {
        removed.push(worktreePath);
      } else {
        failed.push(worktreePath);
      }
    };

    try {
      const owned = openOwnedDurableStreamClient(
        openStreamTransport,
        hostId,
        (wsStreamClient) =>
          new WorktreeDeleteBatchStreamClient({
            wsStreamClient,
            commandId: crypto.randomUUID(),
            source,
            targets: paths.map((worktreePath) => ({
              worktreePath,
              scripts: null,
            })),
            callbacks: {
              // No per-target progress surface in this flow - the Task-delete
              // summary toast is the only feedback, so phases and teardown
              // output have nowhere to go.
              onTargetStarted: () => {},
              onTargetPhase: () => {},
              onTargetOutput: () => {},
              onTargetComplete: (worktreePath, deleted) =>
                settleTarget(worktreePath, deleted),
              onTargetFailed: (worktreePath) =>
                settleTarget(worktreePath, false),
              // Terminal for the command. Anything still pending is a target
              // the host settled while this client was away - it does not
              // replay per-target frames to a late observer.
              onCommandComplete: () => settle("uncertain"),
              // No work ran or will run under this subscription: the host
              // cannot serve the command at all. Nothing was deleted.
              onCommandFailed: (reason) => {
                appLogger.warn("[worktree-cleanup] host rejected the command", {
                  hostId,
                  reason,
                });
                settle("failed");
              },
              onUnsupported: () => handOffToFallback(),
              onConnectionStatus: (status) => {
                if (status === "open") {
                  state.reachedHost = true;
                  return;
                }
                if (status !== "reconnecting" && status !== "closed") return;
                // A drop before the session ever opened means the subscribe
                // frame never reached the host: nothing was attempted, so the
                // paths failed rather than being unknown. After it opened the
                // command exists and keeps running without us.
                if (!state.reachedHost) {
                  settle("failed");
                  return;
                }
                if (pending.size > 0) {
                  appLogger.warn(
                    "[worktree-cleanup] lost the command stream before it finished; the host is still running it",
                    { hostId, pendingCount: pending.size, status },
                  );
                }
                settle("uncertain");
              },
            },
          }),
      );
      adoptClose(holder, owned.close);
    } catch (error) {
      appLogger.warn("[worktree-cleanup] failed to open the command stream", {
        hostId,
        error: error instanceof Error ? error.message : String(error),
      });
      settle("failed");
    }
  });
}

/**
 * Per-path `worktree.deleteByPath` fan-out, bounded to
 * {@link MAX_PARALLEL_CLEANUP_STREAMS} in flight. Used for older hosts that
 * cannot serve the batch command, and for current-host force paths that need
 * `stopOwners`.
 *
 * A drop after the stream opened is `uncertain` — the host may still finish
 * the delete — matching the batch command. A drop before open, an open
 * failure, or an app terminal `failed`/`deleted: false` is `failed`.
 *
 * Expected never to reject - each path settles through
 * {@link deleteOneWorktree}. The caller still handles rejection, because the
 * "always settles" invariant belongs to the caller's promise, not to this
 * function's present implementation.
 */
async function runFallbackCleanup(input: {
  readonly openStreamTransport: (hostId: string) => DurableStreamTransport;
  readonly hostId: string;
  readonly paths: ReadonlyArray<string>;
  readonly stopOwners: boolean;
  readonly expectedHoldersRevisionByPath: ReadonlyMap<string, string>;
}): Promise<WorktreeCleanupOutcome> {
  const removed: string[] = [];
  const failed: string[] = [];
  const uncertain: string[] = [];
  const holdersChanged: HoldersChangedPath[] = [];
  const queue = [...input.paths];

  const worker = async (): Promise<void> => {
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
      const outcome = await deleteOneWorktree({
        openStreamTransport: input.openStreamTransport,
        hostId: input.hostId,
        worktreePath: path,
        stopOwners: input.stopOwners,
        expectedHoldersRevision: input.expectedHoldersRevisionByPath.get(path),
      });
      if (outcome.kind === "removed") {
        removed.push(path);
      } else if (outcome.kind === "failed") {
        failed.push(path);
      } else if (outcome.kind === "holders-changed") {
        holdersChanged.push({
          worktreePath: path,
          holders: outcome.holders,
          holdersRevision: outcome.holdersRevision,
        });
      } else {
        uncertain.push(path);
      }
    }
  };

  const workerCount = Math.min(
    MAX_PARALLEL_CLEANUP_STREAMS,
    input.paths.length,
  );
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return { removed, failed, uncertain, holdersChanged };
}

type DeleteOneOutcome =
  | { readonly kind: "removed" }
  | { readonly kind: "failed" }
  | { readonly kind: "uncertain" }
  | {
      readonly kind: "holders-changed";
      readonly holders: readonly WorktreeBusyHolder[];
      readonly holdersRevision: string | undefined;
    };

/**
 * Every per-path delete settles: on an app terminal frame (`complete`/`failed`),
 * on the FIRST connection drop after start (`reconnecting`/`closed`), or on a
 * synchronous open failure. The session is torn down immediately so the
 * transport's reconnect loop can't re-issue the `subscribe` frame (which would
 * re-run the host delete pipeline) - so exactly one subscribe is ever sent per
 * path, and the overall promise always resolves.
 *
 * A drop after `open` is `uncertain` (the host may still finish). A drop
 * before the session opened, an open failure, or an app terminal failure is
 * `failed`.
 */
function deleteOneWorktree(input: {
  readonly openStreamTransport: (hostId: string) => DurableStreamTransport;
  readonly hostId: string;
  readonly worktreePath: string;
  readonly stopOwners: boolean;
  readonly expectedHoldersRevision: string | undefined;
}): Promise<DeleteOneOutcome> {
  return new Promise<DeleteOneOutcome>((resolve) => {
    const holder = newCloseHolder();
    const state = { settled: false, reachedHost: false };
    const finish = (outcome: DeleteOneOutcome): void => {
      if (state.settled) return;
      state.settled = true;
      requestClose(holder);
      resolve(outcome);
    };

    try {
      const owned = openOwnedDurableStreamClient(
        input.openStreamTransport,
        input.hostId,
        (wsStreamClient) =>
          new WorktreeDeleteStreamClient({
            wsStreamClient,
            worktreePath: input.worktreePath,
            scripts: null,
            stopOwners: input.stopOwners,
            expectedHoldersRevision: input.stopOwners
              ? sanitizeHoldersRevision(input.expectedHoldersRevision)
              : undefined,
            callbacks: {
              onStarted: () => {},
              onPhase: () => {},
              onOutput: () => {},
              onComplete: (deleted) =>
                finish({ kind: deleted ? "removed" : "failed" }),
              onFailed: (_reason, holders, code, holdersRevision) => {
                if (code === "WORKTREE_HOLDERS_CHANGED") {
                  finish({
                    kind: "holders-changed",
                    holders: holders ?? [],
                    holdersRevision,
                  });
                  return;
                }
                finish({ kind: "failed" });
              },
              onConnectionStatus: (status) => {
                // Fail fast on the FIRST drop after start. The one-shot delete
                // stream must not silently re-run, but WsStreamClient's own
                // reconnect loop keeps rescheduling `reconnecting` (reason:
                // null) drops - which would both re-issue the subscribe (re-run
                // the host pipeline) AND leave this promise hanging (the summary
                // toast + cache invalidation would never fire).
                // `connecting`/`open` are the normal startup; a `closed` fired
                // by our own teardown after a terminal frame is absorbed by
                // the `settled` guard.
                if (status === "open") {
                  state.reachedHost = true;
                  return;
                }
                if (status !== "reconnecting" && status !== "closed") return;
                if (state.reachedHost) {
                  if (!state.settled) {
                    appLogger.warn(
                      "[worktree-cleanup] delete stream dropped before completing; the worktree may or may not have been removed",
                      { worktreePath: input.worktreePath, status },
                    );
                  }
                  finish({ kind: "uncertain" });
                  return;
                }
                finish({ kind: "failed" });
              },
            },
          }),
      );
      adoptClose(holder, owned.close);
    } catch (error) {
      appLogger.warn("[worktree-cleanup] failed to open delete stream", {
        worktreePath: input.worktreePath,
        error: error instanceof Error ? error.message : String(error),
      });
      finish({ kind: "failed" });
    }
  });
}

/**
 * Holds a stream client's `close` for callbacks that may, in the pathological
 * case, fire synchronously inside the constructor - before
 * `openOwnedDurableStreamClient` has returned the handle that closes it. A
 * close requested in that window is applied the moment the handle exists, so a
 * session can never be left open with nobody holding it.
 */
interface CloseHolder {
  close: (() => void) | null;
  closeRequested: boolean;
}

function newCloseHolder(): CloseHolder {
  return { close: null, closeRequested: false };
}

function requestClose(holder: CloseHolder): void {
  if (holder.close === null) {
    holder.closeRequested = true;
    return;
  }
  holder.close();
}

function adoptClose(holder: CloseHolder, close: () => void): void {
  holder.close = close;
  if (holder.closeRequested) close();
}
