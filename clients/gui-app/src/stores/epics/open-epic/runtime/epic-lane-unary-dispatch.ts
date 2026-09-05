/**
 * The two lane unaries, dispatched on this session's unary requester.
 *
 * The sibling of `epic-write-command-dispatch.ts`, and for the same reason: the
 * two ends of these calls are on different threads. The CALLERS are worker-side
 * (the workspace-context refresh policy and the runtime's `retryMigration`, both
 * part of the runtime), and the requester is main-side (it is the session's host
 * binding). What crosses is `main/lane-unary`, and this is what answers it.
 *
 * **The failure is reduced HERE, on main**, exactly as the write command's
 * classification is, and for the identical reason: an `Error` does not survive
 * structured clone. What the worker receives is a reason STRING rather than the
 * write path's classified union, because nothing on this side queues or retries
 * these - the refresh policy's next trigger is the retry, and a refused
 * migration retry is a log line. Inventing arms nothing branches on would be a
 * contract that looks richer than the behaviour behind it.
 *
 * `epicId` is supplied HERE and never carried on the request. The session owns
 * it, so a worker able to name an epic would be a worker able to name the wrong
 * one.
 */
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { LaneUnaryOutcome } from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
import type { LaneUnaryRequest } from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
import type { HostRpcRegistry } from "@/lib/host";

export interface EpicLaneUnaryDispatchOptions {
  readonly epicId: string;
  /**
   * Read LIVE, never captured - the same rule the write dispatcher states: the
   * session's requester can be replaced when the window re-points, and a
   * captured one would ask a host that no longer owns the stream.
   */
  readonly requester: () => HostRequester<HostRpcRegistry> | null;
}

export async function dispatchEpicLaneUnary(
  options: EpicLaneUnaryDispatchOptions,
  request: LaneUnaryRequest,
): Promise<LaneUnaryOutcome> {
  const requester = options.requester();
  if (requester === null) {
    return { ok: false, reason: "no host requester is attached" };
  }
  try {
    return await send(options.epicId, requester, request);
  } catch (cause: unknown) {
    // The MESSAGE, not the object. `E_HOST_UNSUPPORTED` from a host that
    // predates these methods reads as one here, which is the whole degrade
    // story: the caller logs it and the surface keeps whatever the legacy path
    // already gave it.
    return {
      ok: false,
      reason: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/**
 * Switched exhaustively with no default, exactly as the write dispatcher is: a
 * member added to `LaneUnaryRequest` without a dispatch here fails to compile
 * rather than silently resolving as if it had been sent.
 */
async function send(
  epicId: string,
  requester: HostRequester<HostRpcRegistry>,
  request: LaneUnaryRequest,
): Promise<LaneUnaryOutcome> {
  switch (request.kind) {
    case "workspace-context": {
      const answer = await requester.request("epic.getWorkspaceContext", {
        epicId,
      });
      return { ok: true, kind: "workspace-context", context: answer.context };
    }
    case "retry-migration": {
      await requester.request("epic.retryMigration", { epicId });
      return { ok: true, kind: "retry-migration" };
    }
  }
}
