import { useCallback, useEffect, useRef } from "react";
import { useHostClient, useHostDirectory } from "@/lib/host";
import { openOneShotStreamTransport } from "@/lib/host/one-shot-stream-transport";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import { dialableHostEndpoint } from "@/lib/host/transport-key";

/**
 * Opener for the Settings ▸ Worktrees `worktree.deleteByPath` stream transport.
 *
 * The delete is a ONE-SHOT, side-effecting host operation (teardown script + git
 * removal). It must survive the Worktrees tile unmounting so a backgrounded
 * delete keeps its socket (ownership lives in `useWorktreeDeleteRun`), but it
 * must NOT silently re-run if the machine sleeps/wakes or the host respawns -
 * every reconnect re-sends the stream's `subscribe` frame, which re-runs the
 * pipeline host-side. So unlike the chat/terminal durable factory this wires no
 * wake/endpoint re-dial and passes `auth: null` (see `openOneShotStreamTransport`):
 * a dropped socket surfaces the failure instead of re-issuing the delete.
 *
 * `endpoint`/`bearer` are read live per dial through a ref refreshed each render
 * so a credential rotation is reflected, mirroring the durable factory's
 * stale-capture-proofing.
 */
export function useWorktreeDeleteStreamTransportFactory(): (
  hostId: string,
) => DurableStreamTransport {
  const directory = useHostDirectory();
  const globalClient = useHostClient();
  const liveRef = useRef({ directory, globalClient });
  useEffect(() => {
    liveRef.current = { directory, globalClient };
  });
  return useCallback(
    (hostId: string) =>
      openOneShotStreamTransport({
        endpoint: () =>
          dialableHostEndpoint(liveRef.current.directory.findById(hostId)),
        bearer: () =>
          liveRef.current.globalClient.getRequestContext()?.credentials ?? null,
      }),
    [],
  );
}
