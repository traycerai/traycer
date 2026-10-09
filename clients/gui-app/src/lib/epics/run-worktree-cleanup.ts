import { WorktreeDeleteStreamClient } from "@traycer-clients/shared/host-transport/worktree-delete-stream-client";
import { WorktreeDeleteBatchStreamClient } from "@traycer-clients/shared/host-transport/worktree-delete-batch-stream-client";
import type { WorktreeDeletionSource } from "@traycer/protocol/host/worktree-delete-batch-stream";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import { openOwnedDurableStreamClient } from "@/lib/host/owned-durable-stream-client";
import { appLogger } from "@/lib/logger";

/**
 * One target that did not get removed, with the display-safe reason the host
 * gave for it.
 *
 * The reason is LIVE-ONLY copy: it names the absolute worktree path and comes
 * straight off the stream frame, which is fine in a toast shown at the moment
 * of the action and wrong anywhere durable. Never persist it, and never put it
 * in a report-issue context (those are public and fixed product copy).
 */
export interface WorktreeCleanupFailure {
  readonly worktreePath: string;
  readonly reason: string;
}

/**
 * A target the host settled as `deleted: false` rather than throwing. The
 * stream carries no reason string on that path, so the tally supplies fixed
 * copy - the durable row's failure categories are the real answer there.
 */
const DECLINED_REASON = "The host declined the deletion.";
const NEVER_REACHED_HOST_REASON =
  "Couldn't reach the host to start the deletion.";
const STREAM_OPEN_FAILED_REASON = "Couldn't open the deletion stream.";

export interface WorktreeCleanupOutcome {
  readonly removed: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<WorktreeCleanupFailure>;
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
}

const EMPTY_OUTCOME: WorktreeCleanupOutcome = {
  removed: [],
  failed: [],
  uncertain: [],
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
  readonly epicId?: string;
  readonly stopOwnersPaths: ReadonlySet<string>;
}

export async function runWorktreeCleanup(
  openStreamTransport: (hostId: string) => DurableStreamTransport,
  request: WorktreeCleanupRequest,
): Promise<WorktreeCleanupOutcome> {
  // No approved paths is not a command. Opening one would burn a `commandId`
  // and ask the host for a "you deleted nothing" notification row.
  if (request.paths.length === 0) return EMPTY_OUTCOME;
  const forcePaths = request.paths.filter((path) =>
    request.stopOwnersPaths.has(path),
  );
  const normalPaths = request.paths.filter(
    (path) => !request.stopOwnersPaths.has(path),
  );
  if (forcePaths.length === 0) {
    return runNormalCleanup(openStreamTransport, request, normalPaths);
  }

  // A force target's consent field is safety-significant. Pin the command to
  // @1.1 so a 1.0 host rejects at openAck instead of schema-stripping it.
  const attempt = await runCleanupCommand(openStreamTransport, {
    hostId: request.hostId,
    targets: request.paths.map((worktreePath) => ({
      worktreePath,
      stopOwners: request.stopOwnersPaths.has(worktreePath),
    })),
    source: request.source,
    epicId: request.epicId,
  });
  if (attempt.kind === "outcome") return attempt.outcome;

  // The pinned open was rejected before subscribe. Preserve the old-host
  // behavior: normal targets use a fresh @1.0 batch attempt, while consented
  // targets use the released per-path stream.
  const [normal, force] = await Promise.all([
    runNormalCleanup(openStreamTransport, request, normalPaths),
    runFallbackCleanupSafely({
      openStreamTransport,
      hostId: request.hostId,
      paths: forcePaths,
      stopOwners: true,
    }),
  ]);
  return combineCleanupOutcomes(normal, force);
}

async function runNormalCleanup(
  openStreamTransport: (hostId: string) => DurableStreamTransport,
  request: WorktreeCleanupRequest,
  paths: ReadonlyArray<string>,
): Promise<WorktreeCleanupOutcome> {
  if (paths.length === 0) return EMPTY_OUTCOME;
  const attempt = await runCleanupCommand(openStreamTransport, {
    hostId: request.hostId,
    targets: paths.map((worktreePath) => ({
      worktreePath,
      stopOwners: false,
    })),
    source: request.source,
    epicId: request.epicId,
  });
  if (attempt.kind === "outcome") return attempt.outcome;
  return runFallbackCleanupSafely({
    openStreamTransport,
    hostId: request.hostId,
    paths,
    stopOwners: false,
  });
}

