import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import type { BrowserSessionInfo } from "@traycer/protocol/host/browser/contracts";
import type { BrowserViewViewportPresetId } from "@traycer-clients/shared/platform/browser-view";
import type { HostUnavailability } from "@traycer-clients/shared/host-client/remote-fetcher";
import { ElectronTabSurface } from "./agent-browser-tile";
import {
  BrowserPeekTile,
  type BrowserPeekCompleteMeaning,
  type BrowserPeekNode,
} from "./browser-peek-tile";
import {
  browserTileScope,
  type BrowserTileNode,
  type BrowserTilePlacement,
} from "./browser-tile-placement";
import { useBrowserSessionsContext } from "@/components/epic-canvas/renderers/browser-sessions-context";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  useElectronTabBindingOnHost,
  type ElectronTabBinding,
} from "@/lib/browser-view/sessions/electron-tab-directory";
import {
  browserPeekFrameKey,
  clearLastBrowserPeekFrame,
  useLastBrowserPeekFrame,
} from "@/lib/browser-view/sessions/peek-frame-cache";
import { useDesktopWindowId } from "@/lib/windows/desktop-window-id";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";

/**
 * The shared browser tab tile: the binding wait, the wake window and its
 * deadline, the demotion note, and the electron-versus-peek switch. Everything
 * here is placement-independent, which is what lets the task canvas and the
 * Start Page panel render the same tile.
 *
 * Every canvas fact this used to read - tile visibility, the close path, the
 * epic, viewport persistence, link opening, picture-in-picture - arrives as a
 * prop from the host surface's adapter. That is enforced, not merely intended:
 * `src/__tests__/browser-tile-canvas-boundary.test.ts` fails if this file or
 * either surface imports the canvas store or the tile-open routing.
 */
export interface BrowserTabTileProps {
  readonly placement: BrowserTilePlacement;
  readonly node: BrowserTileNode;
  /** Whether the tile body is actually on screen, not merely mounted. */
  readonly visible: boolean;
  /**
   * The native surface's page-session identity. Opaque; the desktop never
   * interprets it, and it only has to be stable for one mounted tile.
   */
  readonly pageSessionId: string;
  readonly onRequestClose: () => void;
  /** `null` where the host surface does not persist a viewport choice. */
  readonly persistViewportPreset:
    | ((preset: BrowserViewViewportPresetId) => void)
    | null;
  /**
   * Where a link the page wants in a new tab goes. The disposition is the
   * page's own: a background open (middle/ctrl/cmd-click) must not steal
   * focus from the tab the reader is on.
   */
  readonly onOpenLinkInNewTile:
    | ((url: string, disposition: "foreground" | "background") => void)
    | null;
  /**
   * The guest's own "new tab" chord, which is a different request from a link
   * open even though both used to arrive on `onOpenLinkInNewTile`.
   *
   * They cannot be told apart there: the chord is delivered as
   * `onOpenLinkInNewTile(DEFAULT_BROWSER_TILE_URL, "foreground")`, which is
   * byte-identical to a page calling `window.open("about:blank")`. The Start
   * Page needs them separated - a chord opens its chooser, while a real popup
   * must still open a host tab the page can then navigate - so the two are
   * separate props rather than one callback with a url heuristic.
   *
   * `null` falls back to the link path, which is exactly the canvas behavior
   * this replaced, so the canvas adapter passes `null` and is unchanged.
   */
  readonly onRequestNewTab: (() => void) | null;
  /**
   * The native view for this tile took focus.
   *
   * A host-shaped consequence of a browser fact, in the same shape as the two
   * above: the canvas claims its pane's activation so the focus leaves
   * whatever pane held it, and the Start Page panel - which has no panes -
   * passes `null`.
   */
  readonly onNativeTileFocused: (() => void) | null;
  readonly onConvertToPip: (() => void) | null;
}

