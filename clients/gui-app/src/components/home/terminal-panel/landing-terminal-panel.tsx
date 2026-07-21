import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useIsMutating } from "@tanstack/react-query";
import {
  FolderOpen,
  Maximize2,
  Minimize2,
  PanelRightClose,
  PanelRightOpen,
  TerminalSquare,
} from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { registerDynamicActionHandler } from "@/lib/keybindings/dispatch";
import {
  LEADER_SCOPE_LANDING_TERMINAL,
  registerLeaderScope,
} from "@/lib/keybindings/leader-scope";
import { getSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import {
  pointerDragHandleAxisClassName,
  usePointerDragCommit,
} from "@/components/epic-canvas/canvas/use-pointer-drag-commit";
import { usePickAndAddWorkspaceFolders } from "@/components/home/host-workspace-selector/use-pick-and-add-folders";
import { workspaceMutationKeys } from "@/lib/query-keys";
import { workspaceFolderName } from "@/lib/worktree/workspace-folder-name";
import { focusActiveComposer } from "@/lib/composer/composer-focus-registry";
import {
  clearPendingTerminalFocus,
  focusTerminalInstance,
} from "@/lib/terminals/terminal-focus-registry";
import { cn } from "@/lib/utils";
import {
  DEFAULT_LANDING_TERMINAL_PANEL_WIDTH_FRACTION,
  MAX_LANDING_TERMINAL_PANEL_WIDTH_FRACTION,
  MIN_LANDING_TERMINAL_PANEL_WIDTH_FRACTION,
  useLandingTerminalStore,
  type LandingTerminalTabRef,
} from "@/stores/home/landing-terminal-store";
import { LandingTerminalTabStrip } from "./landing-terminal-tab-strip";
import { LandingTerminalTile } from "./landing-terminal-tile";
import { useLandingTerminalKill } from "./use-landing-terminal-kill-mutation";
import { useLandingTerminalReconciliation } from "./use-landing-terminal-reconciliation";
import { type LandingTerminalAvailability } from "./landing-terminal-availability";
import {
  useLandingTerminalGesture,
  type LandingTerminalTarget,
} from "./landing-terminal-gesture-context";

interface LandingTerminalDragState {
  readonly containerWidth: number;
  readonly startWidth: number;
  readonly minWidth: number;
  readonly maxWidth: number;
  readonly panel: HTMLElement;
  readonly initialWidth: string;
  latestFraction: number;
}

function terminalForTarget(
  tabs: ReadonlyArray<LandingTerminalTabRef>,
  activeInstanceId: string | null,
  target: LandingTerminalTarget,
): LandingTerminalTabRef | undefined {
  if (target.hostId === null || target.primaryWorkspacePath === null) {
    return undefined;
  }
  const matches = (tab: LandingTerminalTabRef): boolean =>
    tab.hostId === target.hostId && tab.cwd === target.primaryWorkspacePath;
  const active = tabs.find((tab) => tab.instanceId === activeInstanceId);
  return active !== undefined && matches(active) ? active : tabs.find(matches);
}

/**
 * Landing-only independent-terminal surface. It is a CONSUMER of
 * `LandingTerminalGestureProvider`: every host / client / folder / availability
 * value comes from `useLandingTerminalGesture().target`, never a live hook - so
 * no live value is in scope for a create / reconcile / `+` / picker path to
 * accidentally read past a pinned opening gesture.
 */
export function LandingTerminalPanel(): ReactNode {
  const {
    target,
    pending,
    pendingGeneration,
    openEpisodeDraftId,
    workspace,
    capture,
    clearPending,
  } = useLandingTerminalGesture();
  const tabs = useLandingTerminalStore((state) => state.tabs);
  const activeInstanceId = useLandingTerminalStore(
    (state) => state.activeInstanceId,
  );
  const panelOpen = useLandingTerminalStore((state) => state.panelOpen);
  const panelWidthFraction = useLandingTerminalStore(
    (state) => state.panelWidthFraction,
  );
  const setPanelOpen = useLandingTerminalStore((state) => state.setPanelOpen);
  const setPanelWidthFraction = useLandingTerminalStore(
    (state) => state.setPanelWidthFraction,
  );
  const addTab = useLandingTerminalStore((state) => state.addTab);
  const activateTab = useLandingTerminalStore((state) => state.activateTab);
  const renameTab = useLandingTerminalStore((state) => state.renameTab);
  const closeTab = useLandingTerminalStore((state) => state.closeTab);
  const closeAllTabs = useLandingTerminalStore((state) => state.closeAllTabs);
  const kill = useLandingTerminalKill();
  const killTerminal = kill.mutate;
  const killTerminalAsync = kill.mutateAsync;
  const [maximized, setMaximized] = useState(false);
  const [reconciledHostId, setReconciledHostId] = useState<string | null>(null);

  const createTerminalTab = useCallback(
    (routing: LandingTerminalTarget): string | null => {
      if (routing.hostId === null || routing.primaryWorkspacePath === null) {
        return null;
      }
      if (routing.availability !== "supported") return null;
      // Fail-closed: no host client (a gesture that could not pin one) means we
      // cannot reconcile the terminal, so we do not create it. In non-gesture
      // operation the target carries the default client, so this never blocks.
      if (routing.client === null) return null;
      const instanceId = `landing-terminal-${uuidv4()}`;
      addTab({
        instanceId,
        sessionId: `landing-term-${uuidv4()}`,
        hostId: routing.hostId,
        cwd: routing.primaryWorkspacePath,
        name: workspaceFolderName(routing.primaryWorkspacePath),
        titleSource: "default",
      });
      return instanceId;
    },
    [addTab],
  );

  // The `+` button: create against the EFFECTIVE target (a pinned gesture, else
  // live focus). It never re-captures, so a `+` pressed while an opening gesture
  // is still pending honors that gesture's captured host/folder, not focus that
  // moved to a split partner in the meantime.
  const createTerminalTabFocused = useCallback(() => {
    const instanceId = createTerminalTab(target);
    if (instanceId !== null) focusTerminalInstance(instanceId);
  }, [createTerminalTab, target]);

  // The tab-family chord ("new terminal"): if the panel is closed, capture the
  // open gesture and create from THAT captured snapshot up-front (the non-empty
  // set suppresses the open reconciliation's auto-spawn). If already open, it is
  // just a `+` - create against the effective target, never re-capturing.
  const revealAndCreateTerminal = useCallback(() => {
    if (panelOpen) {
      const instanceId = createTerminalTab(target);
      if (instanceId !== null) focusTerminalInstance(instanceId);
      return;
    }
    const captured = capture();
    setPanelOpen(true);
    const instanceId = createTerminalTab(captured);
    if (instanceId !== null) focusTerminalInstance(instanceId);
  }, [capture, createTerminalTab, panelOpen, setPanelOpen, target]);

  const activateTerminalTab = useCallback(
    (instanceId: string) => {
      clearPending();
      activateTab(instanceId);
      focusTerminalInstance(instanceId);
    },
    [activateTab, clearPending],
  );

  // Focus follows the open/collapse *transition*, never the mount: a landing
  // page that mounts with the panel already open (new tab, tab switch back)
  // must leave focus with the composer. Opening also arms the pinned-folder
  // intent that reconciliation consumes once the host's session list settles.
  const prevPanelOpenRef = useRef(panelOpen);
  useEffect(() => {
    const wasOpen = prevPanelOpenRef.current;
    prevPanelOpenRef.current = panelOpen;
    if (wasOpen === panelOpen) return;
    if (panelOpen) {
      if (!pending) capture();
      const openActiveInstanceId =
        useLandingTerminalStore.getState().activeInstanceId;
      if (openActiveInstanceId !== null) {
        focusTerminalInstance(openActiveInstanceId);
      }
      return;
    }
    // Every collapse path converges on this store transition: the chord, the
    // header button, closing the last tab, close-all, and a shell exiting.
    // All of them should hand the keyboard back to the composer.
    clearPendingTerminalFocus();
    focusActiveComposer();
  }, [capture, panelOpen, pending]);
  useEffect(
    () => () => {
      clearPendingTerminalFocus();
    },
    [],
  );

  // Runs after every settled reconciliation pass (the reconciliation key
  // includes the open/closed bit, so every panel-open transition lands here).
  // Empty panels auto-spawn in the pinned folder; a gesture-opened panel
  // additionally re-targets the pinned folder: reuse a terminal already
  // running there, otherwise spawn a fresh one, and focus it either way.
  const handleReconciliationSettled = useCallback(
    (generation: number) => {
      const state = useLandingTerminalStore.getState();
      // A settlement for a superseded generation must neither act nor clear the
      // newer pending gesture that replaced it.
      if (pending && pendingGeneration !== generation) return;
      // Any pending gesture now matches this settled generation and is consumed
      // exactly once. Clear it on EVERY outcome below (spawn, reuse, no-op) so a
      // later gesture projects live focus instead of this stale snapshot, and
      // `+`/workspace projection follow the newly focused draft after settling.
      const clearIfPending = (): void => {
        if (pending) clearPending();
      };
      if (!state.panelOpen || target.primaryWorkspacePath === null) {
        clearIfPending();
        return;
      }
      if (state.tabs.length === 0) {
        // Empty-panel auto-spawn is pinned to the opening draft. A gesture
        // spawns its captured draft; a gesture-less live settlement (post-clear,
        // or a pre-opened panel whose folder just arrived) only spawns while
        // focus still rests on the opening draft, so switching drafts mid-flight
        // never spawns a terminal in the draft the user merely moved to.
        if (!pending && target.draftId !== openEpisodeDraftId) return;
        const created = createTerminalTab(target);
        if (pending && created !== null) focusTerminalInstance(created);
        clearIfPending();
        return;
      }
      if (!pending || target.hostId === null) return;
      const existing = terminalForTarget(
        state.tabs,
        state.activeInstanceId,
        target,
      );
      if (existing === undefined) {
        const created = createTerminalTab(target);
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
      clearPending,
      createTerminalTab,
      openEpisodeDraftId,
      pending,
      pendingGeneration,
      target,
    ],
  );

  useLandingTerminalReconciliation({
    activeHostId: target.hostId,
    availability: target.availability,
    panelOpen,
    primaryWorkspacePath: target.primaryWorkspacePath,
    generation: target.generation,
    client: target.client,
    killTerminal: killTerminalAsync,
    onReconciled: setReconciledHostId,
    onSettled: handleReconciliationSettled,
  });

  const closeTerminalTab = useCallback(
    (tab: LandingTerminalTabRef) => {
      clearPending();
      // `closeTab` is the atomic tombstone-first durable write. Dispatch the
      // host mutation only after that state transition has completed.
      const closed = closeTab(tab.instanceId);
      if (closed === null) return;
      killTerminal({ hostId: closed.hostId, sessionId: closed.sessionId });
      // Closing a non-last tab promotes a surviving neighbor - keep the
      // keyboard with the panel. The last-tab case collapses the panel, and
      // the open-transition effect hands focus back to the composer instead.
      const state = useLandingTerminalStore.getState();
      if (state.panelOpen && state.activeInstanceId !== null) {
        focusTerminalInstance(state.activeInstanceId);
      }
    },
    [clearPending, closeTab, killTerminal],
  );

  const closeAllTerminalTabs = useCallback(() => {
    // Same tombstone-first ordering as a single close, batched: every ref is
    // durably tombstoned in one write before the first kill is dispatched.
    clearPending();
    closeAllTabs().forEach((closed) => {
      killTerminal({ hostId: closed.hostId, sessionId: closed.sessionId });
    });
  }, [clearPending, closeAllTabs, killTerminal]);

  const togglePanel = useCallback(() => {
    if (panelOpen) {
      setMaximized(false);
      clearPending();
      setPanelOpen(false);
      return;
    }
    capture();
    setPanelOpen(true);
  }, [capture, clearPending, panelOpen, setPanelOpen]);

  const openPanel = useCallback(() => {
    capture();
    setPanelOpen(true);
  }, [capture, setPanelOpen]);

  // The picker acts on the CAPTURED host client + the captured draft's workspace
  // source (both from the target/provider), so a folder picked while a gesture
  // pins draft A lands in A's workspace on A's host, not the focused partner.
  const pickAndAddFolders = usePickAndAddWorkspaceFolders(
    target.client,
    workspace,
  );
  const pickFolder = useCallback(() => {
    void pickAndAddFolders();
  }, [pickAndAddFolders]);
  const folderPickPending =
    useIsMutating({ mutationKey: workspaceMutationKeys.prepareFolders() }) > 0;

  // The `+` gate reads the effective target only: capability from the captured
  // host, fail-closed on an unpinned client, and the pinned folder.
  const { createEnabled, createDisabledReason } = landingTerminalCreateGate({
    panelOpen,
    availability: target.availability,
    hostId: target.hostId,
    primaryWorkspacePath: target.primaryWorkspacePath,
    clientReady: target.client !== null,
    reconciled: reconciledHostId === target.hostId,
  });

  // Several remote hosts can exist without a default selection. This is a
  // real page state, not an unsupported/unknown verdict: leave persistence
  // untouched and render no terminal affordance until one is selected. Read the
  // captured verdict so a mid-gesture switch to an unsupported host cannot
  // unmount the panel (and destroy the captured host's reconciliation).
  if (
    target.availability === "no-active-host" ||
    target.availability === "unsupported"
  ) {
    return null;
  }

  return (
    <LandingTerminalPanelContents
      tabs={tabs}
      activeInstanceId={activeInstanceId}
      availability={target.availability}
      panelOpen={panelOpen}
      panelWidthFraction={panelWidthFraction}
      primaryWorkspacePath={target.primaryWorkspacePath}
      activeHostId={target.hostId}
      createEnabled={createEnabled}
      createDisabledReason={createDisabledReason}
      maximized={maximized}
      folderPickPending={folderPickPending}
      onTogglePanel={togglePanel}
      onOpenPanel={openPanel}
      onToggleMaximized={() => setMaximized((value) => !value)}
      onSetPanelWidthFraction={setPanelWidthFraction}
      onCreateTerminal={createTerminalTabFocused}
      onRevealAndCreate={revealAndCreateTerminal}
      onActivateTab={activateTerminalTab}
      onCloseTab={closeTerminalTab}
      onCloseAllTabs={closeAllTerminalTabs}
      onRenameTab={renameTab}
      onPickFolder={pickFolder}
    />
  );
}

interface LandingTerminalPanelContentsProps {
  readonly tabs: ReadonlyArray<LandingTerminalTabRef>;
  readonly activeInstanceId: string | null;
  readonly availability: LandingTerminalAvailability;
  readonly panelOpen: boolean;
  readonly panelWidthFraction: number;
  readonly primaryWorkspacePath: string | null;
  readonly activeHostId: string | null;
  readonly createEnabled: boolean;
  readonly createDisabledReason: string | null;
  readonly maximized: boolean;
  readonly folderPickPending: boolean;
  readonly onTogglePanel: () => void;
  readonly onOpenPanel: () => void;
  readonly onToggleMaximized: () => void;
  readonly onSetPanelWidthFraction: (fraction: number) => void;
  readonly onCreateTerminal: () => void;
  readonly onRevealAndCreate: () => void;
  readonly onActivateTab: (instanceId: string) => void;
  readonly onCloseTab: (tab: LandingTerminalTabRef) => void;
  readonly onCloseAllTabs: () => void;
  readonly onRenameTab: (instanceId: string, name: string) => void;
  readonly onPickFolder: () => void;
}

function LandingTerminalPanelContents(
  props: LandingTerminalPanelContentsProps,
): ReactNode {
  const sliderProps = useLandingTerminalPanelResize({
    panelWidthFraction: props.panelWidthFraction,
    setPanelWidthFraction: props.onSetPanelWidthFraction,
  });
  useLandingTerminalShortcuts({
    panelOpen: props.panelOpen,
    maximized: props.maximized,
    onTogglePanel: props.onTogglePanel,
    onOpenPanel: props.onOpenPanel,
    onRevealAndCreate: props.onRevealAndCreate,
    onToggleMaximized: props.onToggleMaximized,
    onActivateTab: props.onActivateTab,
    onCloseTab: props.onCloseTab,
    onCloseAllTabs: props.onCloseAllTabs,
  });
  const panelStyle = props.maximized
    ? undefined
    : { width: props.panelOpen ? `${props.panelWidthFraction * 100}%` : "0%" };

  return (
    <>
      {/* Reveal-only affordance. Once open, the panel header owns collapse -
          rendering both would stack two controls in the same corner. */}
      {props.panelOpen ? null : (
        <LandingTerminalPanelToggle onOpenPanel={props.onOpenPanel} />
      )}
      <div
        {...sliderProps}
        aria-valuenow={Math.round(props.panelWidthFraction * 100)}
        aria-valuemin={Math.round(
          MIN_LANDING_TERMINAL_PANEL_WIDTH_FRACTION * 100,
        )}
        aria-valuemax={Math.round(
          MAX_LANDING_TERMINAL_PANEL_WIDTH_FRACTION * 100,
        )}
        aria-label="Resize terminal panel"
        data-testid="landing-terminal-resize-handle"
        className={cn(
          "relative z-10 shrink-0 bg-background ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden",
          pointerDragHandleAxisClassName("horizontal"),
          (!props.panelOpen || props.maximized) &&
            "invisible pointer-events-none",
        )}
      />
      <aside
        data-landing-terminal-panel
        data-testid="landing-terminal-panel"
        data-open={props.panelOpen ? "true" : "false"}
        className={cn(
          "flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-t border-l border-canvas-border/70 bg-canvas transition-[width,visibility]",
          // The width transition exists for open/collapse only. During a
          // resize drag the global freeze class suspends it - otherwise every
          // per-frame `style.width` write eases over the default duration and
          // the panel rubber-bands behind the pointer.
          "[.traycer-panel-resizing_&]:transition-none",
          !props.panelOpen && "invisible pointer-events-none",
          props.maximized && "absolute inset-0 z-20 w-full",
        )}
        style={panelStyle}
      >
        <LandingTerminalPanelHeader
          maximized={props.maximized}
          onToggleMaximized={props.onToggleMaximized}
          onTogglePanel={props.onTogglePanel}
        />
        <LandingTerminalTabStrip
          tabs={props.tabs}
          activeInstanceId={props.activeInstanceId}
          createDisabledReason={props.createDisabledReason}
          onAdd={props.onCreateTerminal}
          onActivate={props.onActivateTab}
          onClose={props.onCloseTab}
          onCloseAll={props.onCloseAllTabs}
          onRename={props.onRenameTab}
        />
        <LandingTerminalPanelBody
          tabs={props.tabs}
          activeInstanceId={props.activeInstanceId}
          availability={props.availability}
          panelOpen={props.panelOpen}
          activeHostId={props.activeHostId}
          createEnabled={props.createEnabled}
          primaryWorkspacePath={props.primaryWorkspacePath}
          folderPickPending={props.folderPickPending}
          onPickFolder={props.onPickFolder}
        />
      </aside>
    </>
  );
}

/**
 * Why the strip's "+" is unavailable (surfaced as its tooltip), `null` when
 * creating is live. Mirrors the empty-state copy so the strip explains itself
 * even when tabs are already open (e.g. the pinned folder was removed after
 * the terminals were spawned). `clientReady` is false when the host client
 * cannot be pinned (fail-closed): the action stays disabled rather than falling
 * back to the live default client.
 */
function landingTerminalCreateDisabledReason(
  availability: LandingTerminalAvailability,
  primaryWorkspacePath: string | null,
  clientReady: boolean,
): string | null {
  if (!clientReady) return "Connecting to the selected host…";
  if (availability !== "supported") return "Connecting to the selected host…";
  if (primaryWorkspacePath === null) {
    return "Pick a folder to open a terminal in.";
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
  readonly reconciled: boolean;
}): {
  readonly createEnabled: boolean;
  readonly createDisabledReason: string | null;
} {
  const createDisabledReason = landingTerminalCreateDisabledReason(
    args.availability,
    args.primaryWorkspacePath,
    args.clientReady,
  );
  const createEnabled =
    args.panelOpen &&
    args.availability === "supported" &&
    args.hostId !== null &&
    args.clientReady &&
    args.reconciled;
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
  readonly panelOpen: boolean;
  readonly maximized: boolean;
  readonly onTogglePanel: () => void;
  readonly onOpenPanel: () => void;
  readonly onRevealAndCreate: () => void;
  readonly onToggleMaximized: () => void;
  readonly onActivateTab: (instanceId: string) => void;
  readonly onCloseTab: (tab: LandingTerminalTabRef) => void;
  readonly onCloseAllTabs: () => void;
}): void {
  const {
    panelOpen,
    maximized,
    onTogglePanel,
    onOpenPanel,
    onRevealAndCreate,
    onToggleMaximized,
    onActivateTab,
    onCloseTab,
    onCloseAllTabs,
  } = args;
  useEffect(
    () => registerDynamicActionHandler("app.terminal.toggle", onTogglePanel),
    [onTogglePanel],
  );
  // Reveal-and-create is one gesture in the panel: a collapsed panel captures
  // the open gesture and creates from that captured snapshot up-front (the
  // non-empty set suppresses reconciliation's auto-spawn), while an open panel
  // is just a `+`. It self-gates, so this is safe while the host is connecting.
  useEffect(
    () => registerDynamicActionHandler("app.terminal.new", onRevealAndCreate),
    [onRevealAndCreate],
  );
  useEffect(
    () =>
      registerDynamicActionHandler("tab.new", () => {
        if (systemTabOverlayActive()) return;
        onRevealAndCreate();
      }),
    [onRevealAndCreate],
  );
  useEffect(
    () =>
      registerDynamicActionHandler("app.terminal.maximize", () => {
        if (!panelOpen) {
          // Revealing an already-maximized panel (possible when the last tab
          // closed while maximized) must not un-maximize it.
          onOpenPanel();
          if (!maximized) onToggleMaximized();
          return;
        }
        onToggleMaximized();
      }),
    [maximized, onOpenPanel, onToggleMaximized, panelOpen],
  );
  useEffect(
    () =>
      registerDynamicActionHandler("tab.close", () => {
        if (systemTabOverlayActive()) return;
        const state = useLandingTerminalStore.getState();
        if (!state.panelOpen) return;
        const active = state.tabs.find(
          (tab) => tab.instanceId === state.activeInstanceId,
        );
        if (active === undefined) return;
        onCloseTab(active);
      }),
    [onCloseTab],
  );
  useEffect(
    () =>
      registerDynamicActionHandler("tab.close-all", () => {
        if (systemTabOverlayActive()) return;
        const state = useLandingTerminalStore.getState();
        if (!state.panelOpen || state.tabs.length === 0) return;
        onCloseAllTabs();
      }),
    [onCloseAllTabs],
  );
  const activateAdjacentTab = useCallback(
    (delta: 1 | -1) => {
      if (systemTabOverlayActive()) return;
      const state = useLandingTerminalStore.getState();
      if (!state.panelOpen || state.tabs.length < 2) return;
      const index = state.tabs.findIndex(
        (tab) => tab.instanceId === state.activeInstanceId,
      );
      const count = state.tabs.length;
      const next = state.tabs[(Math.max(index, 0) + delta + count) % count];
      onActivateTab(next.instanceId);
    },
    [onActivateTab],
  );
  useEffect(
    () =>
      registerDynamicActionHandler("tab.next", () => activateAdjacentTab(1)),
    [activateAdjacentTab],
  );
  useEffect(
    () =>
      registerDynamicActionHandler("tab.prev", () => activateAdjacentTab(-1)),
    [activateAdjacentTab],
  );
  useEffect(
    () =>
      registerLeaderScope({
        id: LEADER_SCOPE_LANDING_TERMINAL,
        actions: [
          {
            actionId: "tab.switch.byDigit",
            isActive: () => {
              const state = useLandingTerminalStore.getState();
              return (
                state.panelOpen &&
                state.tabs.length > 0 &&
                !systemTabOverlayActive()
              );
            },
            // Same digit convention as the canvas strip: physical "1"-"9"
            // reach tabs 1-9; "0" maps to index -1 and falls through.
            dispatch: (digit) => {
              const index = digit - 1;
              const tabs = useLandingTerminalStore.getState().tabs;
              if (index < 0 || index >= tabs.length) return false;
              onActivateTab(tabs[index].instanceId);
              return true;
            },
            dispatchSequence: null,
            sequenceState: null,
          },
        ],
      }),
    [onActivateTab],
  );
}

function LandingTerminalPanelToggle(props: {
  readonly onOpenPanel: () => void;
}): ReactNode {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="Open terminal panel"
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

function LandingTerminalPanelHeader(props: {
  readonly maximized: boolean;
  readonly onToggleMaximized: () => void;
  readonly onTogglePanel: () => void;
}): ReactNode {
  return (
    <div className="flex h-9 shrink-0 items-center justify-between border-b border-canvas-border/70 px-2">
      <div className="flex min-w-0 items-center gap-2 text-ui-sm font-medium">
        <TerminalSquare className="size-4 shrink-0" />
        <span className="truncate">Terminal</span>
      </div>
      <div className="flex shrink-0 items-center">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={
            props.maximized
              ? "Restore terminal panel"
              : "Maximize terminal panel"
          }
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
          aria-label="Collapse terminal panel"
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
  readonly tabs: ReadonlyArray<LandingTerminalTabRef>;
  readonly activeInstanceId: string | null;
  readonly availability: LandingTerminalAvailability;
  readonly panelOpen: boolean;
  readonly activeHostId: string | null;
  readonly createEnabled: boolean;
  readonly primaryWorkspacePath: string | null;
  readonly folderPickPending: boolean;
  readonly onPickFolder: () => void;
}): ReactNode {
  if (props.availability === "unknown") {
    return (
      <div
        role="status"
        className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-ui-sm text-muted-foreground"
      >
        Connecting to the selected host…
      </div>
    );
  }

  return (
    <div className="relative min-h-0 flex-1">
      {props.tabs.length === 0 ? (
        <LandingTerminalEmptyState
          primaryWorkspacePath={props.primaryWorkspacePath}
          folderPickPending={props.folderPickPending}
          onPickFolder={props.onPickFolder}
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
            <LandingTerminalTile
              tab={tab}
              active={tab.instanceId === props.activeInstanceId}
              createEnabled={Boolean(
                props.availability === "supported" &&
                props.panelOpen &&
                (props.createEnabled || tab.hostId !== props.activeHostId),
              )}
            />
          </div>
        ))
      )}
    </div>
  );
}

