import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type TransitionEvent as ReactTransitionEvent,
} from "react";
import {
  Maximize2,
  Minimize2,
  PanelRight,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import { Button } from "@/components/ui/button";
import { registerDynamicActionHandler } from "@/lib/keybindings/dispatch";
import { useLandingTerminalSurfaceActive } from "./landing-terminal-surface-binding";
import {
  LEADER_SCOPE_LANDING_TERMINAL,
  registerLeaderScope,
} from "@/lib/keybindings/leader-scope";
import { getSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import {
  pointerDragHandleAxisClassName,
  usePointerDragCommit,
  type PointerDragSliderProps,
} from "@/components/epic-canvas/canvas/use-pointer-drag-commit";
import { useCoarsePointer } from "@/hooks/ui/use-coarse-pointer";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import {
  landingTerminalRightActionsKey,
  useMobileHeaderStore,
} from "@/stores/layout/mobile-header-store";
import { useVirtualKeyboardInset } from "@/hooks/ui/use-virtual-keyboard-inset";
import { useNativeKeyboardOpen } from "@/hooks/ui/use-native-keyboard-open";
import { isMobileApp } from "@/lib/mobile-app";
import { MobileTerminalKeyBar } from "@/components/epic-canvas/mobile/mobile-terminal-key-bar";
import { terminalSessionTitle } from "@/lib/terminals/terminal-title";
import { requestLandingTerminalClose } from "@/lib/terminals/landing-terminal-close-coordinator";
import {
  getPlainTerminal,
  selectPlainTerminalViewModel,
  type PlainTerminalViewModel,
} from "@/lib/terminals/plain-terminal-authority";
import { isPanelResizeInteractionActive } from "@/lib/layout/panel-resizing-class";
import { focusActiveComposer } from "@/lib/composer/composer-focus-registry";
import {
  hasPrimaryFocusIntent,
  reconcilePrimaryFocus,
  requestPrimaryFocus,
} from "@/lib/focus/primary-focus-coordinator";
import {
  clearPendingTerminalFocus,
  focusTerminalInstance,
} from "@/lib/terminals/terminal-focus-registry";
import { reconcileXtermHostAfterLayoutTransition } from "@/components/epic-canvas/renderers/xterm-host-registry";
import { cn } from "@/lib/utils";
import {
  DEFAULT_LANDING_PANEL_WIDTH_FRACTION,
  MAX_LANDING_PANEL_WIDTH_FRACTION,
  MIN_LANDING_PANEL_WIDTH_FRACTION,
  isLandingTerminalTab,
  landingBrowserTabs,
  landingPanelLayoutFor,
  landingTerminalTabs,
  activeLandingTerminalInstanceId,
  useLandingPanelStore,
  type LandingBrowserTabRef,
  type LandingPanelPlaceholder,
  type LandingPanelTabRef,
  type LandingTerminalTabRef,
} from "@/stores/home/landing-panel-store";
import type { BrowserSessionsState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import { LandingTerminalTabStrip } from "./landing-terminal-tab-strip";
import {
  landingStripAdjacentInstanceId,
  landingStripRows,
  landingStripTabRows,
} from "./landing-strip-rows";
import { LandingTerminalDirectoryPicker } from "./landing-terminal-directory-picker";
import { LandingTerminalTile } from "./landing-terminal-tile";
import { LandingBrowserTile } from "./landing-browser-tile";
import {
  selectLandingBrowserViewModel,
  type LandingBrowserViewModel,
} from "./landing-browser-presentation";
import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";
import { screencastRoleForShell } from "@/lib/browser-view/sessions/use-screencast-session";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";
import {
  landingBrowserCapMessage,
  landingBrowserViewerMessage,
  useLandingBrowserOpenLink,
  useLandingBrowserOpenTab,
  LANDING_BROWSER_TAB_CAP,
} from "./use-landing-browser-open-tab";
import {
  LandingNewTabChooser,
  type LandingNewTabKind,
} from "./landing-new-tab-chooser";
import {
  LandingTerminalAuthorityFleet,
  type LandingBrowserSessionEntries,
  type LandingTerminalAuthorityEntries,
  type LandingTerminalAuthorityEntry,
} from "./landing-terminal-authority-fleet";
import { LandingTerminalBoundHostReconciliationFleet } from "./landing-terminal-bound-host-reconciliation";
import {
  useLandingTerminalKill,
  type LandingTerminalKillVariables,
} from "./use-landing-terminal-kill-mutation";
import { useLandingTerminalReconciliation } from "./use-landing-terminal-reconciliation";
import { type LandingTerminalAvailability } from "./landing-terminal-availability";
import {
  useLandingTerminalGesture,
  type LandingTerminalTarget,
} from "./landing-terminal-gesture-context";
import {
  LANDING_TERMINAL_HOST_UPDATE_GUIDANCE,
  resolveLandingTerminalLaunchCwd,
  type LandingTerminalHostContext,
} from "./landing-terminal-host-context";

/**
 * The one "the device has not answered yet" string, shared by the body's status
 * line, the terminal create gate, and the chooser's cards. The core flows call
 * for the SAME message in all three, and four separate literals is four chances
 * for one to drift.
 */
const LANDING_PANEL_CONNECTING_MESSAGE = "Connecting to the selected host…";

/** The strip "+" tooltip. The chord is spelled out because "+" is not. */
const LANDING_NEW_TAB_TOOLTIP = "New tab (\u2318T)";

/**
 * The panel's own surface. Desktop is a docked split, so it reads as chrome
 * beside the content and carries the seam borders. The phone overlay covers the
 * page rather than sitting next to it, so `bg-canvas` there laid a white sheet
 * under the `bg-background` header, and the borders divide nothing.
 */
function landingTerminalPanelSurfaceClass(isMobile: boolean): string {
  return isMobile
    ? "bg-background"
    : "border-t border-l border-canvas-border/70 bg-canvas";
}

interface LandingTerminalDragState {
  readonly containerWidth: number;
  readonly startWidth: number;
  readonly minWidth: number;
  readonly maxWidth: number;
  readonly panel: HTMLElement;
  readonly initialWidth: string;
  latestFraction: number;
}

type LandingTerminalDirectoryRequestMode = "reuse-or-create" | "always-create";

interface LandingTerminalDirectoryRequest {
  readonly key: number;
  readonly workspacePaths: ReadonlyArray<string>;
  readonly primaryWorkspacePath: string;
  readonly error: string | null;
  readonly closePanelOnCancel: boolean;
  readonly mode: LandingTerminalDirectoryRequestMode;
  readonly capturedTarget: LandingTerminalTarget;
  readonly selectedTarget: LandingTerminalTarget | null;
}

/**
 * Whether this host's authority can back a LIVE tab mutation right now - the
 * predicate behind create and rename, and the fast path of close.
 *
 * A missing or `"unknown"` entry means the capability probe has not answered,
 * so neither branch of the tile lifecycle can be chosen yet; a `"capable"`
 * host that cannot mutate has a stale or reconnecting list stream. `"legacy"`
 * needs no stream - its tiles create and kill through the session RPCs.
 *
 * Creation gates on this too, and must: a tab persisted while the probe is
 * unresolved lands as `hostAuthorityAcknowledged: false, pendingCreate: false`,
 * which is precisely the shape of LEGACY evidence. The next capable pass then
 * tries to `importLegacy` a terminal that was never created on any host.
 *
 * Close deliberately does NOT gate on this - it is tombstone-first and drains
 * later. See {@link dispatchLandingTerminalClose}.
 */
function landingTerminalAuthorityReady(
  entry: LandingTerminalAuthorityEntry | null | undefined,
): entry is LandingTerminalAuthorityEntry {
  if (entry === null || entry === undefined) return false;
  const capability = entry.authority.capability;
  if (capability.status === "legacy") return true;
  return capability.status === "capable" && entry.authority.canMutate;
}

/**
 * Sends the kill for an ALREADY-TOMBSTONED tab, when its bound host can be
 * asked right now.
 *
 * A host that cannot be asked - offline, or a capability probe that has not
 * answered - is not a failure here and must not block the close: the store
 * wrote the tombstone before the tab was removed, and two existing mechanisms
 * carry it from there. Reconciliation excludes a tombstoned session from
 * re-adoption when the host returns, and
 * `LandingTerminalTombstoneRecoveryBridge` (mounted above the router, so
 * leaving the landing page cannot strand it) dispatches the capability-correct
 * kill on the edge where that host becomes dialable again, with backoff.
 *
 * So this is only the fast path. It never falls back to another host: the
 * tombstone and the mutation both carry the tab's own bound `hostId`.
 */
function dispatchLandingTerminalClose(args: {
  readonly entry: LandingTerminalAuthorityEntry | undefined;
  readonly closed: LandingTerminalTabRef;
  readonly killTerminal: (
    variables: LandingTerminalKillVariables,
  ) => Promise<unknown>;
}): void {
  const { entry, closed, killTerminal } = args;
  if (!landingTerminalAuthorityReady(entry)) return;
  if (entry.authority.capability.status !== "capable") {
    // Same boundary as the capable arm below, for the same reason. `terminal.kill`
    // is scheduled `fifo`, and `selectJob` returns null for fifo rather than
    // joining an identical queued job - so an unmediated duplicate is two real
    // RPCs and two `terminal.list` invalidations on every ordinary legacy close,
    // the second answering `killed: false` about a session the first removed.
    void requestLandingTerminalClose({
      hostId: closed.hostId,
      sessionId: closed.sessionId,
      close: () =>
        killTerminal({
          hostId: closed.hostId,
          sessionId: closed.sessionId,
        }).then(() => undefined),
    }).catch(() => undefined);
    return;
  }
  // Through the shared close boundary, not straight at the mutation. The
  // tombstone this close follows is also watched by
  // `LandingTerminalTombstoneRecoveryBridge`, which sends the close for any key
  // it has not dispatched before - so on an already-drainable host both fire for
  // one gesture, from separate mutation instances that cannot see each other.
  // The coordinator collapses them onto one request; without it the loser fails
  // on a terminal the winner already removed and raises "Couldn't close the
  // terminal." for a close that worked.
  void requestLandingTerminalClose({
    hostId: closed.hostId,
    sessionId: closed.sessionId,
    close: () =>
      entry.mutations.close
        .mutateAsync({ hostId: closed.hostId, terminalId: closed.sessionId })
        .then(() => undefined),
  })
    .then((outcome) => {
      // Only the OWNER retires the record. The coordinator keys by the
      // terminal's lifetime rather than by RPC, so this close can join an
      // in-flight `terminal.kill`, and that answers an already-gone session with
      // `killed: false` DATA - the one answer the kill mutation keeps a
      // `pendingCreate` tombstone for. A joiner that cleared on it would drop
      // the record in front of the PTY that create is about to produce.
      if (!outcome.owned) return;
      useLandingPanelStore.getState().clearPendingKill(closed);
    })
    .catch(() => undefined);
}

/*
 * There is deliberately no browser counterpart to
 * `dispatchLandingTerminalClose`. The browser arm had one, and its docstring
 * claimed the recovery bridge's drain could not collide with it. That was
 * false: the drain gates on the same `inventoryReady` this did, decides from
 * the published inventory, and a tab whose close is in flight is still IN that
 * inventory until the device answers - so both senders read "present, not yet
 * attempted" and both sent. The fast path only ever bought the latency of one
 * effect flush, because unlike the terminal drain the browser drain has no
 * backoff or dialability gate to wait through; the alternative, teaching this
 * call to write the drain's per-host ready-generation bookkeeping, would have
 * put that bookkeeping in a second place to save that flush. So the drain owns
 * every browser close, and `closePanelTab` writes the tombstone and stops.
 */

function directoryRequestFor(
  target: LandingTerminalTarget,
  mode: LandingTerminalDirectoryRequestMode,
  closePanelOnCancel: boolean,
): LandingTerminalDirectoryRequest | null {
  if (target.workspacePaths.length <= 1) return null;
  return {
    key: target.generation,
    mode,
    closePanelOnCancel,
    capturedTarget: target,
    selectedTarget: null,
    workspacePaths: target.workspacePaths,
    primaryWorkspacePath:
      target.primaryWorkspacePath ?? target.workspacePaths[0],
    error: null,
  };
}

// Matched against the resolved launch cwd (primary folder, else the settled
// context's home), not merely `target.primaryWorkspacePath` - so a
// gesture-opened panel with no primary folder still re-targets an existing
// terminal already running at the reconciled host's home.
function terminalForTarget(
  tabs: ReadonlyArray<LandingTerminalTabRef>,
  activeInstanceId: string | null,
  hostId: string,
  launchCwd: string,
): LandingTerminalTabRef | undefined {
  const matches = (tab: LandingTerminalTabRef): boolean =>
    tab.hostId === hostId && tab.cwd === launchCwd;
  const active = tabs.find((tab) => tab.instanceId === activeInstanceId);
  return active !== undefined && matches(active) ? active : tabs.find(matches);
}

function settleDirectoryRequest(args: {
  readonly request: LandingTerminalDirectoryRequest | null;
  readonly generation: number;
  readonly context: LandingTerminalHostContext;
  readonly addTerminalTab: (hostId: string, cwd: string) => string | null;
  readonly replaceDirectoryRequest: (
    request: LandingTerminalDirectoryRequest | null,
  ) => void;
  readonly clearPending: () => void;
  readonly ownsFocus: () => boolean;
}): boolean {
  const request = args.request;
  if (request === null) return false;
  const selectedTarget = request.selectedTarget;
  if (
    selectedTarget === null ||
    selectedTarget.generation !== args.generation
  ) {
    return true;
  }
  const client = selectedTarget.client;
  const hostId = selectedTarget.hostId;
  const launchCwd = selectedTarget.launchWorkspacePath;
  if (
    client === null ||
    hostId === null ||
    client.getActiveHostId() !== hostId ||
    args.context.hostId !== hostId ||
    launchCwd === null
  ) {
    args.replaceDirectoryRequest({
      ...request,
      selectedTarget: null,
      error: "The terminal directory could not be opened.",
    });
    return true;
  }

  const shouldFocusTerminal = args.ownsFocus();
  const state = useLandingPanelStore.getState();
  let instanceId: string | null;
  if (request.mode === "always-create") {
    instanceId = args.addTerminalTab(hostId, launchCwd);
  } else {
    const existing = terminalForTarget(
      landingTerminalTabs(state.tabs),
      state.activeInstanceId,
      hostId,
      launchCwd,
    );
    if (existing === undefined) {
      instanceId = args.addTerminalTab(hostId, launchCwd);
    } else {
      instanceId = existing.instanceId;
      if (existing.instanceId !== state.activeInstanceId) {
        state.activateTab(existing.instanceId);
      }
    }
  }
  // Creation refused: the host's authority went unready between this
  // generation's reconciliation and its settlement. Surface the same
  // recoverable state as an unusable target rather than consuming the
  // selection silently - the picker stays up and the choice can be remade.
  if (instanceId === null) {
    args.replaceDirectoryRequest({
      ...request,
      selectedTarget: null,
      error: "The terminal directory could not be opened.",
    });
    return true;
  }
  args.replaceDirectoryRequest(null);
  args.clearPending();
  if (shouldFocusTerminal) focusTerminalInstance(instanceId);
  return true;
}

/**
 * Landing-only independent-terminal surface. It is a CONSUMER of
 * `LandingTerminalGestureProvider`: routing identity comes from its captured
 * target, while chooser presentation reads the provider's workspace source for
 * that same captured draft. No consumer reads live host or draft focus.
 */
export function LandingTerminalPanel(): ReactNode {
  const {
    focusedLandingPageId,
    target,
    pending,
    pendingGeneration,
    workspace,
    capture,
    selectWorkspacePath,
    clearPending,
  } = useLandingTerminalGesture();
  // Layout belongs to the focused start page. This is deliberately independent
  // of `target`: a pending gesture may retain an earlier page's host/folder
  // routing while focus has already moved to another page.
  const landingPageId = focusedLandingPageId ?? "unbound-landing-page";
  const targetLandingPageId = target.draftId ?? "unbound-landing-page";
  // The strip and the body render the MIXED list; the panel's terminal
  // machinery - the authority fleet, reconciliation, the kill drain, the plain
  // terminal view models - is terminal-only and reads the slice. Memoized
  // rather than filtered inside the selector: zustand compares snapshots with
  // `Object.is`, and a fresh array per read would report a change on every
  // store notification.
  const tabs = useLandingPanelStore((state) => state.tabs);
  const terminalTabs = useMemo(() => landingTerminalTabs(tabs), [tabs]);
  const browserTabs = useMemo(() => landingBrowserTabs(tabs), [tabs]);
  const [authorityEntries, setAuthorityEntries] =
    useState<LandingTerminalAuthorityEntries>({});
  const authorityHostIds = useMemo(
    () =>
      [
        ...new Set([...terminalTabs.map((tab) => tab.hostId), target.hostId]),
      ].filter((hostId): hostId is string => hostId !== null),
    [terminalTabs, target.hostId],
  );
  const handleAuthorityEntry = useCallback(
    (hostId: string, entry: LandingTerminalAuthorityEntry | null): void => {
      setAuthorityEntries((current) => {
        if (entry !== null) {
          if (current[hostId] === entry) return current;
          return { ...current, [hostId]: entry };
        }
        if (current[hostId] === undefined) return current;
        const next = { ...current };
        delete next[hostId];
        return next;
      });
    },
    [],
  );
  const targetAuthority =
    target.hostId === null ? null : (authorityEntries[target.hostId] ?? null);
  const [browserSessions, setBrowserSessions] =
    useState<LandingBrowserSessionEntries>({});
  const handleBrowserSessions = useCallback(
    (hostId: string, state: BrowserSessionsState | null): void => {
      setBrowserSessions((current) => {
        if (state !== null) {
          if (current[hostId] === state) return current;
          return { ...current, [hostId]: state };
        }
        if (current[hostId] === undefined) return current;
        const next = { ...current };
        delete next[hostId];
        return next;
      });
    },
    [],
  );
  const activeInstanceId = useLandingPanelStore(
    (state) => state.activeInstanceId,
  );
  const placeholder = useLandingPanelStore((state) => state.placeholder);
  const layout = useLandingPanelStore((state) =>
    landingPanelLayoutFor(state, landingPageId),
  );
  const panelOpen = layout.panelOpen;
  // Whether this Start Page is the surface on screen. The panel outlives its
  // activation - it stays mounted behind a backgrounded header tab so the
  // terminals beside it keep their PTYs - so "mounted" says nothing about
  // whether anything of it is being looked at.
  const paneVisible = usePaneVisible();
  // A browser stream is a socket, a relay attach, a desktop identity
  // attestation and a whole contributed-set replay, and the desktop caps a
  // window at `MAX_STREAMS_PER_WINDOW` of them, refusing whichever is asked
  // for LAST. So a panel holding streams for hosts it is showing nothing of
  // can cost the reader the tab they are actually looking at.
  //
  // The target host is unconditional, and only it: creating a browser tab goes
  // through that device's coordinator, so `app.browser.new` and the chooser's
  // tab-cap count both need one mounted before the first tab exists - and both
  // work while the panel is collapsed.
  //
  // The tab hosts follow the PANEL, not the individual tab. A collapsed panel
  // and a backgrounded Start Page render nothing, so nothing needs a tab
  // host's inventory; an OPEN one renders a strip row per tab, and that row
  // reads its title, address and dormancy from its host's inventory. Gating
  // per tab instead - only the active one's host - would leave every other
  // browser row reading "status unavailable" against a device that is fine and
  // freeze its title, which is a worse lie than the cost it saves.
  const browserHostIds = useMemo(
    () =>
      [
        ...new Set([
          target.hostId,
          ...(panelOpen && paneVisible
            ? browserTabs.map((tab) => tab.hostId)
            : []),
        ]),
      ].filter((hostId): hostId is string => hostId !== null),
    [browserTabs, panelOpen, paneVisible, target.hostId],
  );
  const targetPanelOpen = useLandingPanelStore(
    (state) => landingPanelLayoutFor(state, targetLandingPageId).panelOpen,
  );
  const panelWidthFraction = layout.panelWidthFraction;
  const setPanelOpenForPage = useLandingPanelStore(
    (state) => state.setPanelOpen,
  );
  const setPanelWidthFractionForPage = useLandingPanelStore(
    (state) => state.setPanelWidthFraction,
  );
  const setPanelMaximizedForPage = useLandingPanelStore(
    (state) => state.setPanelMaximized,
  );
  const activateTab = useLandingPanelStore((state) => state.activateTab);
  const renameTab = useLandingPanelStore((state) => state.renameTab);
  const closeTab = useLandingPanelStore((state) => state.closeTab);
  const openPlaceholder = useLandingPanelStore(
    (state) => state.openPlaceholder,
  );
  const fulfillPlaceholder = useLandingPanelStore(
    (state) => state.fulfillPlaceholder,
  );
  const dismissPlaceholder = useLandingPanelStore(
    (state) => state.dismissPlaceholder,
  );
  const kill = useLandingTerminalKill();
  const killTerminalAsync = kill.mutateAsync;
  // Last settled generation's host context. Manual create uses it only when
  // `hostId` still equals the active host; auto-spawn never reads this alone.
  const [reconciledContext, setReconciledContext] =
    useState<LandingTerminalHostContext | null>(null);
  const [directoryRequest, setDirectoryRequest] =
    useState<LandingTerminalDirectoryRequest | null>(null);
  const directoryRequestRef = useRef<LandingTerminalDirectoryRequest | null>(
    null,
  );

  const writeDirectoryRequest = useCallback(
    (request: LandingTerminalDirectoryRequest | null): void => {
      directoryRequestRef.current = request;
      setDirectoryRequest(request);
    },
    [],
  );

  // The chooser's field is not why the chooser is on screen: a directory is
  // picked from the list beneath it, and on a touch pointer focusing the field
  // covers that list with a software keyboard. Skipping the REQUEST rather
  // than the endpoint's focus is what keeps the coordinator's bookkeeping
  // honest - an intent no endpoint will ever satisfy would stay pending.
  const coarsePointer = useCoarsePointer();
  const requestDirectoryPickerFocus = useCallback(
    (requestKey: number): void => {
      if (coarsePointer) return;
      requestPrimaryFocus({
        kind: "landing-terminal-directory",
        requestId: requestKey,
      });
    },
    [coarsePointer],
  );

  const replaceDirectoryRequest = useCallback(
    (request: LandingTerminalDirectoryRequest | null): void => {
      writeDirectoryRequest(request);
      if (request !== null && request.selectedTarget === null) {
        requestDirectoryPickerFocus(request.key);
      }
    },
    [requestDirectoryPickerFocus, writeDirectoryRequest],
  );

  const setPanelOpen = useCallback(
    (open: boolean) => setPanelOpenForPage(landingPageId, open),
    [landingPageId, setPanelOpenForPage],
  );
  const setPanelWidthFraction = useCallback(
    (fraction: number) => setPanelWidthFractionForPage(landingPageId, fraction),
    [landingPageId, setPanelWidthFractionForPage],
  );
  const setMaximized = useCallback(
    (maximized: boolean) => setPanelMaximizedForPage(landingPageId, maximized),
    [landingPageId, setPanelMaximizedForPage],
  );

  // The single creation point every path funnels through - the "+", the
  // `app.terminal.new` / `tab.new` chords, the directory picker's settlement,
  // and reconciliation's auto-spawn - so the authority gate lives here rather
  // than being restated at each caller. `null` means "not created": the host's
  // authority is not ready, and a tab written now would be indistinguishable
  // from legacy evidence.
  const addTerminalTab = useCallback(
    (hostId: string, cwd: string): string | null => {
      const authority = authorityEntries[hostId];
      if (!landingTerminalAuthorityReady(authority)) return null;
      const instanceId = `landing-terminal-${uuidv4()}`;
      // Through the placeholder, always. `fulfillPlaceholder` replaces an open
      // one in its own strip position and plain-appends when there is none -
      // which is the case a create routed through the directory picker lands
      // in, since the placeholder can legitimately be dismissed while that
      // picker is up.
      fulfillPlaceholder(
        {
          kind: "terminal",
          instanceId,
          sessionId: `landing-term-${uuidv4()}`,
          hostId,
          cwd,
          name: terminalSessionTitle({
            title: null,
            activeProcessName: null,
            currentCwd: cwd,
          }),
          titleSource: "default",
          hostAuthorityAcknowledged: false,
          pendingCreate: authority.authority.capability.status === "capable",
        },
        // No particular row: a terminal create answers immediately, so there is
        // no window in which the placeholder it was picked from could be taken
        // by something else.
        null,
      );
      return instanceId;
    },
    [authorityEntries, fulfillPlaceholder],
  );

  // Manual create paths: the routing target's primary folder, else the last
  // reconciled home for that target's still-active host. Never invents a path
  // or uses another host's home. Re-read the routing client's active host at
  // invocation time: keyboard handlers can fire after a host switch but before
  // React re-renders, so the captured `routing.hostId` alone is not enough to
  // satisfy the host-identity guardrail.
  /**
   * The gesture generation that asked for a TERMINAL and could not be served
   * synchronously, or `null`.
   *
   * `capture()` cannot say what it was captured for: `app.terminal.toggle`, the
   * phone header's toggle and the open-transition effect all capture too, and a
   * settlement that treated every captured gesture as a create spawned a
   * terminal on a strip holding only browser tabs - nothing to reuse, and not
   * empty enough for the chooser to cover it. Keyed by generation so it can
   * never leak onto the next gesture.
   */
  const deferredCreateGenerationRef = useRef<number | null>(null);
  const createTerminalTab = useCallback(
    (routing: LandingTerminalTarget): string | null => {
      if (routing.hostId === null || routing.availability !== "supported") {
        return null;
      }
      // Fail-closed: no host client (a gesture that could not pin one) means we
      // cannot reconcile the terminal, so we do not create it. In non-gesture
      // operation the target carries the default client, so this never blocks.
      const client = routing.client;
      if (client === null) return null;
      const currentHostId = client.getActiveHostId();
      if (currentHostId === null || currentHostId !== routing.hostId) {
        return null;
      }
      const launchCwd = resolveLandingTerminalLaunchCwd(
        routing.launchWorkspacePath,
        reconciledContext,
        currentHostId,
      );
      if (launchCwd === null) return null;
      return addTerminalTab(currentHostId, launchCwd);
    },
    [addTerminalTab, reconciledContext],
  );

  // The tab-family chord ("new terminal"): if the panel is closed, capture the
  // open gesture and create from THAT captured snapshot up-front (the non-empty
  // set suppresses the open reconciliation's auto-spawn). If already open, it is
  // just a `+` - create against the effective target, never re-capturing.
  const revealAndCreateTerminal = useCallback(() => {
    if (directoryRequestRef.current !== null) {
      if (panelOpen) return;
      replaceDirectoryRequest(null);
    }
    if (panelOpen) {
      const request =
        target.workspacePaths.length > 1
          ? directoryRequestFor(
              pending ? target : capture(),
              "always-create",
              false,
            )
          : null;
      if (request !== null) {
        replaceDirectoryRequest(request);
        return;
      }
      const instanceId = createTerminalTab(target);
      if (instanceId !== null) focusTerminalInstance(instanceId);
      return;
    }
    const captured = pending ? target : capture();
    setPanelOpen(true);
    const request = directoryRequestFor(captured, "always-create", true);
    if (request !== null) {
      replaceDirectoryRequest(request);
      return;
    }
    const instanceId = createTerminalTab(captured);
    if (instanceId !== null) {
      focusTerminalInstance(instanceId);
      return;
    }
    // Refused for now - a host whose context has not reconciled yet has no
    // launch directory to spawn into. This chord asked for a terminal, so the
    // settlement finishes it; nothing else may.
    deferredCreateGenerationRef.current = captured.generation;
  }, [
    capture,
    createTerminalTab,
    panelOpen,
    pending,
    replaceDirectoryRequest,
    setPanelOpen,
    target,
  ]);

  const cancelDirectoryRequest = useCallback(() => {
    const request = directoryRequestRef.current;
    if (request === null) return;
    replaceDirectoryRequest(null);
    clearPending();
    if (request.closePanelOnCancel) {
      setPanelOpen(false);
      clearPendingTerminalFocus(null);
      focusActiveComposer();
      return;
    }
    requestPrimaryFocus({ kind: "landing-terminal-new-tab" });
  }, [clearPending, replaceDirectoryRequest, setPanelOpen]);

  const selectDirectory = useCallback(
    (workspacePath: string) => {
      const request = directoryRequestRef.current;
      if (request === null || request.selectedTarget !== null) return;
      const client = request.capturedTarget.client;
      if (
        client === null ||
        client.getActiveHostId() !== request.capturedTarget.hostId
      ) {
        replaceDirectoryRequest({
          ...request,
          error: "The selected host is no longer available.",
        });
        return;
      }
      const selectedTarget = selectWorkspacePath(workspacePath);
      if (selectedTarget === null) {
        replaceDirectoryRequest({
          ...request,
          error: "That directory is no longer attached.",
        });
        return;
      }
      replaceDirectoryRequest({
        ...request,
        selectedTarget,
        error: null,
      });
      requestDirectoryPickerFocus(request.key);
    },
    [replaceDirectoryRequest, requestDirectoryPickerFocus, selectWorkspacePath],
  );

  const handleReconciliationError = useCallback(() => {
    const request = directoryRequestRef.current;
    if (request === null || request.selectedTarget === null) return;
    const ownsFocus = hasPrimaryFocusIntent(
      (target) =>
        target.kind === "landing-terminal-directory" &&
        target.requestId === request.key,
    );
    writeDirectoryRequest({
      ...request,
      selectedTarget: null,
      error: "The terminal directory could not be opened.",
    });
    if (ownsFocus) {
      requestDirectoryPickerFocus(request.key);
    }
  }, [requestDirectoryPickerFocus, writeDirectoryRequest]);

  const activatePanelTab = useCallback(
    (instanceId: string) => {
      replaceDirectoryRequest(null);
      clearPending();
      activateTab(instanceId);
      // Neither the placeholder nor a browser tab has a terminal to hand the
      // keyboard to - the chooser and the browser tile take focus themselves -
      // and parking a terminal focus request against an instance id no terminal
      // will ever have would leave it pending for the rest of the session. So
      // the id is resolved through the terminal list rather than assumed: the
      // strip is mixed, and `activeInstanceId` is no longer always a terminal.
      const activated = activeLandingTerminalInstanceId(
        useLandingPanelStore.getState(),
      );
      if (activated === null) return;
      focusTerminalInstance(activated);
    },
    [activateTab, clearPending, replaceDirectoryRequest],
  );

  // Focus follows the open/collapse *transition*, never the mount: a landing
  // page that mounts with the panel already open (new tab, tab switch back)
  // must leave focus with the composer. Opening also arms the launch-cwd
  // intent that reconciliation consumes once the host's session list settles.
  const previousPanelLayoutRef = useRef({ landingPageId, panelOpen });
  useEffect(() => {
    const previous = previousPanelLayoutRef.current;
    previousPanelLayoutRef.current = { landingPageId, panelOpen };
    // An open panel holding nothing shows the CHOOSER. This is a CONDITION,
    // not an open-transition step, because the panel reaches that state by
    // several routes that are not `togglePanel`: the phone header's toggle
    // writes `setPanelOpen` on the store directly, a page can mount with a
    // persisted open layout, and a reconciliation pass can drop the last tab
    // without collapsing. It replaces the auto-spawn that used to fill the
    // same gap from reconciliation settlement.
    if (panelOpen) {
      const opening = useLandingPanelStore.getState();
      if (opening.tabs.length === 0 && opening.placeholder === null) {
        openPlaceholder(`landing-placeholder-${uuidv4()}`, 0);
      }
    }
    if (previous.landingPageId !== landingPageId) {
      clearPendingTerminalFocus(null);
      return;
    }
    const wasOpen = previous.panelOpen;
    if (wasOpen === panelOpen) return;
    if (panelOpen) {
      if (!pending) capture();
      // Only a terminal row can claim a terminal focus request. An open panel
      // whose active row is the chooser or a browser tab leaves the request
      // unsent - those surfaces focus themselves on mount.
      const openActiveInstanceId = activeLandingTerminalInstanceId(
        useLandingPanelStore.getState(),
      );
      if (
        openActiveInstanceId !== null &&
        directoryRequestRef.current === null
      ) {
        focusTerminalInstance(openActiveInstanceId);
      }
      return;
    }
    // Every collapse path converges on this store transition: the chord, the
    // header button, closing the last tab, close-all, and a shell exiting.
    // All of them should hand the keyboard back to the composer.
    clearPendingTerminalFocus(null);
    focusActiveComposer();
  }, [
    capture,
    landingPageId,
    openPlaceholder,
    panelOpen,
    pending,
    // The empty-panel condition above has to be re-checked when the tab count
    // moves, not only when the panel opens.
    tabs.length,
  ]);
  useEffect(
    () => () => {
      clearPendingTerminalFocus(null);
    },
    [],
  );

  // Runs after every settled reconciliation pass (the reconciliation key
  // includes the open/closed bit, so every panel-open transition lands here).
  // Empty panels auto-spawn at the resolved launch cwd (the routing target's
  // primary folder, else the settled context's home); a gesture-opened panel
  // additionally re-targets that cwd: reuse a terminal already running there,
  // otherwise spawn a fresh one, and focus it either way. The settled
  // generation's context is authoritative - not React state.
  const runReconciliationSettlement = useCallback(
    (generation: number, context: LandingTerminalHostContext) => {
      const state = useLandingPanelStore.getState();
      if (!landingPanelLayoutFor(state, targetLandingPageId).panelOpen) {
        replaceDirectoryRequest(null);
        if (pending) clearPending();
        return;
      }
      const request = directoryRequestRef.current;
      if (
        settleDirectoryRequest({
          request,
          generation,
          context,
          addTerminalTab,
          replaceDirectoryRequest,
          clearPending,
          ownsFocus: () =>
            request !== null &&
            hasPrimaryFocusIntent(
              (target) =>
                target.kind === "landing-terminal-directory" &&
                target.requestId === request.key,
            ),
        })
      ) {
        return;
      }
      // A settlement for a superseded generation must neither act nor clear the
      // newer pending gesture that replaced it.
      if (pending && pendingGeneration !== generation) return;
      // Any pending gesture now matches this settled generation and is consumed
      // exactly once. Clear it on EVERY outcome below (spawn, reuse, no-op) so a
      // later gesture projects live focus instead of this stale snapshot, and
      // `+`/workspace projection follow the newly focused draft after settling.
      const clearIfPending = (): void => {
        if (pending) clearPending();
        if (deferredCreateGenerationRef.current === generation) {
          deferredCreateGenerationRef.current = null;
        }
      };
      // Host may have switched after this generation began; never spawn with
      // a home path whose hostId no longer matches the routing target.
      if (target.hostId === null || context.hostId !== target.hostId) {
        clearIfPending();
        return;
      }
      const launchCwd = resolveLandingTerminalLaunchCwd(
        target.launchWorkspacePath,
        context,
        target.hostId,
      );
      if (launchCwd === null) {
        clearIfPending();
        return;
      }
      if (state.tabs.length === 0) {
        // An empty panel shows the CHOOSER, opened by whatever opened the panel
        // - it no longer auto-spawns a terminal here. That decision belonged to
        // a world with one kind of tab; with two, spawning one of them is
        // deciding for the user, which is exactly what the placeholder exists
        // to stop. The gesture is still consumed so a later one projects live
        // focus rather than this stale snapshot.
        clearIfPending();
        return;
      }
      if (!pending) return;
      // A strip with no TERMINAL row is being REVEALED, not added to. The
      // empty-panel branch above cannot cover this one: a browser-only strip is
      // not empty, so the chooser does not claim it, and reuse-or-create then
      // found nothing to reuse and spawned a shell the reader never asked for -
      // a state this feature created by making the strip mixed.
      //
      // `⇧⌘J` is exempt, because it asks for a terminal in as many words. It
      // reaches here only when it could not create synchronously (a host whose
      // context has not reconciled yet), which is exactly what the ref records.
      if (
        landingTerminalTabs(state.tabs).length === 0 &&
        deferredCreateGenerationRef.current !== generation
      ) {
        clearIfPending();
        return;
      }
      const existing = terminalForTarget(
        landingTerminalTabs(state.tabs),
        state.activeInstanceId,
        context.hostId,
        launchCwd,
      );
      if (existing === undefined) {
        // Creation can be refused (the host's authority went unready between
        // this generation's reconciliation and its settlement), so the focus
        // hand-off is conditional on a tab actually existing.
        const created = addTerminalTab(context.hostId, launchCwd);
        if (created !== null) focusTerminalInstance(created);
        clearIfPending();
        return;
      }
      if (existing.instanceId !== state.activeInstanceId) {
        state.activateTab(existing.instanceId);
      }
      focusTerminalInstance(existing.instanceId);
      clearIfPending();
    },
    [
      addTerminalTab,
      clearPending,
      pending,
      pendingGeneration,
      replaceDirectoryRequest,
      target,
      targetLandingPageId,
    ],
  );

  // Settlement is the panel's other outward-facing act, and it must gate on
  // surface activity for the same reason the chords do. Before the panel
  // outlived its page's activation, a tab switch UNMOUNTED it and aborted the
  // in-flight pass; now the pass survives, so an `open -> switch away ->
  // settle` sequence would auto-spawn a terminal into a `display:none` pane
  // (which cannot be measured, so it lands at the 80x24 fallback grid) and pull
  // the keyboard out of whatever the user switched to.
  //
  // Held rather than dropped: the reconciliation key does not change on the way
  // back, so a discarded settlement would never be recomputed and a panel
  // opened just before the switch would sit empty forever. The newest
  // settlement wins - an older one is superseded, which is what the generation
  // and host-identity guards inside the body already check for.
  const surfaceActive = useLandingTerminalSurfaceActive();
  const deferredSettlementRef = useRef<{
    readonly generation: number;
    readonly context: LandingTerminalHostContext;
  } | null>(null);
  const handleReconciliationSettled = useCallback(
    (generation: number, context: LandingTerminalHostContext) => {
      if (!surfaceActive) {
        deferredSettlementRef.current = { generation, context };
        return;
      }
      runReconciliationSettlement(generation, context);
    },
    [runReconciliationSettlement, surfaceActive],
  );
  useEffect(() => {
    if (!surfaceActive) return;
    const deferred = deferredSettlementRef.current;
    if (deferred === null) return;
    deferredSettlementRef.current = null;
    runReconciliationSettlement(deferred.generation, deferred.context);
  }, [runReconciliationSettlement, surfaceActive]);

  useLandingTerminalReconciliation({
    activeHostId: target.hostId,
    availability: target.availability,
    panelOpen: targetPanelOpen,
    primaryWorkspacePath: target.launchWorkspacePath,
    generation: target.generation,
    client: target.client,
    plainAuthority: targetAuthority,
    killTerminal: killTerminalAsync,
    onReconciled: setReconciledContext,
    onError: handleReconciliationError,
    onSettled: handleReconciliationSettled,
  });

  // Renaming a TERMINAL is a live mutation with no durable fallback - only the
  // host can record a manual title - so its affordance gates on that host's
  // authority being ready, and the gate and the action stay one predicate.
  // Close is deliberately NOT here: it is tombstone-first, so it stays
  // available for a host that cannot be asked right now.
  const canRenameTab = useCallback(
    (tab: LandingPanelTabRef): boolean =>
      // A browser tab's title is the panel's own - the store records it as
      // `manual` and nothing on the host has to agree - so it renames whatever
      // the device is doing.
      tab.kind === "browser" ||
      landingTerminalAuthorityReady(authorityEntries[tab.hostId]),
    [authorityEntries],
  );

  // Closing always removes the tab and records its tombstone, whatever the
  // bound host's authority looks like - a tab bound to an offline host is
  // closable, and its shell is killed when that host comes back. The terminal
  // dispatch is the fast path only; `dispatchLandingTerminalClose` documents
  // who carries the kill otherwise. A browser tab has no dispatch here.
  const closePanelTab = useCallback(
    (tab: LandingPanelTabRef) => {
      replaceDirectoryRequest(null);
      clearPending();
      const authorityEntry = authorityEntries[tab.hostId];
      const closed = closeTab(landingPageId, tab.instanceId);
      if (closed === null) return;
      // Routed by the CLOSED ref's kind, not the argument's. They agree, but
      // the store is the one that decided what was removed. A browser tab needs
      // no arm here at all - the tombstone the store just wrote is the whole
      // request, and the drain is its only sender.
      if (isLandingTerminalTab(closed)) {
        dispatchLandingTerminalClose({
          entry: authorityEntry,
          closed,
          killTerminal: killTerminalAsync,
        });
      }
      // Closing a non-last tab promotes a surviving neighbor - keep the
      // keyboard with the panel. The promoted neighbour need not be a terminal
      // in a mixed strip, and only a terminal can claim the request, so the
      // browser/chooser case falls through to the composer.
      // The last-tab case collapses the panel, and the open-transition effect
      // hands focus back to the composer instead.
      const state = useLandingPanelStore.getState();
      const promoted = activeLandingTerminalInstanceId(state);
      if (
        landingPanelLayoutFor(state, landingPageId).panelOpen &&
        promoted !== null
      ) {
        focusTerminalInstance(promoted);
      } else {
        clearPendingTerminalFocus(tab.instanceId);
        focusActiveComposer();
      }
    },
    [
      clearPending,
      closeTab,
      authorityEntries,
      killTerminalAsync,
      landingPageId,
      replaceDirectoryRequest,
    ],
  );

  const closeAllPanelTabs = useCallback(() => {
    // Every tab closes - "Close All" means all of them, both kinds, including
    // tabs whose device cannot be asked yet, whose closes the recovery bridge
    // drains later.
    //
    // This replays a single close per tab, so the durability ordering is
    // per-tab: each tombstone is written with its own tab's removal, then that
    // tab's kill dispatches. An interruption mid-loop therefore leaves every
    // tab either untouched or tombstoned, never removed without a tombstone -
    // which is the invariant that matters, and it keeps focus handling and the
    // terminal dispatch in one place instead of duplicating them per tab.
    // Routing is per tab inside `closePanelTab`, so a mixed list needs no
    // partition here.
    replaceDirectoryRequest(null);
    clearPending();
    useLandingPanelStore.getState().tabs.forEach(closePanelTab);
    // An unpicked placeholder is a strip row like any other, so "Close All"
    // takes it too - otherwise the panel would stay open holding nothing but
    // the chooser the user just asked to be rid of.
    dismissPlaceholder();
    clearPendingTerminalFocus(null);
    focusActiveComposer();
  }, [
    clearPending,
    closePanelTab,
    dismissPlaceholder,
    replaceDirectoryRequest,
  ]);

  /**
   * Open the "New tab" placeholder and show the chooser in it.
   *
   * Reveals the panel first when it is collapsed, and focuses an existing
   * placeholder rather than adding a second - only one exists at a time.
   */
  const openNewTabPlaceholder = useCallback(() => {
    if (!panelOpen) setPanelOpen(true);
    const state = useLandingPanelStore.getState();
    openPlaceholder(`landing-placeholder-${uuidv4()}`, state.tabs.length);
  }, [openPlaceholder, panelOpen, setPanelOpen]);

  const togglePanel = useCallback(() => {
    if (panelOpen) {
      setMaximized(false);
      replaceDirectoryRequest(null);
      clearPending();
      setPanelOpen(false);
      clearPendingTerminalFocus(null);
      focusActiveComposer();
      return;
    }
    const state = useLandingPanelStore.getState();
    if (state.tabs.length === 0 && state.placeholder === null) {
      // An empty panel raises no directory request: which folder to launch in
      // is a question only the Terminal card asks, and asking it before the
      // user has said "terminal" decides for them. The chooser itself is
      // opened by the open-transition effect, which every opener reaches.
      setPanelOpen(true);
      return;
    }
    const captured = capture();
    const request = directoryRequestFor(captured, "reuse-or-create", true);
    replaceDirectoryRequest(request);
    setPanelOpen(true);
    if (request === null) {
      // Same rule as every other hand-off in this file: only a terminal row
      // can claim a terminal focus request, and this one is EAGER - a
      // settlement that never arrives (an offline host) would leave an intent
      // parked against a browser tab for the rest of the session.
      const instanceId = activeLandingTerminalInstanceId(
        useLandingPanelStore.getState(),
      );
      if (instanceId !== null) focusTerminalInstance(instanceId);
    }
  }, [
    capture,
    clearPending,
    panelOpen,
    replaceDirectoryRequest,
    setMaximized,
    setPanelOpen,
  ]);

  const openPanel = useCallback(() => {
    if (panelOpen) return;
    togglePanel();
  }, [panelOpen, togglePanel]);

  // Whether this SHELL can drive a browser tab, which is what decides whether
  // the tile it opens is controllable or a "View only" screencast. It is the
  // shell's own capability and not the device's, so a desktop looking at a
  // remote host still qualifies - that tab's pixels stream, but its input does
  // too.
  const canDriveBrowserTabs =
    screencastRoleForShell(useRunnerHostOrNull()) === "tile";

  const browserOpenTab = useLandingBrowserOpenTab({
    canDriveTabs: canDriveBrowserTabs,
    hostId: target.hostId,
    sessions:
      target.hostId === null ? null : (browserSessions[target.hostId] ?? null),
    // Same rule as the terminal arm: replace the placeholder it was picked from
    // in that row's own strip position, and append when that row is gone.
    // The row is read off the REQUEST, so an answer can only ever act on the
    // row its own ask was made from - two devices can be answering at once,
    // and the first back must not consume the other's association.
    onOpened: (tab, request) => {
      fulfillPlaceholder(tab, request.placeholderInstanceId);
    },
  });
  const openBrowserTab = browserOpenTab.open;
  // Reveal for a BROWSER open. Deliberately not `openPanel`: that opens the
  // chooser on an empty panel, and this gesture has already answered the very
  // question the chooser asks.
  const revealAndOpenBrowserTab = useCallback(() => {
    if (!panelOpen) setPanelOpen(true);
    // No row: the chord answers the chooser's question without being asked it.
    openBrowserTab({ placeholderInstanceId: null });
  }, [openBrowserTab, panelOpen, setPanelOpen]);

  // A link the page asked to open in a new tab, on the raising tab's device
  // and through the same serializing scope the chooser's opener uses. The
  // openers are what dispatch the queue, so they have to be rendered.
  const { open: openBrowserLink, openers: browserLinkOpeners } =
    useLandingBrowserOpenLink({ browserSessions });

  // The TERMINAL card's gate, reading the effective target only: capability
  // from the captured host, fail-closed on an unpinned client, and the
  // reconciled launch context. It no longer gates the strip's "+", which opens
  // the chooser: a device that cannot start a terminal can still open a
  // browser, so the refusal belongs on the card it is about.
  const { createEnabled, createDisabledReason } = landingTerminalCreateGate({
    panelOpen,
    availability: target.availability,
    hostId: target.hostId,
    primaryWorkspacePath: target.primaryWorkspacePath,
    clientReady: target.client !== null,
    reconciledContext,
    authority: targetAuthority,
  });

  /**
   * The Browser card's gate, which is only ever the cap or the device not
   * having spoken. Everything else the browser needs, it can wait for.
   */
  const browserDisabledReason = useMemo((): string | null => {
    const count = browserOpenTab.tabCount;
    // First, and above the device's own terms: a shell that can only watch is
    // refused whatever the device says, and saying "connecting" there would be
    // a wait that resolves into a card the reader still cannot use.
    if (!canDriveBrowserTabs) return landingBrowserViewerMessage();
    if (count === null) return LANDING_PANEL_CONNECTING_MESSAGE;
    return count >= LANDING_BROWSER_TAB_CAP ? landingBrowserCapMessage() : null;
  }, [browserOpenTab.tabCount, canDriveBrowserTabs]);

  const pickNewTabKind = useCallback(
    (kind: LandingNewTabKind): void => {
      if (kind === "browser") {
        // The row the pick was made from, carried with the ask. A later pick -
        // the other card, or a chord - can take this row while the device is
        // answering, and that later choice is the one the reader is looking at.
        openBrowserTab({
          placeholderInstanceId:
            useLandingPanelStore.getState().placeholder?.instanceId ?? null,
        });
        return;
      }
      // The existing terminal create flow, directory picker and all. It
      // fulfills the placeholder itself through `addTerminalTab`, including
      // after a picker round trip.
      revealAndCreateTerminal();
    },
    [openBrowserTab, revealAndCreateTerminal],
  );

  const visibleDirectoryRequest = useMemo(() => {
    if (!panelOpen || directoryRequest === null) return null;
    return {
      ...directoryRequest,
      workspacePaths: workspace.folders,
      primaryWorkspacePath:
        workspace.primaryWorkspacePath ??
        (workspace.folders.length === 0 ? "" : workspace.folders[0]),
    };
  }, [
    directoryRequest,
    panelOpen,
    workspace.folders,
    workspace.primaryWorkspacePath,
  ]);

  const terminalViewModels = useMemo<
    Readonly<Partial<Record<string, PlainTerminalViewModel>>>
  >(() => {
    const viewModels: Partial<Record<string, PlainTerminalViewModel>> = {};
    for (const tab of terminalTabs) {
      const projection = getPlainTerminal(
        authorityEntries[tab.hostId]?.authority.collection,
        tab.hostId,
        tab.sessionId,
      );
      if (projection !== undefined) {
        viewModels[tab.instanceId] = selectPlainTerminalViewModel(projection);
      }
    }
    return viewModels;
  }, [authorityEntries, terminalTabs]);

  const browserViewModels = useMemo<
    Readonly<Partial<Record<string, LandingBrowserViewModel>>>
  >(() => {
    const viewModels: Partial<Record<string, LandingBrowserViewModel>> = {};
    for (const tab of browserTabs) {
      viewModels[tab.instanceId] = selectLandingBrowserViewModel({
        tab,
        sessions: browserSessions[tab.hostId] ?? null,
      });
    }
    return viewModels;
  }, [browserSessions, browserTabs]);

  // Several remote hosts can exist without a default selection. This is a
  // real page state, not an unsupported/unknown verdict: leave persistence
  // untouched and render no terminal affordance until one is selected. Read the
  // captured verdict so a mid-gesture switch to an unsupported host cannot
  // unmount the panel (and destroy the captured host's reconciliation).
  const panelUnavailable =
    target.availability === "no-active-host" ||
    target.availability === "unsupported";

  const renamePanelTab = (instanceId: string, name: string): void => {
    const tab = useLandingPanelStore
      .getState()
      .tabs.find((entry) => entry.instanceId === instanceId);
    if (tab === undefined) return;
    // A browser tab has no host-side title to record, so the store IS the
    // record; `renameTab` marks it manual and the reconciler leaves it alone.
    if (tab.kind === "browser") {
      renameTab(instanceId, name);
      return;
    }
    const entry = authorityEntries[tab.hostId];
    if (!landingTerminalAuthorityReady(entry)) return;
    if (entry.authority.capability.status === "legacy") {
      renameTab(instanceId, name);
      return;
    }
    entry.mutations.rename.mutate({
      hostId: tab.hostId,
      terminalId: tab.sessionId,
      manualTitle: name.trim(),
    });
  };

  return (
    <>
      <LandingTerminalAuthorityFleet
        hostIds={authorityHostIds}
        browserHostIds={browserHostIds}
        // The panel owns the browser slice; the always-mounted tombstone bridge
        // shares the same coordinators and only reports.
        browserArm="reconcile"
        onEntry={handleAuthorityEntry}
        onBrowserSessions={handleBrowserSessions}
      />
      <LandingTerminalBoundHostReconciliationFleet
        landingPageId={landingPageId}
        selectedHostId={target.hostId}
        entries={authorityEntries}
      />
      {/* Outside the availability gate: an ask already queued is one the page
          raised, and losing it because the panel's target went unavailable
          would drop a popup rather than let it refuse and say so. */}
      {browserLinkOpeners}
      {panelUnavailable ? null : (
        <LandingTerminalPanelContents
          landingPageId={landingPageId}
          tabs={tabs}
          placeholder={placeholder}
          activeInstanceId={activeInstanceId}
          availability={target.availability}
          panelOpen={panelOpen}
          panelWidthFraction={panelWidthFraction}
          primaryWorkspacePath={target.primaryWorkspacePath}
          activeHostId={target.hostId}
          createEnabled={createEnabled}
          createDisabledReason={createDisabledReason}
          reconciledContext={reconciledContext}
          maximized={layout.maximized}
          directoryPicker={visibleDirectoryRequest}
          onTogglePanel={togglePanel}
          onOpenPanel={openPanel}
          onToggleMaximized={() => setMaximized(!layout.maximized)}
          onSetPanelWidthFraction={setPanelWidthFraction}
          onOpenNewTab={openNewTabPlaceholder}
          onRevealAndCreate={revealAndCreateTerminal}
          onPickNewTabKind={pickNewTabKind}
          onDismissPlaceholder={dismissPlaceholder}
          browserDisabledReason={browserDisabledReason}
          browserOpening={browserOpenTab.isOpening}
          onSelectDirectory={selectDirectory}
          onCancelDirectoryPicker={cancelDirectoryRequest}
          onActivateTab={activatePanelTab}
          onCloseTab={closePanelTab}
          onCloseAllTabs={closeAllPanelTabs}
          onRenameTab={renamePanelTab}
          canRenameTab={canRenameTab}
          onRevealAndOpenBrowserTab={revealAndOpenBrowserTab}
          onOpenBrowserLink={openBrowserLink}
          authorityEntries={authorityEntries}
          terminalViewModels={terminalViewModels}
          browserViewModels={browserViewModels}
        />
      )}
    </>
  );
}

interface LandingTerminalPanelContentsProps {
  readonly landingPageId: string;
  readonly tabs: ReadonlyArray<LandingPanelTabRef>;
  readonly placeholder: LandingPanelPlaceholder | null;
  readonly activeInstanceId: string | null;
  readonly availability: LandingTerminalAvailability;
  readonly panelOpen: boolean;
  readonly panelWidthFraction: number;
  readonly primaryWorkspacePath: string | null;
  readonly activeHostId: string | null;
  readonly createEnabled: boolean;
  readonly createDisabledReason: string | null;
  readonly reconciledContext: LandingTerminalHostContext | null;
  readonly maximized: boolean;
  readonly directoryPicker: LandingTerminalDirectoryRequest | null;
  readonly onTogglePanel: () => void;
  readonly onOpenPanel: () => void;
  readonly onToggleMaximized: () => void;
  readonly onSetPanelWidthFraction: (fraction: number) => void;
  /** The "+", the empty-strip double-click and `tab.new`: open the chooser. */
  readonly onOpenNewTab: () => void;
  readonly onRevealAndCreate: () => void;
  readonly onPickNewTabKind: (kind: LandingNewTabKind) => void;
  readonly onDismissPlaceholder: () => void;
  /** Why the chooser's Browser card cannot be picked, or `null`. */
  readonly browserDisabledReason: string | null;
  /** A browser tab has been asked for on this device and is on its way. */
  readonly browserOpening: boolean;
  readonly onSelectDirectory: (workspacePath: string) => void;
  readonly onCancelDirectoryPicker: () => void;
  readonly onActivateTab: (instanceId: string) => void;
  readonly onCloseTab: (tab: LandingPanelTabRef) => void;
  readonly onCloseAllTabs: () => void;
  readonly onRenameTab: (instanceId: string, name: string) => void;
  readonly canRenameTab: (tab: LandingPanelTabRef) => boolean;
  /** The `app.browser.new` chord: reveals the panel first if it is collapsed. */
  readonly onRevealAndOpenBrowserTab: () => void;
  readonly onOpenBrowserLink: (
    tab: LandingBrowserTabRef,
    url: string,
    disposition: "foreground" | "background",
  ) => void;
  readonly authorityEntries: LandingTerminalAuthorityEntries;
  readonly terminalViewModels: Readonly<
    Partial<Record<string, PlainTerminalViewModel>>
  >;
  readonly browserViewModels: Readonly<
    Partial<Record<string, LandingBrowserViewModel>>
  >;
}

function LandingTerminalPanelContents(
  props: LandingTerminalPanelContentsProps,
): ReactNode {
  const panelRef = useRef<HTMLElement | null>(null);
  const scheduleTerminalLayoutReconcile = useLandingTerminalLayoutReconcile({
    panelOpen: props.panelOpen,
    activeInstanceId: props.activeInstanceId,
  });
  const { sliderProps, isDragging } = useLandingTerminalPanelResize({
    panelWidthFraction: props.panelWidthFraction,
    setPanelWidthFraction: props.onSetPanelWidthFraction,
    onLayoutSettled: scheduleTerminalLayoutReconcile,
  });
  // Below the mobile breakpoint a side-by-side split leaves both halves
  // unusably narrow and the drag handle has no pointer to serve, so an open
  // panel always renders through the maximized full-overlay path instead.
  // The overlay geometry applies only while actually open: a closed panel
  // physically collapses to the 0%-width in-flow strip on every device
  // rather than lingering as an invisible full-viewport layer.
  const isMobile = useIsMobileViewport();
  const fullOverlay = props.maximized || isMobile;
  const overlayActive = fullOverlay && props.panelOpen;
  // Same touch-key treatment as the epic terminal tiles: at phone width the
  // open panel is a full overlay, so the key bar mounts under the body and
  // the keyboard inset pads the covered strip (0 wherever the platform
  // resizes the layout itself). Desktop keeps its physical keyboard.
  const keyboardInset = useVirtualKeyboardInset();
  // Under the installed app's native-resize keyboard mode the measured inset
  // stays 0 while the keyboard is up; the plugin-fed native state is the live
  // signal there (drives the key bar's padding, not the overlay geometry).
  const nativeKeyboardOpen = useNativeKeyboardOpen();
  // The key bar sends terminal chords to `instanceId`, so it belongs to a
  // TERMINAL row and not merely to an open panel: over a browser tab or the
  // chooser its keys would have nowhere to land, and it would sit on the phone
  // covering the surface the user is actually reading.
  const keyBarInstanceId = activeLandingTerminalInstanceId({
    tabs: props.tabs,
    activeInstanceId: props.activeInstanceId,
  });
  const keyBarActive = isMobile && props.panelOpen && keyBarInstanceId !== null;
  useLandingTerminalShortcuts({
    landingPageId: props.landingPageId,
    panelOpen: props.panelOpen,
    maximized: props.maximized,
    onTogglePanel: props.onTogglePanel,
    onOpenPanel: props.onOpenPanel,
    onRevealAndCreate: props.onRevealAndCreate,
    onRevealAndOpenBrowserTab: props.onRevealAndOpenBrowserTab,
    onOpenNewTab: props.onOpenNewTab,
    onDismissPlaceholder: props.onDismissPlaceholder,
    onToggleMaximized: props.onToggleMaximized,
    onActivateTab: props.onActivateTab,
    onCloseTab: props.onCloseTab,
    onCloseAllTabs: props.onCloseAllTabs,
  });
  const panelStyle = landingTerminalPanelStyle({
    overlayActive,
    panelOpen: props.panelOpen,
    panelWidthFraction: props.panelWidthFraction,
    // Browser-only, like the epic tile view's padding: the installed app's
    // shell already subtracts `--keyboard-inset` in its safe-height tokens,
    // so the measured inset would double the lift there.
    keyboardInsetPx: keyBarActive && !isMobileApp() ? keyboardInset : 0,
  });
  const handlePanelTransitionEnd = useCallback(
    (event: ReactTransitionEvent<HTMLElement>): void => {
      if (event.target !== event.currentTarget) return;
      if (event.propertyName !== "width") return;
      if (!props.panelOpen) return;
      scheduleTerminalLayoutReconcile();
    },
    [props.panelOpen, scheduleTerminalLayoutReconcile],
  );
  const handlePanelTransitionCancel = useCallback(
    (event: TransitionEvent): void => {
      if (event.target !== panelRef.current) return;
      if (event.propertyName !== "width") return;
      if (!props.panelOpen || isDragging()) return;
      scheduleTerminalLayoutReconcile();
    },
    [isDragging, props.panelOpen, scheduleTerminalLayoutReconcile],
  );
  const revealToggle = props.panelOpen ? null : (
    <LandingTerminalPanelToggle onOpenPanel={props.onOpenPanel} />
  );
  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;
    panel.addEventListener("transitioncancel", handlePanelTransitionCancel);
    return () => {
      panel.removeEventListener(
        "transitioncancel",
        handlePanelTransitionCancel,
      );
    };
  }, [handlePanelTransitionCancel]);

  useLayoutEffect(() => {
    if (props.panelOpen) reconcilePrimaryFocus();
  }, [props.activeInstanceId, props.directoryPicker, props.panelOpen]);

  return (
    <>
      {/* Reveal-only affordance. Once open, the panel header owns collapse -
          rendering both would stack two controls in the same corner. On a phone
          it lives in the header's route-actions slot instead of floating in the
          content area, where it was the only element in an otherwise empty
          region with nothing to align to. */}
      {isMobile ? (
        <MobileLandingTerminalActionBinder
          landingPageId={props.landingPageId}
        />
      ) : (
        revealToggle
      )}
      <div
        {...sliderProps}
        aria-valuenow={Math.round(props.panelWidthFraction * 100)}
        aria-valuemin={Math.round(MIN_LANDING_PANEL_WIDTH_FRACTION * 100)}
        aria-valuemax={Math.round(MAX_LANDING_PANEL_WIDTH_FRACTION * 100)}
        aria-label="Resize panel"
        data-testid="landing-terminal-resize-handle"
        className={cn(
          "relative z-10 shrink-0 bg-background ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden",
          pointerDragHandleAxisClassName("horizontal"),
          (!props.panelOpen || fullOverlay) && "invisible pointer-events-none",
        )}
      />
      <aside
        ref={panelRef}
        data-landing-terminal-panel
        data-testid="landing-terminal-panel"
        data-open={props.panelOpen ? "true" : "false"}
        className={cn(
          "flex h-full min-h-0 shrink-0 flex-col overflow-hidden",
          landingTerminalPanelSurfaceClass(isMobile),
          // The width transition exists for open/collapse only. During a
          // resize drag the global freeze class suspends it - otherwise every
          // per-frame `style.width` write eases over the default duration and
          // the panel rubber-bands behind the pointer.
          "[.traycer-panel-resizing_&]:transition-none",
          props.panelOpen
            ? "transition-[width]"
            : "invisible pointer-events-none transition-[width,visibility]",
          overlayActive && "absolute inset-0 z-20 w-full",
        )}
        style={panelStyle}
        onTransitionEnd={handlePanelTransitionEnd}
      >
        <LandingTerminalPanelHeader
          isMobile={isMobile}
          maximized={props.maximized}
          onToggleMaximized={props.onToggleMaximized}
          onTogglePanel={props.onTogglePanel}
        />
        <LandingTerminalTabStrip
          tabs={props.tabs}
          placeholder={props.placeholder}
          activeInstanceId={
            props.directoryPicker === null ? props.activeInstanceId : null
          }
          addTooltip={LANDING_NEW_TAB_TOOLTIP}
          onAdd={props.onOpenNewTab}
          onActivate={props.onActivateTab}
          onClose={props.onCloseTab}
          onDismissPlaceholder={props.onDismissPlaceholder}
          onCloseAll={props.onCloseAllTabs}
          onRename={props.onRenameTab}
          canRename={props.canRenameTab}
          terminalViewModels={props.terminalViewModels}
          browserViewModels={props.browserViewModels}
        />
        <LandingTerminalPanelBody
          landingPageId={props.landingPageId}
          tabs={props.tabs}
          placeholder={props.placeholder}
          activeInstanceId={props.activeInstanceId}
          availability={props.availability}
          panelOpen={props.panelOpen}
          activeHostId={props.activeHostId}
          createEnabled={props.createEnabled}
          createDisabledReason={props.createDisabledReason}
          browserDisabledReason={props.browserDisabledReason}
          browserOpening={props.browserOpening}
          primaryWorkspacePath={props.primaryWorkspacePath}
          reconciledContext={props.reconciledContext}
          directoryPicker={props.directoryPicker}
          onSelectDirectory={props.onSelectDirectory}
          onCancelDirectoryPicker={props.onCancelDirectoryPicker}
          authorityEntries={props.authorityEntries}
          onCloseTab={props.onCloseTab}
          onOpenNewTab={props.onOpenNewTab}
          onOpenBrowserLink={props.onOpenBrowserLink}
          onPickNewTabKind={props.onPickNewTabKind}
          onDismissPlaceholder={props.onDismissPlaceholder}
        />
        <LandingTerminalMobileKeyBar
          active={keyBarActive}
          instanceId={keyBarInstanceId}
          keyboardOpen={keyboardInset > 0 || nativeKeyboardOpen}
        />
      </aside>
    </>
  );
}

/**
 * In-flow width for the docked split; in overlay mode (maximized / mobile)
 * the panel is absolutely positioned instead, and at phone width the measured
 * keyboard inset pads the covered strip so the key bar rides above the soft
 * keyboard (0 wherever the platform resizes the layout itself).
 */
function landingTerminalPanelStyle(args: {
  readonly overlayActive: boolean;
  readonly panelOpen: boolean;
  readonly panelWidthFraction: number;
  readonly keyboardInsetPx: number;
}): CSSProperties | undefined {
  if (!args.overlayActive) {
    return {
      width: args.panelOpen ? `${args.panelWidthFraction * 100}%` : "0%",
    };
  }
  if (args.keyboardInsetPx > 0) return { paddingBottom: args.keyboardInsetPx };
  return undefined;
}

interface LandingTerminalMobileKeyBarProps {
  readonly active: boolean;
  readonly instanceId: string | null;
  readonly keyboardOpen: boolean;
}

function LandingTerminalMobileKeyBar(
  props: LandingTerminalMobileKeyBarProps,
): ReactNode {
  if (!props.active || props.instanceId === null) return null;
  return (
    <MobileTerminalKeyBar
      instanceId={props.instanceId}
      keyboardOpen={props.keyboardOpen}
    />
  );
}

/**
 * Why the strip's "+" is unavailable (surfaced as its tooltip), `null` when
 * creating is live. Mirrors the empty-state copy so the strip explains itself
 * even when tabs are already open (e.g. the last folder was removed after the
 * terminals were spawned and the host cannot report a home directory).
 * `clientReady` is false when the host client cannot be pinned (fail-closed):
 * the action stays disabled rather than falling back to the live default
 * client.
 */
function landingTerminalCreateDisabledReason(args: {
  readonly availability: LandingTerminalAvailability;
  readonly primaryWorkspacePath: string | null;
  readonly clientReady: boolean;
  readonly activeHostId: string | null;
  readonly reconciledContext: LandingTerminalHostContext | null;
  readonly authority: LandingTerminalAuthorityEntry | null;
}): string | null {
  if (!args.clientReady) return LANDING_PANEL_CONNECTING_MESSAGE;
  if (args.availability !== "supported") {
    return LANDING_PANEL_CONNECTING_MESSAGE;
  }
  // Same predicate `addTerminalTab` enforces, so the "+" cannot look live for
  // a host whose authority would refuse the create.
  if (!landingTerminalAuthorityReady(args.authority)) {
    return LANDING_PANEL_CONNECTING_MESSAGE;
  }
  if (args.primaryWorkspacePath !== null) return null;
  if (
    args.reconciledContext === null ||
    args.activeHostId === null ||
    args.reconciledContext.hostId !== args.activeHostId
  ) {
    return LANDING_PANEL_CONNECTING_MESSAGE;
  }
  if (args.reconciledContext.homeCwd === null) {
    return LANDING_TERMINAL_HOST_UPDATE_GUIDANCE;
  }
  return null;
}

/**
 * The create gate, resolved once from either the captured opening-gesture
 * snapshot or live focus (the caller decides which by passing the effective
 * values). `createEnabled` drives the terminal tiles; `createDisabledReason`
 * drives the `+` button's disabled state and tooltip. Both stay in lockstep so
 * a fail-closed client or an unsupported host disables the action either way.
 */
function landingTerminalCreateGate(args: {
  readonly panelOpen: boolean;
  readonly availability: LandingTerminalAvailability;
  readonly hostId: string | null;
  readonly primaryWorkspacePath: string | null;
  readonly clientReady: boolean;
  readonly reconciledContext: LandingTerminalHostContext | null;
  readonly authority: LandingTerminalAuthorityEntry | null;
}): {
  readonly createEnabled: boolean;
  readonly createDisabledReason: string | null;
} {
  const createDisabledReason = landingTerminalCreateDisabledReason({
    availability: args.availability,
    primaryWorkspacePath: args.primaryWorkspacePath,
    clientReady: args.clientReady,
    activeHostId: args.hostId,
    reconciledContext: args.reconciledContext,
    authority: args.authority,
  });
  // Derived from the reason rather than restated, so the two cannot drift.
  // They previously did: a captured workspace path makes the reason `null`
  // (the launch cwd is that folder, so no reconciled `homeCwd` is needed),
  // while this condition still demanded a reconciled context matching the
  // captured host - leaving the "+" enabled with its tooltip clear but the
  // tiles' create affordance shut.
  const createEnabled =
    args.panelOpen && args.hostId !== null && createDisabledReason === null;
  return { createEnabled, createDisabledReason };
}

/**
 * The system-tab modal (Settings / History) is transparent to chord dispatch
 * (it hosts its own leader scope), so the terminal tab shortcuts gate
 * themselves at dispatch time: acting on tabs the modal fully occludes would
 * be invisible. The epic canvas handlers for the same chords no-op while the
 * overlay is open for the same reason.
 */
function systemTabOverlayActive(): boolean {
  const api = getSystemTabModalApi();
  if (api === null) return false;
  return api.isOverlayActive("settings") || api.isOverlayActive("history");
}

/**
 * Binds the panel's chords. Registered here (not in `LandingTerminalPanel`)
 * so they exist exactly while the panel is a real affordance: an unsupported
 * host or no selected host renders nothing, and the chords must not silently
 * flip persisted panel state behind an invisible surface.
 *
 * Beyond the panel-chrome chords (`app.terminal.*`), the hook claims the
 * epic canvas's tab-family actions - `tab.new`, `tab.close`, `tab.close-all`,
 * `tab.next`/`tab.prev`, and `mod`-digit switching - so the terminal strip
 * answers the same chords a canvas group's tab strip does. Those actions'
 * static handlers all no-op on the landing route, so the dynamic
 * registrations shadow nothing.
 */
function useLandingTerminalShortcuts(args: {
  readonly landingPageId: string;
  readonly panelOpen: boolean;
  readonly maximized: boolean;
  readonly onTogglePanel: () => void;
  readonly onOpenPanel: () => void;
  readonly onRevealAndCreate: () => void;
  readonly onToggleMaximized: () => void;
  readonly onActivateTab: (instanceId: string) => void;
  readonly onCloseTab: (tab: LandingPanelTabRef) => void;
  readonly onCloseAllTabs: () => void;
  readonly onRevealAndOpenBrowserTab: () => void;
  readonly onOpenNewTab: () => void;
  readonly onDismissPlaceholder: () => void;
}): void {
  const {
    landingPageId,
    panelOpen,
    maximized,
    onTogglePanel,
    onOpenPanel,
    onRevealAndCreate,
    onRevealAndOpenBrowserTab,
    onOpenNewTab,
    onDismissPlaceholder,
    onToggleMaximized,
    onActivateTab,
    onCloseTab,
    onCloseAllTabs,
  } = args;
  // The panel now outlives its start page's ACTIVATION (it stays mounted while
  // the page is merely retained, so terminals survive a header-tab switch), but
  // these registrations must not. `dispatchAction` hands a registered dynamic
  // handler absolute precedence over the static one and reports the chord as
  // handled, so a backgrounded panel that kept its slots would not just answer
  // the epic canvas's `tab.*` chords - it would SWALLOW them. Skipping the
  // registration (rather than no-oping inside the handler) is what lets the
  // static canvas handler run.
  const surfaceActive = useLandingTerminalSurfaceActive();
  useEffect(() => {
    if (!surfaceActive) return;
    return registerDynamicActionHandler("app.terminal.toggle", onTogglePanel);
  }, [onTogglePanel, surfaceActive]);
  // Reveal-and-create is one gesture in the panel: a collapsed panel captures
  // the open gesture and creates from that captured snapshot up-front (the
  // non-empty set suppresses reconciliation's auto-spawn), while an open panel
  // is just a `+`. It self-gates, so this is safe while the host is connecting.
  useEffect(() => {
    if (!surfaceActive) return;
    return registerDynamicActionHandler("app.terminal.new", onRevealAndCreate);
  }, [onRevealAndCreate, surfaceActive]);
  // The browser twin of the chord above. It self-gates on the device's
  // coordinator being live, so it is safe to register while one is connecting.
  useEffect(() => {
    if (!surfaceActive) return;
    return registerDynamicActionHandler(
      "app.browser.new",
      onRevealAndOpenBrowserTab,
    );
  }, [onRevealAndOpenBrowserTab, surfaceActive]);
  // `tab.new` (the ⌘T family) asks for a NEW TAB, which is now a question
  // rather than a terminal: it opens the chooser. `app.terminal.new` above is
  // the direct chord that still bypasses it.
  useEffect(() => {
    if (!surfaceActive) return;
    return registerDynamicActionHandler("tab.new", () => {
      if (systemTabOverlayActive()) return;
      onOpenNewTab();
    });
  }, [onOpenNewTab, surfaceActive]);
  useEffect(() => {
    if (!surfaceActive) return;
    return registerDynamicActionHandler("app.terminal.maximize", () => {
      if (!panelOpen) {
        // Revealing an already-maximized panel (possible when the last tab
        // closed while maximized) must not un-maximize it.
        onOpenPanel();
        if (!maximized) onToggleMaximized();
        return;
      }
      onToggleMaximized();
    });
  }, [maximized, onOpenPanel, onToggleMaximized, panelOpen, surfaceActive]);
  useEffect(() => {
    if (!surfaceActive) return;
    return registerDynamicActionHandler("tab.close", () => {
      if (systemTabOverlayActive()) return;
      const state = useLandingPanelStore.getState();
      if (!landingPanelLayoutFor(state, landingPageId).panelOpen) return;
      // The placeholder is a closable row like any other, and closing it is a
      // dismissal rather than a close - there is no tab yet to tombstone.
      if (state.placeholder?.instanceId === state.activeInstanceId) {
        onDismissPlaceholder();
        return;
      }
      const active = state.tabs.find(
        (tab) => tab.instanceId === state.activeInstanceId,
      );
      if (active === undefined) return;
      onCloseTab(active);
    });
  }, [landingPageId, onCloseTab, onDismissPlaceholder, surfaceActive]);
  useEffect(() => {
    if (!surfaceActive) return;
    return registerDynamicActionHandler("tab.close-all", () => {
      if (systemTabOverlayActive()) return;
      const state = useLandingPanelStore.getState();
      if (
        !landingPanelLayoutFor(state, landingPageId).panelOpen ||
        (state.tabs.length === 0 && state.placeholder === null)
      ) {
        return;
      }
      onCloseAllTabs();
    });
  }, [landingPageId, onCloseAllTabs, surfaceActive]);
  // Indexed over the STRIP's rows, not over `state.tabs`: the placeholder is a
  // rendered row and can sit anywhere among them, so two projections would be
  // two orders. Skipping it is the ticket's intent; landing on the neighbour
  // the user can SEE is what the projection buys.
  const activateAdjacentTab = useCallback(
    (delta: 1 | -1) => {
      if (systemTabOverlayActive()) return;
      const state = useLandingPanelStore.getState();
      if (!landingPanelLayoutFor(state, landingPageId).panelOpen) return;
      const placeholderActive =
        state.placeholder !== null &&
        state.placeholder.instanceId === state.activeInstanceId;
      // The guard counts REAL tabs, because the placeholder is never a
      // destination. Two of them are needed to move between them - but from an
      // active placeholder one is enough, and that case matters: the chooser
      // open beside a single terminal could otherwise not reach it at all.
      if (state.tabs.length < (placeholderActive ? 1 : 2)) return;
      const next = landingStripAdjacentInstanceId({
        rows: landingStripRows(state.tabs, state.placeholder),
        activeInstanceId: state.activeInstanceId,
        delta,
      });
      if (next === null) return;
      onActivateTab(next);
    },
    [landingPageId, onActivateTab],
  );
  useEffect(() => {
    if (!surfaceActive) return;
    return registerDynamicActionHandler("tab.next", () =>
      activateAdjacentTab(1),
    );
  }, [activateAdjacentTab, surfaceActive]);
  useEffect(() => {
    if (!surfaceActive) return;
    return registerDynamicActionHandler("tab.prev", () =>
      activateAdjacentTab(-1),
    );
  }, [activateAdjacentTab, surfaceActive]);
  useEffect(() => {
    if (!surfaceActive) return;
    return registerLeaderScope({
      id: LEADER_SCOPE_LANDING_TERMINAL,
      actions: [
        {
          actionId: "tab.switch.byDigit",
          isActive: () => {
            const state = useLandingPanelStore.getState();
            return (
              landingPanelLayoutFor(state, landingPageId).panelOpen &&
              state.tabs.length > 0 &&
              !systemTabOverlayActive()
            );
          },
          // Same digit convention as the canvas strip: physical "1"-"9"
          // reach tabs 1-9; "0" maps to index -1 and falls through. Counted
          // over the strip's REAL rows in display order, through the same
          // projection the strip renders, so the placeholder is skipped rather
          // than shifting every digit past it.
          dispatch: (digit) => {
            const index = digit - 1;
            const state = useLandingPanelStore.getState();
            const tabs = landingStripTabRows(
              landingStripRows(state.tabs, state.placeholder),
            );
            if (index < 0 || index >= tabs.length) return false;
            onActivateTab(tabs[index].instanceId);
            return true;
          },
          dispatchSequence: null,
          sequenceState: null,
        },
      ],
    });
  }, [landingPageId, onActivateTab, surfaceActive]);
}

function LandingTerminalPanelToggle(props: {
  readonly onOpenPanel: () => void;
}): ReactNode {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="Open panel"
      data-testid="landing-terminal-toggle"
      // Occupies exactly the box the header's collapse button renders in
      // while the panel is open (1px panel border + an icon-sm button
      // centered in the h-9 header row, inset by the header's px-2), so
      // toggling the panel never moves the control under the pointer.
      className="absolute top-[5px] right-2 z-10"
      onClick={props.onOpenPanel}
    >
      <PanelRightOpen className="size-4" />
    </Button>
  );
}

