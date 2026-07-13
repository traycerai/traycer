import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Maximize2,
  Minimize2,
  PanelRightClose,
  PanelRightOpen,
  TerminalSquare,
} from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import type { TerminalScope } from "@traycer/protocol/host/terminal/unary-schemas";
import { Button } from "@/components/ui/button";
import { useTerminalListFor } from "@/hooks/terminal/use-terminal-list-for-query";
import { useHostClient } from "@/lib/host";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import {
  pointerDragHandleAxisClassName,
  usePointerDragCommit,
} from "@/components/epic-canvas/canvas/use-pointer-drag-commit";
import { useHomeWorkspaceSource } from "@/components/home/host-workspace-selector/use-home-workspace-source";
import type { WorktreeStagingKey } from "@/stores/worktree/worktree-intent-staging-store";
import { workspaceFolderName } from "@/lib/worktree/workspace-folder-name";
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
import {
  resolveLandingTerminalAvailability,
  type LandingTerminalAvailability,
} from "./landing-terminal-availability";

const INDEPENDENT_SCOPE: TerminalScope = { kind: "independent" };

interface LandingTerminalDragState {
  readonly containerWidth: number;
  readonly startWidth: number;
  readonly minWidth: number;
  readonly maxWidth: number;
  readonly panel: HTMLElement;
  readonly initialWidth: string;
  latestFraction: number;
}

export interface LandingTerminalPanelProps {
  readonly draftId: string | null;
}

/**
 * Landing-only independent-terminal surface. The probe query is deliberately
 * both the capability gate and the ordered reconciliation input. The ordered
 * phase always forces and awaits its own current-host list fetch; cached query
 * data is UI state, never authoritative lifecycle input.
 */
