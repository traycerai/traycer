import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type { HostResourceScope } from "@traycer/protocol/host/resource-scope";
import { useCanvasHostId } from "@/components/epic-canvas/hooks/use-canvas-host-id";
import { useEpicViewTabId } from "@/components/epic-canvas/view-tab-context";
import { useBrowserOpenHost } from "@/hooks/browser/use-browser-open-host";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useReactiveLocalHostId } from "@/hooks/host/use-reactive-local-host-id";
import type { BrowserSessionsState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import { useRunnerHost } from "@/providers/use-runner-host";
import {
  useBrowserSessions,
  useBrowserSessionsForHost,
} from "./use-browser-sessions";
import {
  BrowserOpenSessionsSnapshotContext,
  BrowserSessionsContext,
  BrowserSessionsCoordinatorKeyContext,
  BrowserSessionsSnapshotContext,
  type BrowserSessionsSnapshot,
} from "./browser-sessions-context";

/**
 * The canvas provider: the epic's inventory on the canvas host, plus the open
 * host's for links clicked under this view tab ({@link BrowserOpenSessionsProvider}).
 *
 * Every provider here - this one, {@link BrowserSessionsHostProvider} and
 * {@link BrowserSessionsHostBoundary} - acquires the REFCOUNTED coordinator by
 * key, so two providers for the same {scope, host, identity} in one window
 * share one stream rather than opening a second. Do not lift this state into
 * props to "avoid a second stream": there is no second stream, and hoisting it
 * would cost the surfaces their independent lifetimes.
 */
export function BrowserSessionsProvider(props: {
  readonly epicId: string;
  readonly children: ReactNode;
}) {
  const hostId = useCanvasHostId();
  const hostClient = useEpicSessionHostClient();
  // Fixed for the surface's life (`EpicSurface` provides it), so the branch
  // below never flips and never remounts the children.
  const viewTabId = useEpicViewTabId();
  return (
    <BrowserSessionsHostProvider
      hostId={hostId}
      hostClient={hostClient}
      scope={{ kind: "epic", epicId: props.epicId }}
    >
      {viewTabId === null ? (
        props.children
      ) : (
        <BrowserOpenSessionsProvider epicId={props.epicId} tabId={viewTabId}>
          {props.children}
        </BrowserOpenSessionsProvider>
      )}
    </BrowserSessionsHostProvider>
  );
}

/**
 * Holds the inventory of the host a browser the person opens from this view
 * tab goes to ({@link useBrowserOpenHost}), for the link opener to read at
 * click time.
 *
 * Here rather than in `useOpenBrowserUrl` because every link surface mounts
 * that hook, and subscribing each one to a stream would re-render all of them
 * on every frame. Acquired eagerly for the same reason `renderTile` acquires a
 * tile's: a stream opened at click time is not live for that click. When the
 * open host is the canvas host this shares the canvas's coordinator.
 *
 * Mounted once per view tab, and again by the hosted chat surface, which
 * renders in a React root of its own.
 */
export function BrowserOpenSessionsProvider(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly children: ReactNode;
}) {
  const hostId = useBrowserOpenHost(props.tabId, null);
  const sessions = useBrowserSessionsForHost({
    hostId,
    scope: { kind: "epic", epicId: props.epicId },
  });
  const snapshot = useSnapshotRef(hostId === null ? null : sessions);
  return (
    <BrowserOpenSessionsSnapshotContext.Provider value={snapshot}>
      {props.children}
    </BrowserOpenSessionsSnapshotContext.Provider>
  );
}

/**
 * The same inventory for an explicitly named host and scope - the Start Page
 * renders this one with `{ kind: "independent" }` and the client from its own
 * `TabHostProvider`. Refcounted by key like every provider here, so mounting it
 * beside a canvas provider for the same key costs no extra stream.
 */
export function BrowserSessionsHostProvider(props: {
  readonly hostId: string | null;
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  readonly scope: HostResourceScope;
  readonly children: ReactNode;
}) {
  const runnerHost = useRunnerHost();
  const browserView = runnerHost.browserView;
  const localHostId = useReactiveLocalHostId();
  const { state: sessions, coordinatorKey } = useBrowserSessions({
    hostId: props.hostId,
    hostClient: props.hostClient,
    scope: props.scope,
    browserView,
    localHostId,
  });
  return (
    <BrowserSessionsCoordinatorKeyContext.Provider value={coordinatorKey}>
      <BrowserSessionsContext.Provider value={sessions}>
        <BrowserSessionsSnapshotProvider value={sessions}>
          {props.children}
        </BrowserSessionsSnapshotProvider>
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
 *
 * The wrap it skips is a re-wrap for one host, not a second stream: providers
 * for one key in one window already share a coordinator. What skipping avoids
 * is a redundant provider layer between the canvas and the surface below it.
 */
export function BrowserSessionsHostBoundary(props: {
  readonly hostId: string | null;
  readonly scope: HostResourceScope;
  readonly children: ReactNode;
}): ReactNode {
  const canvasHostId = useCanvasHostId();
  const hostClient = useHostClientForHostId(props.hostId);
  // The scope has to match too, not just the host. What the canvas provides is
  // ONE stream - the canvas host's EPIC-scoped one - so falling through hands
  // the children whatever scope that ambient provider holds, not the scope
  // this boundary was asked for. An `independent` caller on the canvas host
  // would silently read the epic's inventory: scope confusion, which is the
  // one class this whole feature exists to remove.
  //
  // Inert today, and it must stay: all four call sites pass epic scope, so
  // this changes no behavior now. It is a guard against the Start Page's
  // `independent` boundary ever being mounted inside a canvas subtree, where
  // the host ids WOULD match and the bug would be invisible - a tile reading
  // a plausible, populated, wrong inventory rather than failing.
  if (props.hostId === canvasHostId && props.scope.kind === "epic") {
    return props.children;
  }
  return (
    <BrowserSessionsHostProvider
      hostId={props.hostId}
      hostClient={hostClient}
      scope={props.scope}
    >
      {props.children}
    </BrowserSessionsHostProvider>
  );
}
/**
 * Publishes the sessions state through a ref whose identity never changes, so
 * an event-time reader (`useOpenBrowserUrl`) sees the current value without
 * re-rendering on every stream frame. Exported for tests that mount
 * `BrowserSessionsContext.Provider` by hand.
 */
export function BrowserSessionsSnapshotProvider(props: {
  readonly value: BrowserSessionsState | null;
  readonly children: ReactNode;
}) {
  const snapshot = useSnapshotRef(props.value);
  return (
    <BrowserSessionsSnapshotContext.Provider value={snapshot}>
      {props.children}
    </BrowserSessionsSnapshotContext.Provider>
  );
}

function useSnapshotRef(
  value: BrowserSessionsState | null,
): BrowserSessionsSnapshot {
  const ref = useRef<BrowserSessionsState | null>(value);
  // Layout, not passive: the ref has to hold the committed value before the
  // frame the user can click in, and a passive effect may flush after paint.
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