/**
 * Both directions of the panel control, rendered into the mobile header's
 * route-actions slot instead of floating in the content area. Free to leave
 * that corner at phone width because the open panel goes through the
 * full-overlay path there, so there is no docked-split geometry to stay
 * aligned with.
 *
 * It carries collapse as well as reveal because the overlay is `absolute
 * inset-0` inside the PAGE container, which sits below the app header - so it
 * never covers the header, and a collapse button inside the panel would stack a
 * second bar under a header that is still on screen. One control in one bar
 * instead.
 *
 * Reads the store itself rather than taking handlers as props: the slot holds a
 * baked `ReactNode`, and one closing over a caller's handler would go stale
 * (see `MobileEpicHeaderActionsBinder`). The page id is data, not a handler:
 * the binder re-bakes the slot whenever it changes, so it stays current.
 */
function LandingTerminalHeaderToggle(props: {
  readonly landingPageId: string;
}): ReactNode {
  const panelOpen = useLandingPanelStore(
    (state) => landingPanelLayoutFor(state, props.landingPageId).panelOpen,
  );
  const setPanelOpen = useLandingPanelStore((state) => state.setPanelOpen);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={panelOpen ? "Collapse panel" : "Open panel"}
      data-testid={
        panelOpen ? "landing-terminal-collapse" : "landing-terminal-toggle"
      }
      className="shrink-0 text-muted-foreground hover:text-foreground"
      onClick={() => {
        setPanelOpen(props.landingPageId, !panelOpen);
      }}
    >
      {panelOpen ? (
        <PanelRightClose className="size-4" />
      ) : (
        <PanelRightOpen className="size-4" />
      )}
    </Button>
  );
}

