import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import type { BrowserSessionInfo } from "@traycer/protocol/host/browser/contracts";
import type { HostUnavailability } from "@traycer-clients/shared/host-client/remote-fetcher";
import { ElectronTabSurface } from "./agent-browser-tile";
import {
  BrowserPeekTile,
  type BrowserPeekCompleteMeaning,
  type BrowserPeekNode,
} from "./browser-peek-tile";
import { useBrowserSessionsContext } from "./browser-sessions-context";
import { useCloseCanvasTileWithNestedFocus } from "./use-close-canvas-tile-with-nested-focus";
import { Button } from "@/components/ui/button";
import {
  useElectronTabBindingOnHost,
  type ElectronTabBinding,
} from "@/lib/browser-view/sessions/electron-tabs";
import {
  browserPeekFrameKey,
  clearLastBrowserPeekFrame,
  useLastBrowserPeekFrame,
} from "@/lib/browser-view/sessions/peek-frame-cache";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import type { BrowserSessionTileRef } from "@/stores/epics/canvas/types";

interface BrowserSessionTileProps {
  readonly node: BrowserSessionTileRef;
  readonly viewTabId: string;
  readonly paneId: string;
  readonly epicId: string;
}

interface BrowserSessionTileBodyProps extends BrowserSessionTileProps {
  readonly session: BrowserSessionInfo | undefined;
  readonly tab: BrowserSessionInfo["tabs"][number] | undefined;
  readonly binding: ElectronTabBinding | null;
  readonly inventoryReady: boolean;
  /**
   * Whether THIS client could place a native tab on the session's host
   * (`BrowserSessionsState.canMaterializeElectron`). Every other input here is
   * a host-side fact that describes some other client's window, and reading
   * only those is what stranded a viewer-only client on an Electron session:
   * `kind === "electron"` with no binding read as "my native tab is
   * reconnecting" on a client that has no native tabs to reconnect.
   */
  readonly canMaterializeElectron: boolean;
  readonly wakeRequested: boolean;
  readonly wakeExpired: boolean;
  readonly onRequestWake: () => void;
}

/**
 * What the host's `complete` frame means for a peek standing in for this
 * session, which is entirely a question about the client reading it: the frame
 * says "this tab is Electron-placed and has no viewer plane here", and only
 * the client knows whether that Electron tab is its own.
 */
function browserPeekCompleteMeaning(
  runtimeKind: BrowserSessionInfo["runtime"]["kind"],
  canMaterializeElectron: boolean,
): BrowserPeekCompleteMeaning {
  if (runtimeKind !== "electron") return "ended";
  return canMaterializeElectron ? "native-handoff" : "native-elsewhere";
}

function BrowserSessionTileBody(props: BrowserSessionTileBodyProps) {
  if (!props.inventoryReady) {
    return (
      <div className="flex h-full w-full items-center justify-center px-4 text-ui-sm text-muted-foreground">
        Loading browser session…
      </div>
    );
  }
  if (props.session === undefined || props.tab === undefined) {
    return (
      <div className="flex h-full w-full items-center justify-center px-4 text-ui-sm text-muted-foreground">
        Browser tab is no longer available.
      </div>
    );
  }

  // The wake-capable branch is chosen per TAB, not per session. A session's
  // runtime says where the tabs that ARE attached live; it says nothing about
  // a durable tab that has not been attached yet. `materialize` provisions
  // only the tab it was asked for, so an `electron` session routinely holds
  // dormant siblings - and the peek tile's screencast subscription is what
  // funnels one into the host's `ensureTabAttached`, which attaches a tab
  // into an already-electron session and publishes its native binding. Take
  // that branch only while there is no binding: a bound tab's pixels are
  // native, whatever the host has published for its status.
  //
  // A client that cannot place a native tab on this host takes it
  // unconditionally: every branch below waits on a binding this client can
  // never be handed, so the viewer is the only one that can ever resolve.
  if (
    props.session.runtime.kind !== "electron" ||
    !props.canMaterializeElectron ||
    (props.binding === null &&
      (props.tab.status === "dormant" || props.wakeRequested))
  ) {
    const peek: BrowserPeekNode = {
      id: props.node.id,
      instanceId: props.node.instanceId,
      hostId: props.node.hostId,
      sessionId: props.node.sessionId,
      tabId: props.node.tabId,
      initialUrl: props.tab.url,
    };
    return (
      <BrowserPeekTile
        key={props.session.runtime.revision}
        epicId={props.epicId}
        node={peek}
        viewTabId={props.viewTabId}
        paneId={props.paneId}
        completeMeans={browserPeekCompleteMeaning(
          props.session.runtime.kind,
          props.canMaterializeElectron,
        )}
      />
    );
  }

  if (props.binding === null) {
    return (
      <BrowserTabRebindWait
        onWake={props.onRequestWake}
        startExpired={props.wakeExpired}
      />
    );
  }

  const native = {
    id: props.node.id,
    sessionId: props.node.sessionId,
    instanceId: props.node.instanceId,
    name: props.tab.title ?? "Browser",
    hostId: props.node.hostId,
    url: props.tab.url,
    viewportPreset: props.node.viewportPreset,
  };
  return (
    <ElectronTabSurface
      node={native}
      binding={props.binding}
      viewTabId={props.viewTabId}
      paneId={props.paneId}
    />
  );
}