interface BrowserTabTileSurfaceProps extends BrowserTabTileProps {
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
  /**
   * THIS renderer's desktop window id, or `null` off Electron - the string the
   * host echoes as `BrowserTabInfo.boundWindowId` for the route holding a
   * tab's binding. `lib/windows/desktop-window-id.ts` records why those two
   * are the same string rather than two ids describing one window.
   */
  readonly desktopWindowId: string | null;
  readonly wakeRequested: boolean;
  readonly wakeExpired: boolean;
  readonly onRequestWake: () => void;
  /**
   * "Show here": move this tab's native guest out of the window that holds it
   * and into this one, page state intact. Rejects with the host's reason,
   * which the note toasts before putting its button back.
   */
  readonly onShowHere: () => Promise<void>;
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

/**
 * Whether the host has said, as a fact, that this tab's native binding is held
 * by a route in some OTHER desktop window.
 *
 * This is the question the tile used to answer by timing - "no binding after
 * the deadline, so it must be elsewhere" - which mislabels four states that
 * have nothing to do with another window: a same-window reload whose rebind
 * stalls, a create still pending on this window's own route, the gap between a
 * window closing and the host noticing, and a rebind that failed outright. The
 * host knows which subscriber holds the binding and which window that
 * subscriber speaks for, so it says so on `boundWindowId` and the tile reads
 * it. `null` is not "elsewhere": it is "no route holds this tab", which is
 * exactly the case the timing-based reconnect wait still covers.
 */
function tabBoundInAnotherWindow(
  session: BrowserSessionInfo,
  tab: BrowserSessionInfo["tabs"][number],
  desktopWindowId: string | null,
): boolean {
  if (session.runtime.kind !== "electron") return false;
  if (tab.boundWindowId === null) return false;
  return tab.boundWindowId !== desktopWindowId;
}

/**
 * The activation edge that asks the host to attach this tab on THIS window's
 * route: the body is on screen, this client could place a native tab on the
 * session's host, and no route has handed it a binding.
 *
 * That covers every state the ask is for - a dormant tab, a dormant session's
 * first native birth, and a tab whose binding has not arrived - and it is
 * deliberately NOT narrowed to `runtime.kind === "electron"`, because a
 * dormant session's birth resolves its route from scratch and is exactly the
 * case that would otherwise land in whichever window happens to be the
 * scope's default.
 *
 * `canMaterializeElectron` is what keeps a viewer from ever asking, standing
 * in for the gate it cannot sit below: the branch this precedes is an early
 * return inside the surface, and no effect can follow one.
 */
function shouldRequestTabAttach(args: {
  readonly canMaterializeElectron: boolean;
  readonly inventoryReady: boolean;
  readonly visible: boolean;
  readonly session: BrowserSessionInfo | undefined;
  readonly tab: BrowserSessionInfo["tabs"][number] | undefined;
  readonly binding: ElectronTabBinding | null;
  readonly hostReachable: boolean;
}): boolean {
  if (!args.canMaterializeElectron || !args.inventoryReady) return false;
  if (!args.visible || !args.hostReachable) return false;
  if (args.session === undefined || args.tab === undefined) return false;
  if (args.binding !== null) return false;
  // A LIVE headless session is neither of the two cases above and must not
  // ask. `canMaterializeElectron` is a property of the CLIENT, not of the
  // session, so without this term every local agent-driven Playwright tile on
  // a desktop satisfies every other term - a headless session never publishes
  // a native binding - and asks the host to place its tab natively on nothing
  // but being looked at. The two intended cases both survive: a dormant
  // session's first native birth is a dormant TAB, and a tab whose binding has
  // not arrived is on an `electron` session.
  return (
    args.session.runtime.kind === "electron" || args.tab.status === "dormant"
  );
}

function BrowserTabTileSurface(props: BrowserTabTileSurfaceProps) {
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
      instanceId: props.node.instanceId,
      hostId: props.node.hostId,
      sessionId: props.node.sessionId,
      tabId: props.node.tabId,
      initialUrl: props.tab.url,
    };
    return (
      <BrowserPeekTile
        key={props.session.runtime.revision}
        scope={browserTileScope(props.placement)}
        node={peek}
        visible={props.visible}
        onConvertToPip={props.onConvertToPip}
        completeMeans={browserPeekCompleteMeaning(
          props.session.runtime.kind,
          props.canMaterializeElectron,
        )}
      />
    );
  }

  if (props.binding === null) {
    // Below the `canMaterializeElectron` gate above, so a remote viewer never
    // reaches it - a viewer has no window for the tab to be "elsewhere" from,
    // and its own branch already says `native-elsewhere`. Before the wait
    // rather than after it: the wait is a guess about elapsed time and this is
    // the host's answer, so it displaces the spinner and pre-empts the
    // reopen alert instead of sitting behind ten seconds of one.
    if (
      tabBoundInAnotherWindow(props.session, props.tab, props.desktopWindowId)
    ) {
      return <BrowserTabOtherWindowNote onShowHere={props.onShowHere} />;
    }
    return (
      <BrowserTabRebindWait
        onWake={props.onRequestWake}
        startExpired={props.wakeExpired}
      />
    );
  }

  return (
    <ElectronTabSurface
      node={{
        instanceId: props.node.instanceId,
        hostId: props.node.hostId,
        sessionId: props.node.sessionId,
        url: props.tab.url,
        viewportPreset: props.node.viewportPreset,
      }}
      binding={props.binding}
      placement={props.placement}
      visible={props.visible}
      pageSessionId={props.pageSessionId}
      onRequestClose={props.onRequestClose}
      persistViewportPreset={props.persistViewportPreset}
      onOpenLinkInNewTile={props.onOpenLinkInNewTile}
      onRequestNewTab={props.onRequestNewTab}
      onConvertToPip={props.onConvertToPip}
      onNativeTileFocused={props.onNativeTileFocused}
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
 * A tab whose native binding is held by another desktop window's route, and
 * the one gesture that moves it here.
 *
 * "Show here" is a `moveTab` frame, not an attach: the tile's ordinary
 * per-activation `attachTab` is reject-never-relocate by construction, which
 * is what keeps a tab from being yanked between windows by nothing more than
 * being looked at. The move is a deliberate press, so it is the one frame
 * allowed to displace a live guest - and the host serializes it against every
 * competing attach, create and reconcile before touching anything.
 *
 * The button lives OUTSIDE the `browser-tab-other-window` node so that node
 * stays exactly its copy: the note is what a reader is told, the button is
 * what they may do about it, and a test that pins the wording should not have
 * to spell the control too.
 *
 * Pending is the note's own state rather than a prop, because the only thing
 * that ends it is this promise - and it is cleared on SETTLE, not only on
 * rejection. A successful move normally unmounts this whole branch before its
 * ack even arrives: the host publishes `sessionUpdated` with `boundWindowId`
 * naming this window from `handleElectronTabProvisioned`, ahead of the frame
 * router's ack, so there is no button left to flash back. What the `finally`
 * is for is the other resolve - an `ok` ack whose binding does not land here,
 * which the host's degrade-to-attach arm can produce - where clearing only on
 * rejection would leave a disabled button forever.
 *
 * The pending state is `disabled` plus an inline spinner and NEVER a swapped
 * label (`AGENTS.md`'s pending-UX rule): the copy above stays put and the
 * button keeps saying what it does. A rejection is the reader's answer - the
 * host's reason, toasted. `role="status"` rather than `alert`: nothing is
 * wrong, this is a standing fact about where the tab is.
 */
function BrowserTabOtherWindowNote(props: {
  readonly onShowHere: () => Promise<void>;
}) {
  const [moving, setMoving] = useState(false);
  const onShowHere = props.onShowHere;
  const showHere = useCallback(() => {
    setMoving(true);
    void onShowHere()
      .catch((error: unknown) => {
        toast.error(
          error instanceof Error
            ? error.message
            : "Couldn't show the browser tab here. Try again.",
        );
      })
      .finally(() => {
        setMoving(false);
      });
  }, [onShowHere]);

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-4 text-center">
      <div
        role="status"
        data-testid="browser-tab-other-window"
        className="text-ui-sm text-muted-foreground"
      >
        Open in your other window
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={moving}
        aria-live="polite"
        onClick={showHere}
      >
        {moving ? (
          <AgentSpinningDots
            className="text-current"
            testId="browser-tab-show-here-spinner"
            variant={undefined}
          />
        ) : null}
        Show here
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
function BrowserTabDormantPlaceholder(props: {
  readonly node: BrowserTileNode;
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
 * The sessions context this reads is the TILE's host stream: the host surface
 * puts every tile's subtree behind a `BrowserSessionsHostBoundary` for
 * `node.hostId`, so there is no per-tile boundary here.
 */
export function BrowserTabTile(props: BrowserTabTileProps) {
  const sessions = useBrowserSessionsContext();
  const attachTab = sessions.attachTab;
  const moveTab = sessions.moveTab;
  const reachability = useHostReachability(props.node.hostId);
  const desktopWindowId = useDesktopWindowId();
  const session = sessions.items.find(
    (item) => item.sessionId === props.node.sessionId,
  );
  const tab = session?.tabs.find((item) => item.tabId === props.node.tabId);
  const binding = useElectronTabBindingOnHost(
    props.node.sessionId,
    props.node.tabId,
    props.node.hostId,
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
  /**
   * "Attach this tab on MY window's route." The host elects native routes per
   * scope AND window, so without this the tab is woken onto whichever route is
   * the scope's default and the reader watches it appear in the other window.
   *
   * Fire-and-forget by construction, and that is the whole design rather than
   * missing error handling: the screencast subscription behind the peek branch
   * is still what WAKES the tab, and this only names the window that asked. So
   * a rejection (the tab is bound in another window, the session is closing)
   * and a timeout (a host too old to have the frame's reader) both leave the
   * tile rendering exactly what it renders without it, and neither is worth a
   * retry - the reader's own next activation is the retry.
   */
  const sendAttachTab = useCallback(() => {
    void attachTab(props.node.tabId).catch(() => undefined);
  }, [attachTab, props.node.tabId]);
  /**
   * The exact opposite of `sendAttachTab` in how its outcome is handled, for
   * the reason stated on the note: this one is a press, so the rejection is
   * the reader's answer and is returned to them rather than swallowed.
   */
  const sendMoveTab = useCallback(
    () => moveTab(props.node.tabId),
    [moveTab, props.node.tabId],
  );
  /**
   * The wake sends the hint first, so it precedes the peek branch the two
   * `setState`s below are about to mount - the same ordering the activation
   * layout effect buys on the mount path.
   *
   * The restart survives every ack outcome only because `attachTab` cannot
   * throw SYNCHRONOUSLY: the coordinator wraps its send in try/catch and hands
   * back a rejected promise when the stream is not live, and the
   * no-coordinator stub returns `Promise.reject`. Nothing sits between this
   * call and `setWakeRequestedAt`, so a future `attachTab` that threw on the
   * calling stack would eat the reader's restart.
   */
  const requestWake = useCallback(() => {
    sendAttachTab();
    setWakeRequestedAt(Date.now());
    setWakeWindowExpired(false);
  }, [sendAttachTab]);
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
  // Edge-triggered through a ref holding the tab it last asked for: once per
  // activation is the contract, so a re-render, a rejected ack, a timed-out
  // ack and a `wakeRequested` flip must all send nothing more. The predicate
  // going false clears it, which is what makes a later activation - a
  // reconnect, a reader coming back to a concealed tab - a fresh ask. Keyed to
  // the tab id rather than a bare flag because the effect also re-runs when
  // `props.node.tabId` changes underneath a predicate that stayed true, and a
  // flag would swallow the NEW tab's ask and leave the tile waiting on a
  // binding it never requested. Unreachable on the canvas, where a tab change
  // remounts, and reachable as soon as the Start Page panel renders this body
  // with a store that re-keys refs in place.
  const attachRequestedTabIdRef = useRef<string | null>(null);
  const shouldRequestAttach = shouldRequestTabAttach({
    canMaterializeElectron: sessions.canMaterializeElectron,
    inventoryReady: sessions.inventoryReady,
    visible: props.visible,
    session,
    tab,
    binding,
    hostReachable: reachability.status !== "unreachable",
  });
  // A LAYOUT effect, and that one word is the whole ordering guarantee.
  //
  // On the activation this ticket exists for - a dormant tab, in the window
  // that is not the scope's default route - the surface renders the peek
  // branch, and the peek tile's screencast subscription is what funnels the
  // tab into the host's `ensureTabAttached`. That subscribe is a PASSIVE
  // effect in a child, and React flushes every layout effect of a commit
  // before any passive effect of that commit, so asking here beats the wake
  // there on both the mount path and the reveal path. Passive would lose:
  // passive effects flush child-first, the wake would reach the host with no
  // window named, the host would elect the default route, and the hint that
  // followed would be answered "bound in another window" - leaving window B
  // showing "Open in your other window" for a tab it had just asked for.
  //
  // Load-bearing because the host rejects and never relocates: an attach that
  // arrives after the binding exists elsewhere cannot move it back, so the
  // only fix is to arrive first. The two frames still travel on different
  // streams (`browser.sessions` and `browser.screencast`), so this buys ISSUE
  // order, not host-side arrival order; the host is what closes the remainder.
  useLayoutEffect(() => {
    if (!shouldRequestAttach) {
      attachRequestedTabIdRef.current = null;
      return;
    }
    if (attachRequestedTabIdRef.current === props.node.tabId) return;
    attachRequestedTabIdRef.current = props.node.tabId;
    sendAttachTab();
  }, [props.node.tabId, sendAttachTab, shouldRequestAttach]);
  const wakeActive =
    binding === null && wakeRequestedAt !== null && !wakeWindowExpired;
  const wakeExpired =
    binding === null && wakeRequestedAt !== null && wakeWindowExpired;
  const onRequestClose = props.onRequestClose;
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
    onRequestClose();
  }, [
    onRequestClose,
    sessions.inventoryReady,
    session,
    sessions.lifecycle,
    tab,
    reachability.status,
    props.node,
  ]);

  if (reachability.status === "unreachable") {
    return (
      <BrowserTabDormantPlaceholder
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
        <BrowserTabTileSurface
          {...props}
          session={session}
          tab={tab}
          binding={binding}
          inventoryReady={sessions.inventoryReady}
          canMaterializeElectron={sessions.canMaterializeElectron}
          desktopWindowId={desktopWindowId}
          wakeRequested={wakeActive}
          wakeExpired={wakeExpired}
          onRequestWake={requestWake}
          onShowHere={sendMoveTab}
        />
      </div>
    </div>
  );
}
