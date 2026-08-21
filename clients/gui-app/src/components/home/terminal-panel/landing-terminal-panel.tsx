import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
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
import { terminalSessionTitle } from "@/lib/terminals/terminal-title";
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
  landingTerminalLayoutFor,
  useLandingTerminalStore,
  type LandingTerminalTabRef,
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
import { useLandingTerminalKill } from "./use-landing-terminal-kill-mutation";
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
 * Whether this host's authority can back a tab mutation right now - the single
 * predicate behind create, close, close-all, and rename.
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
 */
function landingTerminalAuthorityReady(
  entry: LandingTerminalAuthorityEntry | null | undefined,
): entry is LandingTerminalAuthorityEntry {
  if (entry === null || entry === undefined) return false;
  const capability = entry.authority.capability;
  if (capability.status === "legacy") return true;
  return capability.status === "capable" && entry.authority.canMutate;
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
    openEpisodeDraftId,
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
  const killTerminal = kill.mutate;
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

  const replaceDirectoryRequest = useCallback(
    (request: LandingTerminalDirectoryRequest | null): void => {
      writeDirectoryRequest(request);
      if (request !== null && request.selectedTarget === null) {
        requestPrimaryFocus({
          kind: "landing-terminal-directory",
          requestId: request.key,
        });
      }
    },
    [writeDirectoryRequest],
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

  // Manual create paths: the routing target's primary folder, else the last
  // reconciled home for that target's still-active host. Never invents a path
  // or uses another host's home. Re-read the routing client's active host at
  // invocation time: keyboard handlers can fire after a host switch but before
  // React re-renders, so the captured `routing.hostId` alone is not enough to
  // satisfy the host-identity guardrail.
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
      requestPrimaryFocus({
        kind: "landing-terminal-directory",
        requestId: request.key,
      });
    },
    [replaceDirectoryRequest, selectWorkspacePath],
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
      requestPrimaryFocus({
        kind: "landing-terminal-directory",
        requestId: request.key,
      });
    }
  }, [writeDirectoryRequest]);

  const activateTerminalTab = useCallback(
    (instanceId: string) => {
      replaceDirectoryRequest(null);
      clearPending();
      activateTab(instanceId);
      focusTerminalInstance(instanceId);
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
    if (previous.landingPageId !== landingPageId) {
      clearPendingTerminalFocus(null);
      return;
    }
    const wasOpen = previous.panelOpen;
    if (wasOpen === panelOpen) return;
    if (panelOpen) {
      if (!pending) capture();
      const openActiveInstanceId =
        useLandingTerminalStore.getState().activeInstanceId;
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
  }, [capture, landingPageId, panelOpen, pending]);
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
      // Any pending gesture now matches this settled generation and is consumed
      // exactly once. Clear it on EVERY outcome below (spawn, reuse, no-op) so a
      // later gesture projects live focus instead of this stale snapshot, and
      // `+`/workspace projection follow the newly focused draft after settling.
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
      // Creation can be refused (the host's authority went unready between
      // this generation's reconciliation and its settlement), so the focus
      // hand-off is conditional on a tab actually existing.
      const spawnAndFocus = (focus: boolean): void => {
        const created = addTerminalTab(context.hostId, launchCwd);
        if (focus && created !== null) focusTerminalInstance(created);
      };
      if (state.tabs.length === 0) {
        // Empty-panel auto-spawn is pinned to the opening draft. A gesture
        // spawns its captured draft; a gesture-less live settlement (post-clear,
        // or a pre-opened panel whose folder just arrived) only spawns while
        // focus still rests on the opening draft, so switching drafts mid-flight
        // never spawns a terminal in the draft the user merely moved to.
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

  // One predicate for every tab mutation, so the affordance and the action it
  // fires can never disagree. Before this, close silently no-oped behind an
  // enabled button whenever authority was not ready, with nothing said.
  const canMutateTab = useCallback(
    (tab: LandingTerminalTabRef): boolean =>
      landingTerminalAuthorityReady(authorityEntries[tab.hostId]),
    [authorityEntries],
  );

  const closeTerminalTab = useCallback(
    (tab: LandingTerminalTabRef) => {
      replaceDirectoryRequest(null);
      clearPending();
      const authorityEntry = authorityEntries[tab.hostId];
      if (!landingTerminalAuthorityReady(authorityEntry)) return;
      const closed = closeTab(landingPageId, tab.instanceId);
      if (closed === null) return;
      if (authorityEntry.authority.capability.status === "capable") {
        void authorityEntry.mutations.close
          .mutateAsync({
            hostId: closed.hostId,
            terminalId: closed.sessionId,
          })
          .then(() => {
            useLandingTerminalStore
              .getState()
              .clearPendingKill(closed.hostId, closed.sessionId);
          })
          .catch(() => undefined);
      } else {
        killTerminal({ hostId: closed.hostId, sessionId: closed.sessionId });
      }
      // Closing a non-last tab promotes a surviving neighbor - keep the
      // keyboard with the panel. The last-tab case collapses the panel, and
      // the open-transition effect hands focus back to the composer instead.
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
      killTerminal,
      landingPageId,
      replaceDirectoryRequest,
    ],
  );

  const closeAllTerminalTabs = useCallback(() => {
    // Same tombstone-first ordering as a single close, batched: every ref is
    // durably tombstoned in one write before the first kill is dispatched.
    replaceDirectoryRequest(null);
    clearPending();
    const closable = useLandingTerminalStore
      .getState()
      .tabs.filter(canMutateTab);
    closable.forEach(closeTerminalTab);
    clearPendingTerminalFocus(null);
    focusActiveComposer();
  }, [canMutateTab, clearPending, closeTerminalTab, replaceDirectoryRequest]);

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

  // Several remote hosts can exist without a default selection. This is a
  // real page state, not an unsupported/unknown verdict: leave persistence
  // untouched and render no terminal affordance until one is selected. Read the
  // captured verdict so a mid-gesture switch to an unsupported host cannot
  // unmount the panel (and destroy the captured host's reconciliation).
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
          canRenameTab={canMutateTab}
          canCloseTab={canMutateTab}
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
  readonly canCloseTab: (tab: LandingTerminalTabRef) => boolean;
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
  const panelStyle = props.maximized
    ? undefined
    : { width: props.panelOpen ? `${props.panelWidthFraction * 100}%` : "0%" };
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
        ref={panelRef}
        data-landing-terminal-panel
        data-testid="landing-terminal-panel"
        data-open={props.panelOpen ? "true" : "false"}
        className={cn(
          "flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-t border-l border-canvas-border/70 bg-canvas",
          // The width transition exists for open/collapse only. During a
          // resize drag the global freeze class suspends it - otherwise every
          // per-frame `style.width` write eases over the default duration and
          // the panel rubber-bands behind the pointer.
          "[.traycer-panel-resizing_&]:transition-none",
          props.panelOpen
            ? "transition-[width]"
            : "invisible pointer-events-none transition-[width,visibility]",
          props.maximized && "absolute inset-0 z-20 w-full",
        )}
        style={panelStyle}
        onTransitionEnd={handlePanelTransitionEnd}
      >
        <LandingTerminalPanelHeader
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
          canClose={props.canCloseTab}
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
      </aside>
    </>
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