/**
 * Registers the panel toggle in the mobile header's right-actions registry
 * while the panel is mounted. Rendered from the panel contents, so it inherits
 * the availability guard above - no toggle is registered where no terminal can
 * run.
 *
 * Registration is availability, not presentation: the panel deliberately
 * OUTLIVES its page's activation (it stays mounted behind an epic tab, History
 * or Settings to keep its PTYs warm), and whether the toggle is SHOWN is the
 * header's resolution from the presented surface. So the entry stays put while
 * the landing surface is backgrounded - invisible there by resolution - and is
 * showing again the moment the landing surface is presented, with no event on
 * this side.
 */
function MobileLandingTerminalActionBinder(props: {
  readonly landingPageId: string;
}): ReactNode {
  const registerRightActions = useMobileHeaderStore(
    (state) => state.registerRightActions,
  );
  const unregisterRightActions = useMobileHeaderStore(
    (state) => state.unregisterRightActions,
  );
  useEffect(() => {
    // Keyed and re-baked by the hosting landing page, so the entry both names
    // and toggles the page that hosts the panel - a hosting move retires the
    // old page's entry with its own key before registering the new one.
    const key = landingTerminalRightActionsKey(props.landingPageId);
    registerRightActions(
      key,
      <LandingTerminalHeaderToggle landingPageId={props.landingPageId} />,
    );
    return () => {
      unregisterRightActions(key);
    };
  }, [registerRightActions, unregisterRightActions, props.landingPageId]);
  return null;
}

