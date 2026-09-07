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
  PanelRightClose,
  PanelRightOpen,
  TerminalSquare,
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
  DEFAULT_LANDING_TERMINAL_PANEL_WIDTH_FRACTION,
  MAX_LANDING_TERMINAL_PANEL_WIDTH_FRACTION,
  MIN_LANDING_TERMINAL_PANEL_WIDTH_FRACTION,
  isProviderLoginLandingTab,
  landingTerminalLayoutFor,
  useLandingTerminalStore,
  type LandingTerminalTabRef,
  UNBOUND_LANDING_PAGE_ID,
} from "@/stores/home/landing-terminal-store";
import { LandingTerminalTabStrip } from "./landing-terminal-tab-strip";
import { LandingTerminalDirectoryPicker } from "./landing-terminal-directory-picker";
import { LandingTerminalTile } from "./landing-terminal-tile";
import {
  LandingTerminalAuthorityFleet,
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

/** The phone overlay covers the page rather than sitting next to it, so `bg-canvas` there laid a white sheet
 * under the `bg-background` header, and the borders divide nothing. */
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

/** A missing or `"unknown"` entry means the capability probe has not answered, so neither branch of the tile
 * lifecycle can be chosen yet; a `"capable"` host that cannot mutate has a stale or reconnecting list stream. */
function landingTerminalAuthorityReady(
  entry: LandingTerminalAuthorityEntry | null | undefined,
): entry is LandingTerminalAuthorityEntry {
  if (entry === null || entry === undefined) return false;
  const capability = entry.authority.capability;
  if (capability.status === "legacy") return true;
  return capability.status === "capable" && entry.authority.canMutate;
}

/** A host that cannot be asked - offline, or a capability probe that has not answered. */
function dispatchLandingTerminalClose(args: {
  readonly entry: LandingTerminalAuthorityEntry | undefined;
  readonly closed: LandingTerminalTabRef;
  readonly killTerminal: (
    variables: LandingTerminalKillVariables,
  ) => Promise<unknown>;
}): void {
  const { entry, closed, killTerminal } = args;
  if (!landingTerminalAuthorityReady(entry)) return;
  // The capable arm below requires one (`requireOwnerRow`) and would reject before sending, raising "Couldn't
  // close the terminal." over a sign-in shell that is still running.
  if (
    isProviderLoginLandingTab(closed) ||
    entry.authority.capability.status !== "capable"
  ) {
    // `terminal.kill` is scheduled `fifo`, and `selectJob` returns null for fifo rather than joining an identical
    // queued job.
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
  // The tombstone this close follows is also watched by `LandingTerminalTombstoneRecoveryBridge`, which sends
  // the close for any key it has not dispatched before.
  void requestLandingTerminalClose({
    hostId: closed.hostId,
    sessionId: closed.sessionId,
    close: () =>
      entry.mutations.close
        .mutateAsync({ hostId: closed.hostId, terminalId: closed.sessionId })
        .then(() => undefined),
  })
    .then((outcome) => {
      // The coordinator keys by the terminal's lifetime rather than by RPC, so this close can join an in-flight
      // `terminal.kill`, and that answers an already-gone session with `killed: false` data.
      if (!outcome.owned) return;
      useLandingTerminalStore
        .getState()
        .clearPendingKill(closed.hostId, closed.sessionId);
    })
    .catch(() => undefined);
}

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

// Matched against the resolved launch cwd (primary folder, else the settled context's home), not merely
// `target.primaryWorkspacePath`.
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
  const state = useLandingTerminalStore.getState();
  let instanceId: string | null;
  if (request.mode === "always-create") {
    instanceId = args.addTerminalTab(hostId, launchCwd);
  } else {
    const existing = terminalForTarget(
      state.tabs,
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
  // Surface the same recoverable state as an unusable target rather than consuming the selection silently - the
  // picker stays up and the choice can be remade.
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

/** It is a consumer of `LandingTerminalGestureProvider`: routing identity comes from its captured target, while
 * chooser presentation reads the provider's workspace source for that same captured draft. */
export function LandingTerminalPanel(): ReactNode {
  const {
    focusedLandingPageId,
    target,
    pending,
    pendingGeneration,
    openEpisodeDraftId,
    workspace,
    capture,
    selectWorkspacePath,
    clearPending,
  } = useLandingTerminalGesture();
  // Layout belongs to the focused start page. This is deliberately independent of `target`: a pending gesture
  // may retain an earlier page's host/folder routing while focus has already moved to another page.
  const landingPageId = focusedLandingPageId ?? UNBOUND_LANDING_PAGE_ID;
  const targetLandingPageId = target.draftId ?? UNBOUND_LANDING_PAGE_ID;
  const tabs = useLandingTerminalStore((state) => state.tabs);
  const [authorityEntries, setAuthorityEntries] =
    useState<LandingTerminalAuthorityEntries>({});
  const authorityHostIds = useMemo(
    () =>
      [...new Set([...tabs.map((tab) => tab.hostId), target.hostId])].filter(
        (hostId): hostId is string => hostId !== null,
      ),
    [tabs, target.hostId],
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
  const activeInstanceId = useLandingTerminalStore(
    (state) => state.activeInstanceId,
  );
  const layout = useLandingTerminalStore((state) =>
    landingTerminalLayoutFor(state, landingPageId),
  );
  const panelOpen = layout.panelOpen;
  const targetPanelOpen = useLandingTerminalStore(
    (state) => landingTerminalLayoutFor(state, targetLandingPageId).panelOpen,
  );
  const panelWidthFraction = layout.panelWidthFraction;
  const setPanelOpenForPage = useLandingTerminalStore(
    (state) => state.setPanelOpen,
  );
  const setPanelWidthFractionForPage = useLandingTerminalStore(
    (state) => state.setPanelWidthFraction,
  );
  const setPanelMaximizedForPage = useLandingTerminalStore(
    (state) => state.setPanelMaximized,
  );
  const addTab = useLandingTerminalStore((state) => state.addTab);
  const activateTab = useLandingTerminalStore((state) => state.activateTab);
  const renameTab = useLandingTerminalStore((state) => state.renameTab);
  const closeTab = useLandingTerminalStore((state) => state.closeTab);
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

  // Skipping the request rather than the endpoint's focus is what keeps the coordinator's bookkeeping honest -
  // an intent no endpoint will ever satisfy would stay pending.
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

  // `null` means "not created": the host's authority is not ready, and a tab written now would be
  // indistinguishable from legacy evidence.
  const addTerminalTab = useCallback(
    (hostId: string, cwd: string): string | null => {
      const authority = authorityEntries[hostId];
      if (!landingTerminalAuthorityReady(authority)) return null;
      const instanceId = `landing-terminal-${uuidv4()}`;
      addTab({
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
      });
      return instanceId;
    },
    [addTab, authorityEntries],
  );

  // Re-read the routing client's active host at invocation time.
  const createTerminalTab = useCallback(
    (routing: LandingTerminalTarget): string | null => {
      if (routing.hostId === null || routing.availability !== "supported") {
        return null;
      }
      // Fail-closed: no host client (a gesture that could not pin one) means we cannot reconcile the terminal, so we
      // do not create it. In non-gesture operation the target carries the default client, so this never blocks.
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

  // If already open, it is just a `+` - create against the effective target, never re-capturing.
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
    if (instanceId !== null) focusTerminalInstance(instanceId);
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

  const activateTerminalTab = useCallback(
    (instanceId: string) => {
      replaceDirectoryRequest(null);
      clearPending();
      activateTab(instanceId);
      focusTerminalInstance(instanceId);
    },
    [activateTab, clearPending, replaceDirectoryRequest],
  );

  // Focus follows the open/collapse *transition*, never the mount: a landing page that mounts with the panel
  // already open (new tab, tab switch back) must leave focus with the composer.
  const previousPanelLayoutRef = useRef({ landingPageId, panelOpen });
  useEffect(() => {
    const previous = previousPanelLayoutRef.current;
    previousPanelLayoutRef.current = { landingPageId, panelOpen };
    const store = useLandingTerminalStore.getState();
    if (previous.landingPageId !== landingPageId) {
      clearPendingTerminalFocus(null);
      // A reveal written for the page just left has had its transition there or never will; left standing it would
      // suppress this page's next real gesture.
      store.clearPanelReveal();
      return;
    }
    const wasOpen = previous.panelOpen;
    if (wasOpen === panelOpen) return;
    if (panelOpen) {
      const openActiveInstanceId = store.activeInstanceId;
      // Settling it as one re-targets the launch cwd, which a host-created sign-in tab (display-only `"~"`) never
      // matches - so it would spawn a bare shell over the tab the open was for.
      const revealed =
        store.panelReveal !== null &&
        store.panelReveal === openActiveInstanceId;
      store.clearPanelReveal();
      if (!pending && !revealed) capture();
      if (
        openActiveInstanceId !== null &&
        directoryRequestRef.current === null
      ) {
        focusTerminalInstance(openActiveInstanceId);
      }
      return;
    }
    // A reveal that found the panel already open never saw a transition; it retires here so the next open - a real
    // gesture - is settled as one.
    store.clearPanelReveal();
    clearPendingTerminalFocus(null);
    focusActiveComposer();
  }, [capture, landingPageId, panelOpen, pending]);
  useEffect(
    () => () => {
      clearPendingTerminalFocus(null);
    },
    [],
  );

  // Runs after every settled reconciliation pass (the reconciliation key includes the open/closed bit, so every
  // panel-open transition lands here).
  const runReconciliationSettlement = useCallback(
    (generation: number, context: LandingTerminalHostContext) => {
      const state = useLandingTerminalStore.getState();
      if (!landingTerminalLayoutFor(state, targetLandingPageId).panelOpen) {
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
      // Clear it on every outcome below (spawn, reuse, no-op) so a later gesture projects live focus instead of this
      // stale snapshot, and `+`/workspace projection follow the newly focused draft after settling.
      const clearIfPending = (): void => {
        if (pending) clearPending();
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
      // Creation can be refused (the host's authority went unready between this generation's reconciliation and its
      // settlement), so the focus hand-off is conditional on a tab actually existing.
      const spawnAndFocus = (focus: boolean): void => {
        const created = addTerminalTab(context.hostId, launchCwd);
        if (focus && created !== null) focusTerminalInstance(created);
      };
      if (state.tabs.length === 0) {
        // A gesture spawns its captured draft; a gesture-less live settlement (post-clear, or a pre-opened panel whose
        // folder just arrived) only spawns while focus still rests on the opening draft.
        if (!pending && target.draftId !== openEpisodeDraftId) {
          clearIfPending();
          return;
        }
        spawnAndFocus(pending);
        clearIfPending();
        return;
      }
      if (!pending) return;
      const existing = terminalForTarget(
        state.tabs,
        state.activeInstanceId,
        context.hostId,
        launchCwd,
      );
      if (existing === undefined) {
        spawnAndFocus(true);
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
      openEpisodeDraftId,
      pending,
      pendingGeneration,
      replaceDirectoryRequest,
      target,
      targetLandingPageId,
    ],
  );

  // Held rather than dropped: the reconciliation key does not change on the way back, so a discarded settlement
  // would never be recomputed and a panel opened just before the switch would sit empty forever.
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
    landingPageId: targetLandingPageId,
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

  // Close is deliberately not here: it is tombstone-first, so it stays available for a host that cannot be asked
  // right now.
  const canRenameTab = useCallback(
    (tab: LandingTerminalTabRef): boolean =>
      // A provider-login tab is never renameable: `terminal.plain.rename` is the only rename there is here, and it
      // rejects for a manager-owned session that has no plain-terminal row.
      !isProviderLoginLandingTab(tab) &&
      landingTerminalAuthorityReady(authorityEntries[tab.hostId]),
    [authorityEntries],
  );

  // The dispatch is the fast path only; `dispatchLandingTerminalClose` documents who carries the kill otherwise.
  const closeTerminalTab = useCallback(
    (tab: LandingTerminalTabRef) => {
      replaceDirectoryRequest(null);
      clearPending();
      const authorityEntry = authorityEntries[tab.hostId];
      const closed = closeTab(landingPageId, tab.instanceId);
      if (closed === null) return;
      dispatchLandingTerminalClose({
        entry: authorityEntry,
        closed,
        killTerminal: killTerminalAsync,
      });
      // Closing a non-last tab promotes a surviving neighbor - keep the keyboard with the panel.
      const state = useLandingTerminalStore.getState();
      if (
        landingTerminalLayoutFor(state, landingPageId).panelOpen &&
        state.activeInstanceId !== null
      ) {
        focusTerminalInstance(state.activeInstanceId);
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

  const closeAllTerminalTabs = useCallback(() => {
    // An interruption mid-loop therefore leaves every tab either untouched or tombstoned, never removed without a
    // tombstone.
    replaceDirectoryRequest(null);
    clearPending();
    useLandingTerminalStore.getState().tabs.forEach(closeTerminalTab);
    clearPendingTerminalFocus(null);
    focusActiveComposer();
  }, [clearPending, closeTerminalTab, replaceDirectoryRequest]);

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
    const captured = capture();
    const request = directoryRequestFor(captured, "reuse-or-create", true);
    replaceDirectoryRequest(request);
    setPanelOpen(true);
    if (request === null) {
      const instanceId = useLandingTerminalStore.getState().activeInstanceId;
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

  // The `+` gate reads the effective target only: capability from the captured
  // host, fail-closed on an unpinned client, and the reconciled launch context.
  const { createEnabled, createDisabledReason } = landingTerminalCreateGate({
    panelOpen,
    availability: target.availability,
    hostId: target.hostId,
    primaryWorkspacePath: target.primaryWorkspacePath,
    clientReady: target.client !== null,
    reconciledContext,
    authority: targetAuthority,
  });

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
    for (const tab of tabs) {
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
  }, [authorityEntries, tabs]);

  // Several remote hosts can exist without a default selection. Read the captured verdict so a mid-gesture
  // switch to an unsupported host cannot unmount the panel (and destroy the captured host's reconciliation).
  const panelUnavailable =
    target.availability === "no-active-host" ||
    target.availability === "unsupported";

  const renameTerminalTab = (instanceId: string, name: string): void => {
    const tab = useLandingTerminalStore
      .getState()
      .tabs.find((entry) => entry.instanceId === instanceId);
    if (tab === undefined) return;
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
        onEntry={handleAuthorityEntry}
      />
      <LandingTerminalBoundHostReconciliationFleet
        landingPageId={landingPageId}
        selectedHostId={target.hostId}
        entries={authorityEntries}
      />
      {panelUnavailable ? null : (
        <LandingTerminalPanelContents
          landingPageId={landingPageId}
          tabs={tabs}
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
          onCreateTerminal={revealAndCreateTerminal}
          onRevealAndCreate={revealAndCreateTerminal}
          onSelectDirectory={selectDirectory}
          onCancelDirectoryPicker={cancelDirectoryRequest}
          onActivateTab={activateTerminalTab}
          onCloseTab={closeTerminalTab}
          onCloseAllTabs={closeAllTerminalTabs}
          onRenameTab={renameTerminalTab}
          canRenameTab={canRenameTab}
          authorityEntries={authorityEntries}
          terminalViewModels={terminalViewModels}
        />
      )}
    </>
  );
}

interface LandingTerminalPanelContentsProps {
  readonly landingPageId: string;
  readonly tabs: ReadonlyArray<LandingTerminalTabRef>;
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
  readonly onCreateTerminal: () => void;
  readonly onRevealAndCreate: () => void;
  readonly onSelectDirectory: (workspacePath: string) => void;
  readonly onCancelDirectoryPicker: () => void;
  readonly onActivateTab: (instanceId: string) => void;
  readonly onCloseTab: (tab: LandingTerminalTabRef) => void;
  readonly onCloseAllTabs: () => void;
  readonly onRenameTab: (instanceId: string, name: string) => void;
  readonly canRenameTab: (tab: LandingTerminalTabRef) => boolean;
  readonly authorityEntries: LandingTerminalAuthorityEntries;
  readonly terminalViewModels: Readonly<
    Partial<Record<string, PlainTerminalViewModel>>
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
  // The overlay geometry applies only while actually open: a closed panel physically collapses to the 0%-width
  // in-flow strip on every device rather than lingering as an invisible full-viewport layer.
  const isMobile = useIsMobileViewport();
  const fullOverlay = props.maximized || isMobile;
  const overlayActive = fullOverlay && props.panelOpen;
  // Same touch-key treatment as the epic terminal tiles.
  const keyboardInset = useVirtualKeyboardInset();
  // Under the installed app's native-resize keyboard mode the measured inset stays 0 while the keyboard is up.
  const nativeKeyboardOpen = useNativeKeyboardOpen();
  const keyBarActive = isMobile && props.panelOpen;
  useLandingTerminalShortcuts({
    landingPageId: props.landingPageId,
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
  const panelStyle = landingTerminalPanelStyle({
    overlayActive,
    panelOpen: props.panelOpen,
    panelWidthFraction: props.panelWidthFraction,
    // Browser-only, like the epic tile view's padding: the installed app's shell already subtracts
    // `--keyboard-inset` in its safe-height tokens, so the measured inset would double the lift there.
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
      {/* Reveal-only affordance. On a phone it lives in the header's route-actions slot instead of floating in the
         content area, where it was the only element in an otherwise empty region with nothing to align to. */}
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
          // During a resize drag the global freeze class suspends it - otherwise every per-frame `style.width` write
          // eases over the default duration and the panel rubber-bands behind the pointer.
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
          activeInstanceId={
            props.directoryPicker === null ? props.activeInstanceId : null
          }
          createDisabledReason={props.createDisabledReason}
          onAdd={props.onCreateTerminal}
          onActivate={props.onActivateTab}
          onClose={props.onCloseTab}
          onCloseAll={props.onCloseAllTabs}
          onRename={props.onRenameTab}
          canRename={props.canRenameTab}
          terminalViewModels={props.terminalViewModels}
        />
        <LandingTerminalPanelBody
          landingPageId={props.landingPageId}
          tabs={props.tabs}
          activeInstanceId={props.activeInstanceId}
          availability={props.availability}
          panelOpen={props.panelOpen}
          activeHostId={props.activeHostId}
          createEnabled={props.createEnabled}
          primaryWorkspacePath={props.primaryWorkspacePath}
          reconciledContext={props.reconciledContext}
          directoryPicker={props.directoryPicker}
          onSelectDirectory={props.onSelectDirectory}
          onCancelDirectoryPicker={props.onCancelDirectoryPicker}
          authorityEntries={props.authorityEntries}
        />
        <LandingTerminalMobileKeyBar
          active={keyBarActive}
          instanceId={props.activeInstanceId}
          keyboardOpen={keyboardInset > 0 || nativeKeyboardOpen}
        />
      </aside>
    </>
  );
}

/** In-flow width for the docked split; in overlay mode (maximized / mobile) the panel is absolutely positioned
 * instead. */
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

/** `clientReady` is false when the host client cannot be pinned (fail-closed): the action stays disabled rather
 * than falling back to the live default client. */
function landingTerminalCreateDisabledReason(args: {
  readonly availability: LandingTerminalAvailability;
  readonly primaryWorkspacePath: string | null;
  readonly clientReady: boolean;
  readonly activeHostId: string | null;
  readonly reconciledContext: LandingTerminalHostContext | null;
  readonly authority: LandingTerminalAuthorityEntry | null;
}): string | null {
  if (!args.clientReady) return "Connecting to the selected host…";
  if (args.availability !== "supported") {
    return "Connecting to the selected host…";
  }
  // Same predicate `addTerminalTab` enforces, so the "+" cannot look live for
  // a host whose authority would refuse the create.
  if (!landingTerminalAuthorityReady(args.authority)) {
    return "Connecting to the selected host…";
  }
  if (args.primaryWorkspacePath !== null) return null;
  if (
    args.reconciledContext === null ||
    args.activeHostId === null ||
    args.reconciledContext.hostId !== args.activeHostId
  ) {
    return "Connecting to the selected host…";
  }
  if (args.reconciledContext.homeCwd === null) {
    return LANDING_TERMINAL_HOST_UPDATE_GUIDANCE;
  }
  return null;
}

/** The create gate, resolved once from either the captured opening-gesture snapshot or live focus (the caller
 * decides which by passing the effective values). */
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
  const createEnabled =
    args.panelOpen && args.hostId !== null && createDisabledReason === null;
  return { createEnabled, createDisabledReason };
}

/** The system-tab modal (Settings / History) is transparent to chord dispatch (it hosts its own leader scope),
 * so the terminal tab shortcuts gate themselves at dispatch time. */
function systemTabOverlayActive(): boolean {
  const api = getSystemTabModalApi();
  if (api === null) return false;
  return api.isOverlayActive("settings") || api.isOverlayActive("history");
}

/** Registered here (not in `LandingTerminalPanel`) so they exist exactly while the panel is a real affordance. */
function useLandingTerminalShortcuts(args: {
  readonly landingPageId: string;
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
    landingPageId,
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
  // The panel now outlives its start page's activation (it stays mounted while the page is merely retained, so
  // terminals survive a header-tab switch), but these registrations must not.
  const surfaceActive = useLandingTerminalSurfaceActive();
  useEffect(() => {
    if (!surfaceActive) return;
    return registerDynamicActionHandler("app.terminal.toggle", onTogglePanel);
  }, [onTogglePanel, surfaceActive]);
  // Reveal-and-create is one gesture in the panel: a collapsed panel captures the open gesture and creates from
  // that captured snapshot up-front (the non-empty set suppresses reconciliation's auto-spawn).
  useEffect(() => {
    if (!surfaceActive) return;
    return registerDynamicActionHandler("app.terminal.new", onRevealAndCreate);
  }, [onRevealAndCreate, surfaceActive]);
  useEffect(() => {
    if (!surfaceActive) return;
    return registerDynamicActionHandler("tab.new", () => {
      if (systemTabOverlayActive()) return;
      onRevealAndCreate();
    });
  }, [onRevealAndCreate, surfaceActive]);
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
      const state = useLandingTerminalStore.getState();
      if (!landingTerminalLayoutFor(state, landingPageId).panelOpen) return;
      const active = state.tabs.find(
        (tab) => tab.instanceId === state.activeInstanceId,
      );
      if (active === undefined) return;
      onCloseTab(active);
    });
  }, [landingPageId, onCloseTab, surfaceActive]);
  useEffect(() => {
    if (!surfaceActive) return;
    return registerDynamicActionHandler("tab.close-all", () => {
      if (systemTabOverlayActive()) return;
      const state = useLandingTerminalStore.getState();
      if (
        !landingTerminalLayoutFor(state, landingPageId).panelOpen ||
        state.tabs.length === 0
      ) {
        return;
      }
      onCloseAllTabs();
    });
  }, [landingPageId, onCloseAllTabs, surfaceActive]);
  const activateAdjacentTab = useCallback(
    (delta: 1 | -1) => {
      if (systemTabOverlayActive()) return;
      const state = useLandingTerminalStore.getState();
      if (
        !landingTerminalLayoutFor(state, landingPageId).panelOpen ||
        state.tabs.length < 2
      ) {
        return;
      }
      const index = state.tabs.findIndex(
        (tab) => tab.instanceId === state.activeInstanceId,
      );
      const count = state.tabs.length;
      const next = state.tabs[(Math.max(index, 0) + delta + count) % count];
      onActivateTab(next.instanceId);
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
            const state = useLandingTerminalStore.getState();
            return (
              landingTerminalLayoutFor(state, landingPageId).panelOpen &&
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
      aria-label="Open terminal panel"
      data-testid="landing-terminal-toggle"
      // Occupies exactly the box the header's collapse button renders in while the panel is open (1px panel border +
      // an icon-sm button centered in the h-9 header row, inset by the header's px-2).
      className="absolute top-[5px] right-2 z-10"
      onClick={props.onOpenPanel}
    >
      <PanelRightOpen className="size-4" />
    </Button>
  );
}

/** It carries collapse as well as reveal because the overlay is `absolute inset-0` inside the page container,
 * which sits below the app header. */
function LandingTerminalHeaderToggle(props: {
  readonly landingPageId: string;
}): ReactNode {
  const panelOpen = useLandingTerminalStore(
    (state) => landingTerminalLayoutFor(state, props.landingPageId).panelOpen,
  );
  const setPanelOpen = useLandingTerminalStore((state) => state.setPanelOpen);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={panelOpen ? "Collapse terminal panel" : "Open terminal panel"}
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

/** Registers the panel toggle in the mobile header's right-actions registry while the panel is mounted. */
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
    // Keyed and re-baked by the hosting landing page, so the entry both names and toggles the page that hosts the
    // panel - a hosting move retires the old page's entry with its own key before registering the new one.
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

/** Both of its controls are meaningless at phone width. */
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
  readonly landingPageId: string;
  readonly tabs: ReadonlyArray<LandingTerminalTabRef>;
  readonly activeInstanceId: string | null;
  readonly availability: LandingTerminalAvailability;
  readonly panelOpen: boolean;
  readonly activeHostId: string | null;
  readonly createEnabled: boolean;
  readonly primaryWorkspacePath: string | null;
  readonly reconciledContext: LandingTerminalHostContext | null;
  readonly directoryPicker: LandingTerminalDirectoryRequest | null;
  readonly onSelectDirectory: (workspacePath: string) => void;
  readonly onCancelDirectoryPicker: () => void;
  readonly authorityEntries: LandingTerminalAuthorityEntries;
}): ReactNode {
  if (props.availability === "unknown" && props.directoryPicker === null) {
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
      <div
        aria-hidden={props.directoryPicker !== null}
        className={cn(
          "contents",
          props.directoryPicker !== null && "invisible pointer-events-none",
        )}
      >
        {props.tabs.length === 0 ? (
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
              <LandingTerminalTile
                landingPageId={props.landingPageId}
                tab={tab}
                active={tab.instanceId === props.activeInstanceId}
                createEnabled={Boolean(
                  props.availability === "supported" &&
                  props.panelOpen &&
                  (props.createEnabled || tab.hostId !== props.activeHostId),
                )}
                authorityEntry={props.authorityEntries[tab.hostId] ?? null}
              />
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

function resolveLandingTerminalResizeContainer(
  handle: HTMLElement,
): HTMLElement | null {
  const parent = handle.parentElement;
  if (parent === null) return null;

  // That anchor preserves flex layout but has no box of its own, so its bounding rect is always zero-sized.
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
      args.setPanelWidthFraction(DEFAULT_LANDING_TERMINAL_PANEL_WIDTH_FRACTION);
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
    // An active-tab change while already open also lands here, including a delayed reconciliation that selects a
    // different terminal after reveal.
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
