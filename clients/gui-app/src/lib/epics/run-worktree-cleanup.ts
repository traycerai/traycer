import { WorktreeDeleteStreamClient } from "@traycer-clients/shared/host-transport/worktree-delete-stream-client";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import { openOwnedDurableStreamClient } from "@/lib/host/owned-durable-stream-client";
import { appLogger } from "@/lib/logger";

export interface WorktreeCleanupOutcome {
  readonly removed: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<string>;
}

// Each `worktree.deleteByPath` stream may run teardown scripts plus a git
// removal; cap fanout so a large multi-Task deletion cannot saturate the host
// or the websocket transport. Mirrors the Settings delete runner's cap.
const MAX_PARALLEL_CLEANUP_STREAMS = 2;

/**
 * Runs the post-Task-deletion worktree cleanup: one `worktree.deleteByPath@1.0`
 * stream per approved path, bounded to {@link MAX_PARALLEL_CLEANUP_STREAMS} in
 * flight, resolving once every path has reached a terminal outcome.
 *
 * This is intentionally NOT wired into the Settings `useWorktreeDeleteRun`
 * store: that store owns the Settings progress modal / strip / backgrounding
 * UX. The Task-delete flow only needs a removed/failed tally for its summary
 * toast, so it drives the lower-level stream client directly with `scripts:
 * null` (the host resolves each worktree's own committed teardown scripts).
 *
 * The host-side busy-check stays intact: a path that became in-use after the
 * dialog opened is declined and lands in `failed`, never silently force-removed.
 *
 * Every per-path delete settles: on an app terminal frame (`complete`/`failed`),
 * on the FIRST connection drop after start (`reconnecting`/`closed`), or on a
 * synchronous open failure. A drop is counted as `failed` and the session is
 * torn down immediately so the transport's reconnect loop can't re-issue the
 * `subscribe` frame (which would re-run the host delete pipeline) - so exactly
 * one subscribe is ever sent per path, and the overall promise always resolves.
 */
export async function runWorktreeCleanup(
  openStreamTransport: (hostId: string) => DurableStreamTransport,
  hostId: string,
  paths: ReadonlyArray<string>,
): Promise<WorktreeCleanupOutcome> {
  const removed: string[] = [];
  const failed: string[] = [];
  const queue = [...paths];

  const worker = async (): Promise<void> => {
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
      const deleted = await deleteOneWorktree(
        openStreamTransport,
        hostId,
        path,
      );
      if (deleted) {
        removed.push(path);
      } else {
        failed.push(path);
      }
    }
  };

  const workerCount = Math.min(MAX_PARALLEL_CLEANUP_STREAMS, paths.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return { removed, failed };
}

function deleteOneWorktree(
  openStreamTransport: (hostId: string) => DurableStreamTransport,
  hostId: string,
  worktreePath: string,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // Held on an object rather than plain locals so the terminal callbacks (which
    // may, in the pathological case, fire synchronously inside the constructor
    // before `close` is assigned) can hand a close request back to the
    // constructor's return path.
    const state: {
      settled: boolean;
      close: (() => void) | null;
      closeRequested: boolean;
    } = { settled: false, close: null, closeRequested: false };
    const finish = (deleted: boolean): void => {
      if (state.settled) return;
      state.settled = true;
      if (state.close !== null) {
        state.close();
      } else {
        state.closeRequested = true;
      }
      resolve(deleted);
    };

    try {
      const owned = openOwnedDurableStreamClient(
        openStreamTransport,
        hostId,
        (wsStreamClient) =>
          new WorktreeDeleteStreamClient({
            wsStreamClient,
            worktreePath,
            scripts: null,
            callbacks: {
              onStarted: () => {},
              onPhase: () => {},
              onOutput: () => {},
              onComplete: (deleted) => finish(deleted),
              onFailed: () => finish(false),
              onConnectionStatus: (status) => {
                // Fail fast on the FIRST drop after start. The one-shot delete
                // stream must not silently re-run, but WsStreamClient's own
                // reconnect loop keeps rescheduling `reconnecting` (reason:
                // null) drops - which would both re-issue the subscribe (re-run
                // the host pipeline) AND leave this promise hanging (the summary
                // toast + cache invalidation would never fire). Any
                // `reconnecting`/`closed` before a terminal frame means the
                // delete never confirmed: count it failed and let `finish`'s
                // `close()` tear the session down. `connecting`/`open` are the
                // normal startup and are ignored; a `closed` fired by our own
                // teardown after a terminal frame is absorbed by the `settled`
                // guard.
                if (status !== "reconnecting" && status !== "closed") return;
                if (!state.settled) {
                  appLogger.warn(
                    "[worktree-cleanup] delete stream dropped before completing; the worktree may or may not have been removed",
                    { worktreePath, status },
                  );
                }
                finish(false);
              },
            },
          }),
      );
      state.close = owned.close;
      if (state.closeRequested) owned.close();
    } catch (error) {
      appLogger.warn("[worktree-cleanup] failed to open delete stream", {
        worktreePath,
        error: error instanceof Error ? error.message : String(error),
      });
      finish(false);
    }
  });
}