/**
 * Desktop-only chrome row. Both of its controls are meaningless at phone width:
 * the open panel is a full overlay regardless of the maximized bit, so
 * Maximize/Restore is a no-op, and collapse lives in the app header's slot
 * because the overlay never covers that header - keeping a collapse button here
 * would stack a second bar directly under one that is still on screen. The tab
 * strip becomes the panel's top row there instead.
 */
function LandingTerminalPanelHeader(props: {
  readonly isMobile: boolean;
  readonly maximized: boolean;
  readonly onToggleMaximized: () => void;
  readonly onTogglePanel: () => void;
}): ReactNode {
  if (props.isMobile) return null;
  return (
    <div className="flex h-9 shrink-0 items-center justify-between border-b border-canvas-border/70 px-2">
      <div className="flex min-w-0 items-center gap-2 text-ui-sm font-medium">
        <PanelRight className="size-4 shrink-0" />
        <span className="truncate">Panel</span>
      </div>
      <div className="flex shrink-0 items-center">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={props.maximized ? "Restore panel" : "Maximize panel"}
          onClick={props.onToggleMaximized}
        >
          {props.maximized ? (
            <Minimize2 className="size-4" />
          ) : (
            <Maximize2 className="size-4" />
          )}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Collapse panel"
          data-testid="landing-terminal-collapse"
          onClick={props.onTogglePanel}
        >
          <PanelRightClose className="size-4" />
        </Button>
      </div>
    </div>
  );
}