/**
 * How long a bound-for-life native tab may go without a renderer binding
 * before the tile stops calling it a reconnect. The window only has to cover
 * a desktop-side re-publish (a `browser.sessions` reconnect re-announces every
 * live binding), so seconds, not minutes - past it the wait is not transient
 * and an unbounded spinner is indistinguishable from a lost tab.
 */
const BROWSER_TAB_REBIND_DEADLINE_MS = 10_000;

/**
 * The bounded half of the null-binding wait. Below the deadline this is the
 * ordinary reconnect spinner; past it the tab is offered the same wake path a
 * dormant tab takes, which asks the host to attach the tab again and publish a
 * fresh binding.
 *
 * `startExpired` skips straight to the error state with no timer: the tile
 * passes it once the bounded wake window it started on "Reopen tab" has
 * itself expired with the binding still null, so a reader who already waited
 * once is not made to sit through a second identical spinner before seeing
 * the button again.
 */
function BrowserTabRebindWait(props: {
  readonly onWake: () => void;
  readonly startExpired: boolean;
}) {
  const [expired, setExpired] = useState(props.startExpired);
  useEffect(() => {
    if (props.startExpired) return;
    const timer = setTimeout(() => {
      setExpired(true);
    }, BROWSER_TAB_REBIND_DEADLINE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [props.startExpired]);

  if (!expired) {
    return (
      <div
        role="status"
        aria-label="Reconnecting browser tab"
        aria-busy
        className="flex h-full w-full items-center justify-center px-4 text-ui-sm text-muted-foreground"
      >
        Reconnecting browser tab…
      </div>
    );
  }
  return (
    <div
      role="alert"
      data-testid="browser-tab-rebind-timeout"
      className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center text-ui-sm text-muted-foreground"
    >
      <p className="max-w-md">
        This browser tab did not come back from its window. Reopening it starts
        a fresh view of the same page.
      </p>
      <Button type="button" variant="outline" size="sm" onClick={props.onWake}>
        Reopen tab
      </Button>
    </div>
  );
}

/**
 * `plan-restricted` is not an outage (see `useHostReachability`'s doc): the
 * machine is very probably running, only this account's plan has no remote
 * route to it. Worded the same way `TerminalDeadTileBanner` words it for
 * that reason. `offline` also covers `indeterminate`/`starting-deadline`
 * fall-through - neither of those reaches `status: "unreachable"` with a
 * `plan-restricted` reason.
 */
function dormantStatusLine(unavailability: HostUnavailability | null): string {
  if (unavailability === "plan-restricted") {
    return "This host is local only on your current plan, so it can't be reached from here.";
  }
  return "Host is unreachable. This tile will reconnect on its own.";
}

/**
 * Dormant placeholder for a tile whose OWN host is `unreachable`
 * (decision #9). Never rendered for `busy` - a busy host is still
 * reachable (`useHostReachability`/`isHostReachable`), and the live tile
 * keeps rendering as-is/connecting through that state.
 *
 * Greys out the last known frame if the tab ever streamed one
 * (`useLastBrowserPeekFrame`, which reads the cache once the placeholder is
 * committed - the peek tile's teardown writes its dormant video snapshot in
 * that same commit, after this render). There is deliberately no interactive
 * chrome and no clone/"open on
 * this device" affordance - the tile re-renders live on its own once the
 * host's lease returns, through the same reactive `useHostReachability` read
 * that put it here.
 */
function BrowserSessionDormantPlaceholder(props: {
  readonly node: BrowserSessionTileRef;
  readonly hostLabel: string;
  readonly unavailability: HostUnavailability | null;
}) {
  const cached = useLastBrowserPeekFrame(browserPeekFrameKey(props.node));
  // First non-null frame wins for this placeholder's life. The cache read is a
  // post-commit re-check (the peek tile's teardown writes in the same commit
  // that mounts this), but it keeps re-reading afterwards - and the cache is
  // insertion-order evicted, so other tiles streaming can drop this key while
  // the placeholder is still up. Latching here keeps the greyed frame from
  // disappearing mid-dormancy. Set during render, the same sanctioned pattern
  // `useRuntimeDemotionNote` uses below.
  const [lastFrame, setLastFrame] = useState(cached);
  if (lastFrame === null && cached !== null) setLastFrame(cached);
  return (
    <div
      className="relative flex h-full w-full flex-col items-center justify-center gap-2 overflow-hidden bg-canvas px-4 text-center"
      data-testid="browser-session-dormant-placeholder"
    >
      {lastFrame === null ? null : (
        <img
          src={lastFrame.src}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="absolute inset-0 h-full w-full object-contain opacity-30 grayscale"
        />
      )}
      <div className="relative z-10 max-w-md text-ui-sm text-muted-foreground">
        <div className="font-medium text-foreground">{props.hostLabel}</div>
        <div>{dormantStatusLine(props.unavailability)}</div>
      </div>
    </div>
  );
}

/**
 * One-line dismissible note for a session that just lost its Electron
 * runtime (`runtime.kind` flip electron -> headless on a revision bump).
 * The tab keeps working, streamed instead of native, but silently loses
 * annotate/find/DevTools/zoom - this is the only surface that says so.
 */
function BrowserRuntimeDemotionNote(props: {
  readonly hostLabel: string;
  readonly onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      data-testid="browser-runtime-demotion-note"
      // muted-fill-ok: this banner carries its own border-b border-border,
      // so a muted collapse loses the wash and not the band underneath it.
      className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-ui-xs text-muted-foreground"
    >
      <span className="min-w-0 flex-1">
        Continuing streamed from {props.hostLabel}
      </span>
      <button
        type="button"
        aria-label="Dismiss"
        className="shrink-0 text-muted-foreground hover:text-foreground"
        onClick={props.onDismiss}
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}

/**
 * Tracks the electron -> headless transition for one session across
 * revision bumps and whether the reader has dismissed the note for the
 * revision that caused it.
 *
 * Adjusted during render (React's documented "adjusting state when props
 * change") rather than in an effect: an effect would trip
 * `react-hooks/set-state-in-effect`, and would also paint one stale commit
 * before the transition is recorded.
 */
function useRuntimeDemotionNote(
  runtimeKind: BrowserSessionInfo["runtime"]["kind"] | null,
  runtimeRevision: number | null,
): {
  readonly visible: boolean;
  readonly dismiss: () => void;
} {
  const [prev, setPrev] = useState<{
    readonly kind: BrowserSessionInfo["runtime"]["kind"];
    readonly revision: number;
  } | null>(null);
  const [demotedRevision, setDemotedRevision] = useState<number | null>(null);

  if (
    runtimeKind !== null &&
    runtimeRevision !== null &&
    (prev === null ||
      prev.kind !== runtimeKind ||
      prev.revision !== runtimeRevision)
  ) {
    setPrev({ kind: runtimeKind, revision: runtimeRevision });
    // Re-promoted back to Electron: the note's premise (streamed instead of
    // native) no longer holds, so clear it rather than leaving it stuck on
    // until someone dismisses a note about a demotion that already reversed.
    if (runtimeKind === "electron") {
      setDemotedRevision(null);
    } else if (
      prev !== null &&
      prev.kind === "electron" &&
      prev.revision !== runtimeRevision
    ) {
      setDemotedRevision(runtimeRevision);
    }
  }

  // Dismissing clears the demotion outright: a LATER demotion sets a new
  // revision, so there is nothing a separate "dismissed" revision can say that
  // this cannot.
  const dismiss = useCallback(() => {
    setDemotedRevision(null);
  }, []);

  return { visible: demotedRevision !== null, dismiss };
}

/**
 * The sessions context this reads is the TILE's host stream: `renderTile`
 * puts every tile's subtree behind a `BrowserSessionsHostBoundary` for
 * `node.hostId`, so there is no per-tile boundary here.
 */
export function BrowserSessionTile(props: BrowserSessionTileProps) {
  const sessions = useBrowserSessionsContext();
  const reachability = useHostReachability(props.node.hostId);
  const session = sessions.items.find(
    (item) => item.sessionId === props.node.sessionId,
  );
  const tab = session?.tabs.find((item) => item.tabId === props.node.tabId);
  const binding = useElectronTabBindingOnHost(
    props.node.sessionId,
    props.node.tabId,
    props.node.hostId,
  );
  const closeCanvasTile = useCloseCanvasTileWithNestedFocus(
    props.viewTabId,
    props.paneId,
    props.node.instanceId,
  );
  const demotionNote = useRuntimeDemotionNote(
    session?.runtime.kind ?? null,
    session?.runtime.revision ?? null,
  );
  // Bounded, not latched: once the reader has asked for the tab back, the
  // wake path stays selected for one BROWSER_TAB_REBIND_DEADLINE_MS window -
  // the same deadline the reconnect wait itself uses, long enough to cover
  // the peek tile's own attach round trip. `wakeRequestedAt` is written ONLY
  // by the "Reopen tab" click, which is also the only place a fresh request
  // clears `wakeWindowExpired`; the timer that flips it back to `true` is
  // armed once per click (keyed on `wakeRequestedAt` alone) and keeps
  // counting down regardless of binding transitions in between - a binding
  // arriving doesn't need to reset anything, because a bound tab already
  // wins over the wake branch below purely by requiring `binding === null`,
  // and a stale expiry is inert while bound. `wakeActive`/`wakeExpired` are
  // plain reads of that state at render time (render must stay pure, so
  // `Date.now()` is read only inside the click handler and the effect, never
  // here) - if a LATER reconnect drops the binding again after the window
  // has already elapsed, it reads straight as expired, the same actionable
  // alert a fresh expiry produces, never a phantom headless projection or an
  // infinite spinner.
  const [wakeRequestedAt, setWakeRequestedAt] = useState<number | null>(null);
  const [wakeWindowExpired, setWakeWindowExpired] = useState(false);
  const requestWake = useCallback(() => {
    setWakeRequestedAt(Date.now());
    setWakeWindowExpired(false);
  }, []);
  useEffect(() => {
    if (wakeRequestedAt === null) return;
    const remaining =
      BROWSER_TAB_REBIND_DEADLINE_MS - (Date.now() - wakeRequestedAt);
    const timer = setTimeout(
      () => {
        setWakeWindowExpired(true);
      },
      Math.max(remaining, 0),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [wakeRequestedAt]);
  const wakeActive =
    binding === null && wakeRequestedAt !== null && !wakeWindowExpired;
  const wakeExpired =
    binding === null && wakeRequestedAt !== null && wakeWindowExpired;
  useEffect(() => {
    if (session !== undefined && tab !== undefined) return;
    if (sessions.lifecycle !== "live" || !sessions.inventoryReady) return;
    // Belt-and-braces guard, not the primary gate: the coordinator's own
    // "live" lifecycle is sourced from its stream and can lag the
    // directory's faster reachability signal, so a host that just went
    // unreachable could still read `lifecycle: "live"` here for one tick
    // with stale/emptied `items`. Without this, that window could close a
    // tile decision #9 requires to go dormant instead. `unreachable` alone
    // decides it - `busy` stays reachable and must not gate self-close.
    if (reachability.status === "unreachable") return;
    // The tab is genuinely gone, not merely dormant - free its cached frame
    // along with closing the tile so a future tab reusing this instance id
    // never starts from a stale image.
    clearLastBrowserPeekFrame(browserPeekFrameKey(props.node));
    closeCanvasTile();
  }, [
    closeCanvasTile,
    sessions.inventoryReady,
    session,
    sessions.lifecycle,
    tab,
    reachability.status,
    props.node,
  ]);

  if (reachability.status === "unreachable") {
    return (
      <BrowserSessionDormantPlaceholder
        node={props.node}
        hostLabel={reachability.hostLabel}
        unavailability={reachability.unavailability}
      />
    );
  }

  return (
    <div className="flex h-full w-full min-h-0 flex-col">
      {demotionNote.visible ? (
        <BrowserRuntimeDemotionNote
          hostLabel={reachability.hostLabel}
          onDismiss={demotionNote.dismiss}
        />
      ) : null}
      <div className="min-h-0 flex-1">
        <BrowserSessionTileBody
          {...props}
          session={session}
          tab={tab}
          binding={binding}
          inventoryReady={sessions.inventoryReady}
          canMaterializeElectron={sessions.canMaterializeElectron}
          wakeRequested={wakeActive}
          wakeExpired={wakeExpired}
          onRequestWake={requestWake}
        />
      </div>
    </div>
  );
}