export function LandingTerminalPanel(
  props: LandingTerminalPanelProps,
): ReactNode {
  const activeHostId = useReactiveActiveHostId();
  const defaultClient = useHostClient();
  const probe = useTerminalListFor(defaultClient, INDEPENDENT_SCOPE);
  const availability = resolveLandingTerminalAvailability(
    activeHostId,
    probe.data,
    probe.error,
  );
  const stagingKey = useMemo<WorktreeStagingKey>(
    () => ({ surface: "landing", draftId: props.draftId }),
    [props.draftId],
  );
  const workspace = useHomeWorkspaceSource(stagingKey, null);
  const primaryWorkspacePath = workspace.primaryWorkspacePath;
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
  const kill = useLandingTerminalKill();
  const killTerminal = kill.mutate;
  const killTerminalAsync = kill.mutateAsync;
  const [maximized, setMaximized] = useState(false);
  const [reconciledHostId, setReconciledHostId] = useState<string | null>(null);

  const createTerminalTab = useCallback(() => {
    if (activeHostId === null || primaryWorkspacePath === null) return;
    if (availability !== "supported") return;
    addTab({
      instanceId: `landing-terminal-${uuidv4()}`,
      sessionId: `landing-term-${uuidv4()}`,
      hostId: activeHostId,
      cwd: primaryWorkspacePath,
      name: workspaceFolderName(primaryWorkspacePath),
      titleSource: "default",
    });
  }, [activeHostId, addTab, availability, primaryWorkspacePath]);

  useLandingTerminalReconciliation({
    activeHostId,
    availability,
    panelOpen,
    primaryWorkspacePath,
    client: defaultClient,
    createTerminalTab,
    killTerminal: killTerminalAsync,
    onReconciled: setReconciledHostId,
  });

  const closeTerminalTab = useCallback(
    (tab: LandingTerminalTabRef) => {
      // `closeTab` is the atomic tombstone-first durable write. Dispatch the
      // host mutation only after that state transition has completed.
      const closed = closeTab(tab.instanceId);
      if (closed === null) return;
      killTerminal({ hostId: closed.hostId, sessionId: closed.sessionId });
    },
    [closeTab, killTerminal],
  );

  const togglePanel = useCallback(() => {
    if (panelOpen) {
      setMaximized(false);
      setPanelOpen(false);
      return;
    }
    setPanelOpen(true);
  }, [panelOpen, setPanelOpen]);

  // Several remote hosts can exist without a default selection. This is a
  // real page state, not an unsupported/unknown verdict: leave persistence
  // untouched and render no terminal affordance until one is selected.
  if (availability === "no-active-host" || availability === "unsupported") {
    return null;
  }

  return (
    <LandingTerminalPanelContents
      tabs={tabs}
      activeInstanceId={activeInstanceId}
      availability={availability}
      panelOpen={panelOpen}
      panelWidthFraction={panelWidthFraction}
      primaryWorkspacePath={primaryWorkspacePath}
      activeHostId={activeHostId}
      reconciledHostId={reconciledHostId}
      maximized={maximized}
      onTogglePanel={togglePanel}
      onToggleMaximized={() => setMaximized((value) => !value)}
      onSetPanelWidthFraction={setPanelWidthFraction}
      onCreateTerminal={createTerminalTab}
      onActivateTab={activateTab}
      onCloseTab={closeTerminalTab}
      onRenameTab={renameTab}
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
  readonly reconciledHostId: string | null;
  readonly maximized: boolean;
  readonly onTogglePanel: () => void;
  readonly onToggleMaximized: () => void;
  readonly onSetPanelWidthFraction: (fraction: number) => void;
  readonly onCreateTerminal: () => void;
  readonly onActivateTab: (instanceId: string) => void;
  readonly onCloseTab: (tab: LandingTerminalTabRef) => void;
  readonly onRenameTab: (instanceId: string, name: string) => void;
}

function LandingTerminalPanelContents(
  props: LandingTerminalPanelContentsProps,
): ReactNode {
  const sliderProps = useLandingTerminalPanelResize({
    panelWidthFraction: props.panelWidthFraction,
    setPanelWidthFraction: props.onSetPanelWidthFraction,
  });
  const canCreate =
    props.availability === "supported" && props.primaryWorkspacePath !== null;
  const createEnabled =
    props.panelOpen &&
    props.availability === "supported" &&
    props.activeHostId !== null &&
    props.reconciledHostId === props.activeHostId;
  const panelStyle = props.maximized
    ? undefined
    : { width: props.panelOpen ? `${props.panelWidthFraction * 100}%` : "0%" };

  return (
    <>
      <LandingTerminalPanelToggle
        panelOpen={props.panelOpen}
        onTogglePanel={props.onTogglePanel}
      />
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
          "flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-l border-canvas-border/70 bg-canvas transition-[width,visibility]",
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
          canCreate={canCreate}
          onAdd={props.onCreateTerminal}
          onActivate={props.onActivateTab}
          onClose={props.onCloseTab}
          onRename={props.onRenameTab}
        />
        <LandingTerminalPanelBody
          tabs={props.tabs}
          activeInstanceId={props.activeInstanceId}
          availability={props.availability}
          panelOpen={props.panelOpen}
          activeHostId={props.activeHostId}
          createEnabled={createEnabled}
          primaryWorkspacePath={props.primaryWorkspacePath}
        />
      </aside>
    </>
  );
}

function LandingTerminalPanelToggle(props: {
  readonly panelOpen: boolean;
  readonly onTogglePanel: () => void;
}): ReactNode {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={
        props.panelOpen ? "Collapse terminal panel" : "Open terminal panel"
      }
      data-testid="landing-terminal-toggle"
      className="absolute top-3 right-4 z-10"
      onClick={props.onTogglePanel}
    >
      {props.panelOpen ? (
        <PanelRightClose className="size-4" />
      ) : (
        <PanelRightOpen className="size-4" />
      )}
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
}): ReactNode {
  return (
    <div className="relative min-h-0 flex-1">
      {props.tabs.length === 0 ? (
        <LandingTerminalEmptyState
          availability={props.availability}
          primaryWorkspacePath={props.primaryWorkspacePath}
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
      {props.availability === "unknown" ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-canvas/85 p-6 text-center text-ui-sm text-muted-foreground">
          Connecting to the selected host…
        </div>
      ) : null}
    </div>
  );
}

function LandingTerminalEmptyState(props: {
  readonly availability: LandingTerminalAvailability;
  readonly primaryWorkspacePath: string | null;
}): ReactNode {
  const message = landingTerminalEmptyStateMessage(props);
  return (
    <div className="flex h-full min-h-0 items-center justify-center p-6 text-center text-ui-sm text-muted-foreground">
      {message}
    </div>
  );
}

function landingTerminalEmptyStateMessage(props: {
  readonly availability: LandingTerminalAvailability;
  readonly primaryWorkspacePath: string | null;
}): string {
  if (props.availability === "unknown") {
    return "Connecting to the selected host…";
  }
  if (props.primaryWorkspacePath === null) {
    return "Select a workspace to open a terminal";
  }
  return "Starting terminal…";
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