function LandingTerminalPanelBody(props: {
  readonly landingPageId: string;
  readonly tabs: ReadonlyArray<LandingPanelTabRef>;
  readonly placeholder: LandingPanelPlaceholder | null;
  readonly activeInstanceId: string | null;
  readonly availability: LandingTerminalAvailability;
  readonly panelOpen: boolean;
  readonly activeHostId: string | null;
  readonly createEnabled: boolean;
  readonly createDisabledReason: string | null;
  readonly browserDisabledReason: string | null;
  /** A browser tab has been asked for on this device and is on its way. */
  readonly browserOpening: boolean;
  readonly primaryWorkspacePath: string | null;
  readonly reconciledContext: LandingTerminalHostContext | null;
  readonly directoryPicker: LandingTerminalDirectoryRequest | null;
  readonly onSelectDirectory: (workspacePath: string) => void;
  readonly onCancelDirectoryPicker: () => void;
  readonly authorityEntries: LandingTerminalAuthorityEntries;
  readonly onCloseTab: (tab: LandingPanelTabRef) => void;
  /** The guest's own new-tab chord inside a panel browser: opens the chooser. */
  readonly onOpenNewTab: () => void;
  readonly onOpenBrowserLink: (
    tab: LandingBrowserTabRef,
    url: string,
    disposition: "foreground" | "background",
  ) => void;
  readonly onPickNewTabKind: (kind: LandingNewTabKind) => void;
  readonly onDismissPlaceholder: () => void;
}): ReactNode {
  const placeholderActive =
    props.placeholder !== null &&
    props.placeholder.instanceId === props.activeInstanceId;
  // The picker is a layer OVER the body, so nothing under it is on screen. The
  // strip already resolves its active row this way (one id, two readers); the
  // rows need it too, and for a reason CSS cannot serve: a browser tile's
  // pixels are a native `WebContentsView` the desktop paints over the window,
  // which `invisible` on an ancestor does not touch. Visibility there is an
  // explicit prop by design, and this is the value it must carry.
  //
  // `placeholderActive` deliberately keeps reading the RAW id: picking Terminal
  // raises the picker from the chooser, which stays mounted underneath it, and
  // nulling the id here would unmount the surface the picker was opened from.
  const visibleInstanceId =
    props.directoryPicker === null ? props.activeInstanceId : null;
  const activeTab =
    props.tabs.find((tab) => tab.instanceId === props.activeInstanceId) ?? null;
  // The chooser outranks the connecting status line, and deliberately: the
  // core flows want a device that is still connecting to show the chooser with
  // DISABLED cards carrying that same message, not a blank body that never
  // explains what the panel is waiting to offer.
  //
  // So does a browser row, for a different reason: `availability` is the
  // TERMINAL target host's, and the panel's rows name several devices. A
  // browser tab is maintained through its own device's coordinator and its tile
  // renders that device's own reconnecting / dormant state, so blanking it
  // while an unrelated host resolves takes a working page off screen and
  // replaces it with a sentence about a machine it has nothing to do with.
  if (
    props.availability === "unknown" &&
    props.directoryPicker === null &&
    !placeholderActive &&
    activeTab?.kind !== "browser"
  ) {
    return (
      <div
        role="status"
        className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-ui-sm text-muted-foreground"
      >
        {LANDING_PANEL_CONNECTING_MESSAGE}
      </div>
    );
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div
        aria-hidden={props.directoryPicker !== null}
        className={cn(
          "contents",
          props.directoryPicker !== null && "invisible pointer-events-none",
        )}
      >
        {placeholderActive ? (
          <div className="absolute inset-0 min-h-0">
            <LandingNewTabChooser
              terminal={{
                disabledReason: props.createDisabledReason,
                // The terminal pick has no in-flight window of its own: it
                // either creates synchronously or raises the directory picker
                // over this chooser, and the picker IS the wait.
                pending: false,
              }}
              browser={{
                disabledReason: props.browserDisabledReason,
                pending: props.browserOpening,
              }}
              takeFocus={props.directoryPicker === null}
              onPick={props.onPickNewTabKind}
              onDismiss={props.onDismissPlaceholder}
            />
          </div>
        ) : null}
        {props.tabs.length === 0 && props.placeholder === null ? (
          <LandingTerminalEmptyState
            primaryWorkspacePath={props.primaryWorkspacePath}
            activeHostId={props.activeHostId}
            reconciledContext={props.reconciledContext}
          />
        ) : (
          props.tabs.map((tab) => (
            <div
              key={tab.instanceId}
              className={cn(
                "absolute inset-0 min-h-0",
                tab.instanceId !== props.activeInstanceId &&
                  "invisible pointer-events-none",
              )}
            >
              {tab.kind === "browser" ? (
                <LandingBrowserTile
                  landingPageId={props.landingPageId}
                  tab={tab}
                  active={tab.instanceId === visibleInstanceId}
                  panelOpen={props.panelOpen}
                  onRequestClose={() => props.onCloseTab(tab)}
                  onOpenLinkInNewTile={(url, disposition) => {
                    props.onOpenBrowserLink(tab, url, disposition);
                  }}
                  onRequestNewTab={props.onOpenNewTab}
                />
              ) : (
                <LandingTerminalTile
                  landingPageId={props.landingPageId}
                  tab={tab}
                  active={tab.instanceId === visibleInstanceId}
                  createEnabled={Boolean(
                    props.availability === "supported" &&
                    props.panelOpen &&
                    (props.createEnabled || tab.hostId !== props.activeHostId),
                  )}
                  authorityEntry={props.authorityEntries[tab.hostId] ?? null}
                />
              )}
            </div>
          ))
        )}
      </div>
      {props.directoryPicker === null ? null : (
        <div className="absolute inset-0 z-10">
          <LandingTerminalDirectoryPicker
            requestKey={props.directoryPicker.key}
            workspacePaths={props.directoryPicker.workspacePaths}
            primaryWorkspacePath={props.directoryPicker.primaryWorkspacePath}
            error={props.directoryPicker.error}
            isPending={props.directoryPicker.selectedTarget !== null}
            onSelect={props.onSelectDirectory}
            onCancel={props.onCancelDirectoryPicker}
          />
        </div>
      )}
    </div>
  );
}

