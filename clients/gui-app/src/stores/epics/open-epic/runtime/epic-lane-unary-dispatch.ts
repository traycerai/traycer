/** The two lane unaries, dispatched on this session's unary requester. */
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { LaneUnaryOutcome } from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
import type { LaneUnaryRequest } from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
import type { HostRpcRegistry } from "@/lib/host";

export interface EpicLaneUnaryDispatchOptions {
  readonly epicId: string;
  /**
   * Read LIVE, never captured - the same rule the write dispatcher states: the session's requester
   * can be replaced when the window re-points, and a captured one would ask a host that no longer
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
    // The MESSAGE, not the object.
    return {
      ok: false,
      reason: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/**
 * Switched exhaustively with no default, exactly as the write dispatcher is: a member added to
 * `LaneUnaryRequest` without a dispatch here fails to compile rather than silently resolving as if
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