function combineCleanupOutcomes(
  first: WorktreeCleanupOutcome,
  second: WorktreeCleanupOutcome,
): WorktreeCleanupOutcome {
  return {
    removed: [...first.removed, ...second.removed],
    failed: [...first.failed, ...second.failed],
    uncertain: [...first.uncertain, ...second.uncertain],
  };
}

type CleanupCommandAttempt =
  | { readonly kind: "outcome"; readonly outcome: WorktreeCleanupOutcome }
  | { readonly kind: "unsupported" };

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
  input: {
    readonly hostId: string;
    readonly targets: ReadonlyArray<{
      readonly worktreePath: string;
      readonly stopOwners: boolean;
    }>;
    readonly source: WorktreeDeletionSource;
    readonly epicId: string | undefined;
  },
): Promise<CleanupCommandAttempt> {
  const { hostId, targets, source, epicId } = input;
  const paths = targets.map((target) => target.worktreePath);
  return new Promise<CleanupCommandAttempt>((resolve) => {
    const removed: string[] = [];
    const failed: WorktreeCleanupFailure[] = [];
    const pending = new Set(paths);
    const holder = newCloseHolder();
    const state = { settled: false, reachedHost: false };

    /**
     * What the targets still open at settle time become. `failed` carries the
     * reason that applies to all of them - a host rejection's own words, or
     * fixed copy for a transport failure that produced none.
     */
    const settle = (
      unsettled:
        | { readonly kind: "failed"; readonly reason: string }
        | { readonly kind: "uncertain" },
    ): void => {
      if (state.settled) return;
      state.settled = true;
      requestClose(holder);
      const stillPending = [...pending];
      pending.clear();
      resolve({
        kind: "outcome",
        outcome: {
          removed,
          failed:
            unsettled.kind === "failed"
              ? [
                  ...failed,
                  ...stillPending.map((worktreePath) => ({
                    worktreePath,
                    reason: unsettled.reason,
                  })),
                ]
              : failed,
          uncertain: unsettled.kind === "uncertain" ? stillPending : [],
        },
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
    const reportUnsupported = (): void => {
      if (state.settled) return;
      // Only an initial compatibility rejection has the no-side-effect
      // guarantee. A replacement host rejecting an observe arrives after the
      // command may have started, so its remaining targets stay uncertain.
      if (state.reachedHost) {
        settle({ kind: "uncertain" });
        return;
      }
      state.settled = true;
      requestClose(holder);
      pending.clear();
      resolve({ kind: "unsupported" });
    };
    const settleTargetRemoved = (worktreePath: string): void => {
      if (!pending.delete(worktreePath)) return;
      removed.push(worktreePath);
    };
    const settleTargetFailed = (worktreePath: string, reason: string): void => {
      if (!pending.delete(worktreePath)) return;
      failed.push({ worktreePath, reason });
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
            epicId,
            targets: targets.map((target) => ({
              worktreePath: target.worktreePath,
              scripts: null,
              stopOwners: target.stopOwners,
            })),
            callbacks: {
              // No per-target progress surface in this flow - the Task-delete
              // summary toast is the only feedback, so phases and teardown
              // output have nowhere to go.
              onTargetStarted: () => {},
              onTargetPhase: () => {},
              onTargetOutput: () => {},
              onTargetComplete: (worktreePath, deleted) =>
                deleted
                  ? settleTargetRemoved(worktreePath)
                  : settleTargetFailed(worktreePath, DECLINED_REASON),
              onTargetFailed: (worktreePath, reason) =>
                settleTargetFailed(worktreePath, reason),
              // Terminal for the command. Anything still pending is a target
              // the host settled while this client was away - it does not
              // replay per-target frames to a late observer.
              onCommandComplete: () => settle({ kind: "uncertain" }),
              // No work ran or will run under this subscription: the host
              // cannot serve the command at all. Nothing was deleted.
              onCommandFailed: (reason) => {
                appLogger.warn("[worktree-cleanup] host rejected the command", {
                  hostId,
                  reason,
                });
                settle({ kind: "failed", reason });
              },
              onUnsupported: () => reportUnsupported(),
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
                  settle({
                    kind: "failed",
                    reason: NEVER_REACHED_HOST_REASON,
                  });
                  return;
                }
                if (pending.size > 0) {
                  appLogger.warn(
                    "[worktree-cleanup] lost the command stream before it finished; the host is still running it",
                    { hostId, pendingCount: pending.size, status },
                  );
                }
                settle({ kind: "uncertain" });
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
      settle({ kind: "failed", reason: STREAM_OPEN_FAILED_REASON });
    }
  });
}

/**
 * Per-path `worktree.deleteByPath` fan-out, bounded to
 * {@link MAX_PARALLEL_CLEANUP_STREAMS} in flight. Used for older hosts that
 * cannot serve the batch command. Force paths use it only after an @1.1-pinned
 * batch open was rejected before subscribe.
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
}): Promise<WorktreeCleanupOutcome> {
  const removed: string[] = [];
  const failed: WorktreeCleanupFailure[] = [];
  const uncertain: string[] = [];
  const queue = [...input.paths];

  const worker = async (): Promise<void> => {
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
      const outcome = await deleteOneWorktree({
        openStreamTransport: input.openStreamTransport,
        hostId: input.hostId,
        worktreePath: path,
        stopOwners: input.stopOwners,
      });
      if (outcome.kind === "removed") {
        removed.push(path);
      } else if (outcome.kind === "failed") {
        failed.push({ worktreePath: path, reason: outcome.reason });
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

  return { removed, failed, uncertain };
}

async function runFallbackCleanupSafely(input: {
  readonly openStreamTransport: (hostId: string) => DurableStreamTransport;
  readonly hostId: string;
  readonly paths: ReadonlyArray<string>;
  readonly stopOwners: boolean;
}): Promise<WorktreeCleanupOutcome> {
  try {
    return await runFallbackCleanup(input);
  } catch {
    // A fallback worker can only reject through an exceptional client-side
    // failure after the fan-out started. Its filesystem outcomes are unknown;
    // never reject the parent Task/Sweep flow or replay destructive work.
    return { removed: [], failed: [], uncertain: [...input.paths] };
  }
}

type DeleteOneOutcome =
  | { readonly kind: "removed" }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "uncertain" };

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
            callbacks: {
              onStarted: () => {},
              onPhase: () => {},
              onOutput: () => {},
              onComplete: (deleted) =>
                finish(
                  deleted
                    ? { kind: "removed" }
                    : { kind: "failed", reason: DECLINED_REASON },
                ),
              onFailed: (reason) => finish({ kind: "failed", reason }),
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
                finish({ kind: "failed", reason: NEVER_REACHED_HOST_REASON });
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
      finish({ kind: "failed", reason: STREAM_OPEN_FAILED_REASON });
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

/**
 * Beyond this many failures the toast shows the count line only. Naming three
 * paths and their reasons still reads as a sentence; naming eight turns the
 * toast into a log, and the Settings run log + the durable row are where a
 * list that long belongs.
 */
const MAX_LISTED_FAILURE_REASONS = 3;

/**
 * Toast DETAIL for a settled cleanup: one `<path>: <reason>` entry per failed
 * target, or `null` when there is nothing to add beyond the count line.
 *
 * On-screen only. This string names absolute paths, so it goes in the toast's
 * `description` and never in a `ReportIssueContext` (public, fixed product
 * copy) or anywhere durable.
 */
export function worktreeCleanupFailureDetail(
  failed: ReadonlyArray<WorktreeCleanupFailure>,
): string | null {
  if (failed.length === 0) return null;
  if (failed.length > MAX_LISTED_FAILURE_REASONS) return null;
  return failed
    .map((failure) => `${failure.worktreePath}: ${failure.reason}`)
    .join(" · ");
}