function LandingTerminalEmptyState(props: {
  readonly primaryWorkspacePath: string | null;
  readonly activeHostId: string | null;
  readonly reconciledContext: LandingTerminalHostContext | null;
}): ReactNode {
  // Bridged v2.0 host with no primary folder: capability/update guidance, not
  // the removed folder-picker blocker and not a guessed cwd.
  if (
    props.primaryWorkspacePath === null &&
    props.reconciledContext !== null &&
    props.activeHostId !== null &&
    props.reconciledContext.hostId === props.activeHostId &&
    props.reconciledContext.homeCwd === null
  ) {
    return (
      <div
        role="status"
        data-testid="landing-terminal-host-update"
        className="flex h-full min-h-0 items-center justify-center p-6 text-center text-ui-sm text-muted-foreground"
      >
        {LANDING_TERMINAL_HOST_UPDATE_GUIDANCE}
      </div>
    );
  }
  // Nothing, deliberately. This branch used to say "Starting terminal…", which
  // was true while an open empty panel auto-spawned one; it now holds the
  // chooser instead, and the open-transition effect opens that placeholder in
  // the same commit. So the only state this can render in is the single frame
  // before that effect lands - where a line promising the one thing the core
  // flows removed would flash under the chooser replacing it. An empty frame
  // says nothing, which is what there is to say.
  return null;
}

