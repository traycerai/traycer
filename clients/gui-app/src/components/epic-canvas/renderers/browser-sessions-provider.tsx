import type { ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { useCanvasHostId } from "@/components/epic-canvas/hooks/use-canvas-host-id";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useReactiveLocalHostId } from "@/hooks/host/use-reactive-local-host-id";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useBrowserSessions } from "./use-browser-sessions";
import {
  BrowserSessionsContext,
  BrowserSessionsCoordinatorKeyContext,
} from "./browser-sessions-context";

export function BrowserSessionsProvider(props: {
  readonly epicId: string;
  readonly children: ReactNode;
}) {
  const hostId = useCanvasHostId();
  const hostClient = useEpicSessionHostClient();
  return (
    <BrowserSessionsHostProvider
      hostId={hostId}
      hostClient={hostClient}
      epicId={props.epicId}
    >
      {props.children}
    </BrowserSessionsHostProvider>
  );
}

export function BrowserSessionsHostProvider(props: {
  readonly hostId: string | null;
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly children: ReactNode;
}) {
  const runnerHost = useRunnerHost();
  const browserView = runnerHost.browserView;
  const localHostId = useReactiveLocalHostId();
  const { state: sessions, coordinatorKey } = useBrowserSessions({
    hostId: props.hostId,
    hostClient: props.hostClient,
    epicId: props.epicId,
    browserView,
    localHostId,
  });
  return (
    <BrowserSessionsCoordinatorKeyContext.Provider value={coordinatorKey}>
      <BrowserSessionsContext.Provider value={sessions}>
        {props.children}
      </BrowserSessionsContext.Provider>
    </BrowserSessionsCoordinatorKeyContext.Provider>
  );
}

/**
 * Puts a surface on `hostId`'s browser-sessions stream, wrapping only when it
 * needs to: the canvas already provides the canvas host's stream, so re-wrapping
 * for that host would open a second coordinator for the same one.
 *
 * The rule lives here rather than at each call site because three of them had
 * spelled it out separately, and the odd one out resolved its client from a
 * different hook. `useHostClientForHostId` is the one resolution for "which
 * client addresses this host id" - inside a tile it is exactly what
 * `useTabHostClient()` returns, since a tile's `TabHostProvider` is bound to
 * that same ref host.
 */
export function BrowserSessionsHostBoundary(props: {
  readonly hostId: string | null;
  readonly epicId: string;
  readonly children: ReactNode;
}): ReactNode {
  const canvasHostId = useCanvasHostId();
  const hostClient = useHostClientForHostId(props.hostId);
  if (props.hostId === canvasHostId) return props.children;
  return (
    <BrowserSessionsHostProvider
      hostId={props.hostId}
      hostClient={hostClient}
      epicId={props.epicId}
    >
      {props.children}
    </BrowserSessionsHostProvider>
  );
}
