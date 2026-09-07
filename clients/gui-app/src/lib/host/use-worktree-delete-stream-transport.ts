import { useCallback, useEffect, useRef } from "react";
import { useHostClient, useHostDirectory } from "@/lib/host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { openOneShotStreamTransport } from "@/lib/host/one-shot-stream-transport";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import { dialableHostEndpoint } from "@/lib/host/transport-key";

/** Opener for the Settings ▸ Worktrees `worktree.deleteByPath` stream transport. */
export function useWorktreeDeleteStreamTransportFactory(): (
  hostId: string,
) => DurableStreamTransport {
  const directory = useHostDirectory();
  const globalClient = useHostClient();
  const authnBaseUrl = useRunnerHost().authnBaseUrl;
  const liveRef = useRef({ directory, globalClient, authnBaseUrl });
  useEffect(() => {
    liveRef.current = { directory, globalClient, authnBaseUrl };
  });
  return useCallback((hostId: string) => {
    const target = liveRef.current.directory.findById(hostId);
    if (target === null) {
      // The worktrees panel only starts a delete for a host row it is already rendering from this same directory, so an absent entry here means the panel and the directory disagreed - a caller bug, not a condition to degrade from gracefully.
      throw new Error(`No directory entry for host ${hostId}`);
    }
    const userId = liveRef.current.globalClient.getRequestContextUserId();
    if (userId === null) {
      // The worktrees panel only renders (and can start a delete) once the global client has a signed-in user, so a null here is likewise a caller-bug condition, not one to degrade from gracefully.
      throw new Error(`No signed-in user for host ${hostId}`);
    }
    return openOneShotStreamTransport({
      target,
      userId,
      endpoint: () =>
        dialableHostEndpoint(liveRef.current.directory.findById(hostId)),
      bearer: () =>
        liveRef.current.globalClient.getRequestContext()?.credentials ?? null,
      authnBaseUrl: liveRef.current.authnBaseUrl,
    });
  }, []);
}