function isLandingTerminalPanelElement(
  value: Element | null,
): value is HTMLElement {
  return (
    value instanceof HTMLElement &&
    value.dataset.landingTerminalPanel !== undefined
  );
}

function resolveLandingTerminalResizeContainer(
  handle: HTMLElement,
): HTMLElement | null {
  const parent = handle.parentElement;
  if (parent === null) return null;

  // Split landing panes portal the handle and panel into a `display: contents`
  // anchor. That anchor preserves flex layout but has no box of its own, so its
  // bounding rect is always zero-sized. Measure the pane's flex row instead.
  return window.getComputedStyle(parent).display === "contents"
    ? parent.parentElement
    : parent;
}

interface LandingTerminalPanelResizeArgs {
  readonly panelWidthFraction: number;
  readonly setPanelWidthFraction: (fraction: number) => void;
  readonly onLayoutSettled: () => void;
}

interface LandingTerminalPanelResizeResult {
  readonly sliderProps: PointerDragSliderProps;
  readonly isDragging: () => boolean;
}

function useLandingTerminalPanelResize(
  args: LandingTerminalPanelResizeArgs,
): LandingTerminalPanelResizeResult {
  const dragRef = useRef<LandingTerminalDragState | null>(null);
  const sliderProps = usePointerDragCommit({
    axis: "horizontal",
    onDragStart: (event) => {
      const panel = event.currentTarget.nextElementSibling;
      const container = resolveLandingTerminalResizeContainer(
        event.currentTarget,
      );
      if (!isLandingTerminalPanelElement(panel) || container === null) {
        return false;
      }
      const containerWidth = container.getBoundingClientRect().width;
      if (containerWidth <= 0) return false;
      const startWidth = panel.getBoundingClientRect().width;
      dragRef.current = {
        containerWidth,
        startWidth,
        minWidth: containerWidth * MIN_LANDING_PANEL_WIDTH_FRACTION,
        maxWidth: containerWidth * MAX_LANDING_PANEL_WIDTH_FRACTION,
        panel,
        initialWidth: panel.style.width,
        latestFraction: startWidth / containerWidth,
      };
      return true;
    },
    onDragFrame: (deltaPx) => {
      const drag = dragRef.current;
      if (drag === null) return;
      const nextWidth = Math.min(
        drag.maxWidth,
        Math.max(drag.minWidth, drag.startWidth - deltaPx),
      );
      drag.latestFraction = nextWidth / drag.containerWidth;
      drag.panel.style.width = `${drag.latestFraction * 100}%`;
    },
    onDragCommit: () => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag === null) return;
      args.setPanelWidthFraction(drag.latestFraction);
      args.onLayoutSettled();
    },
    onDragCancel: () => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag === null) return;
      drag.panel.style.width = drag.initialWidth;
      args.onLayoutSettled();
    },
    onReset: () => {
      args.setPanelWidthFraction(DEFAULT_LANDING_PANEL_WIDTH_FRACTION);
      args.onLayoutSettled();
    },
    onKeyNudge: (direction) => {
      args.setPanelWidthFraction(args.panelWidthFraction - direction * 0.03);
      args.onLayoutSettled();
    },
  });
  const isDragging = useCallback((): boolean => dragRef.current !== null, []);
  return { sliderProps, isDragging };
}