function LandingTerminalEmptyState(props: {
  readonly primaryWorkspacePath: string | null;
  readonly folderPickPending: boolean;
  readonly onPickFolder: () => void;
}): ReactNode {
  // No folder means no cwd to spawn in. Offer the picker here rather than
  // telling the user to go find it: it writes through the same workspace
  // source as the composer's picker, so the folder they choose becomes the
  // primary and reconciliation's auto-spawn opens the terminal.
  if (props.primaryWorkspacePath === null) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-ui-sm text-muted-foreground">
          Pick a folder to open a terminal in.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="landing-terminal-select-folder"
          disabled={props.folderPickPending}
          onClick={props.onPickFolder}
        >
          <FolderOpen className="size-4" />
          Select folder
          {props.folderPickPending ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : null}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 items-center justify-center p-6 text-center text-ui-sm text-muted-foreground">
      Starting terminal…
    </div>
  );
}

function isLandingTerminalPanelElement(
  value: Element | null,
): value is HTMLElement {
  return (
    value instanceof HTMLElement &&
    value.dataset.landingTerminalPanel !== undefined
  );
}

interface LandingTerminalPanelResizeArgs {
  readonly panelWidthFraction: number;
  readonly setPanelWidthFraction: (fraction: number) => void;
}

function useLandingTerminalPanelResize(args: LandingTerminalPanelResizeArgs) {
  const dragRef = useRef<LandingTerminalDragState | null>(null);
  return usePointerDragCommit({
    axis: "horizontal",
    onDragStart: (event) => {
      const panel = event.currentTarget.nextElementSibling;
      const container = event.currentTarget.parentElement;
      if (!isLandingTerminalPanelElement(panel) || container === null) {
        return false;
      }
      const containerWidth = container.getBoundingClientRect().width;
      if (containerWidth <= 0) return false;
      const startWidth = panel.getBoundingClientRect().width;
      dragRef.current = {
        containerWidth,
        startWidth,
        minWidth: containerWidth * MIN_LANDING_TERMINAL_PANEL_WIDTH_FRACTION,
        maxWidth: containerWidth * MAX_LANDING_TERMINAL_PANEL_WIDTH_FRACTION,
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
    },
    onDragCancel: () => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag === null) return;
      drag.panel.style.width = drag.initialWidth;
    },
    onReset: () => {
      args.setPanelWidthFraction(DEFAULT_LANDING_TERMINAL_PANEL_WIDTH_FRACTION);
    },
    onKeyNudge: (direction) => {
      args.setPanelWidthFraction(args.panelWidthFraction - direction * 0.03);
    },
  });
}