function useLandingTerminalLayoutReconcile(args: {
  readonly panelOpen: boolean;
  readonly activeInstanceId: string | null;
}): () => void {
  const frameRef = useRef<number | null>(null);
  const previousPanelOpenRef = useRef(args.panelOpen);
  const cancelScheduledReconcile = useCallback((): void => {
    if (frameRef.current === null) return;
    window.cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }, []);
  const scheduleReconcile = useCallback((): void => {
    cancelScheduledReconcile();
    if (!args.panelOpen || args.activeInstanceId === null) return;
    const instanceId = args.activeInstanceId;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      reconcileXtermHostAfterLayoutTransition(instanceId);
    });
  }, [args.activeInstanceId, args.panelOpen, cancelScheduledReconcile]);

  useEffect(() => {
    const reopened = args.panelOpen && !previousPanelOpenRef.current;
    previousPanelOpenRef.current = args.panelOpen;
    // A normal reveal reconciles on its final width transition. If another
    // resize has globally suppressed transitions, the panel jumps straight to
    // its target width and needs the next-frame fallback instead. An active-tab
    // change while already open also lands here, including a delayed
    // reconciliation that selects a different terminal after reveal.
    if (args.panelOpen && (!reopened || isPanelResizeInteractionActive())) {
      scheduleReconcile();
    }
    return cancelScheduledReconcile;
  }, [
    args.activeInstanceId,
    args.panelOpen,
    cancelScheduledReconcile,
    scheduleReconcile,
  ]);

  return scheduleReconcile;
}
