/**
 * The ONE app-level epic sidebar. Mounted by the `/epics` layout route as a
 * flex sibling of the keep-alive pane container, so the sidebar lives
 * OUTSIDE every pane: switching tabs re-projects this single instance
 * (panel host remounts per epic via `key`) instead of mounting one sidebar
 * per keep-alive pane.
 *
 * Session plumbing: `ActiveEpicSessionProvider` projects the live session
 * handle for the route's epic straight from the registry (read-only, no
 * refcount). Until the active pane's `EpicSessionProvider` has acquired the
 * session, the handle is null and the column renders the static rail +
 * loading host - the same fallback the per-pane `EpicSessionGate` used.
 *
 * Collapse is CSS-only for the panel column (`hidden`, stays mounted) so
 * expanding is instant and panel DOM/scroll state survives; nothing in the
 * canvas is touched, so the canvas can never remount from a collapse. The
 * rails still swap (vertical when collapsed, horizontal when expanded)
 * because both orientations register the same dnd-kit droppable ids and must
 * never be mounted together.
 *
 * Width is a single global persisted px value (`sidebarWidthPx`); the
 * resize handle mutates `style.width` per frame (zero React renders during
 * the drag) and commits once on pointer-up. The render-time `max-w-[50vw]`
 * cap matches the drag-time cap of half the layout row, so a persisted
 * width never starves the canvas on a small window.
 */
import { useMemo, useRef, type ReactNode } from "react";
import { SidebarProvider } from "@/components/ui/sidebar";
import {
  EpicLeftPanelHost,
  EpicLeftPanelLoadingHost,
} from "@/components/epic-canvas/sidebar/epic-sidebar";
import {
  EpicLeftPanelRail,
  EpicLeftPanelStaticRail,
} from "@/components/epic-canvas/sidebar/epic-sidebar-rail";
import { SidebarKeybindingBridge } from "@/components/epic-canvas/sidebar/sidebar-keybinding-bridge";
import { SnapshotLoadingProvider } from "@/components/epic-canvas/snapshots/snapshot-loading-context";
import {
  useEpicSnapshotFetchError,
  useEpicSnapshotLoaded,
} from "@/lib/epic-selectors";
import {
  pointerDragHandleAxisClassName,
  usePointerDragCommit,
} from "@/components/epic-canvas/canvas/use-pointer-drag-commit";
import { ActiveEpicSessionProvider } from "@/providers/active-epic-session-provider";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import {
  DEFAULT_SIDEBAR_WIDTH_PX,
  MAX_SIDEBAR_WIDTH_PX,
  MIN_SIDEBAR_WIDTH_PX,
  useLeftPanelStore,
  useMainPanelCollapsed,
  useSidebarWidthPx,
} from "@/stores/epics/left-panel-store";
import { cn } from "@/lib/utils";

/**
 * Live drag additionally caps the sidebar at half the layout row so the
 * canvas always keeps space; the render-time `50vw` cap mirrors it (the row
 * spans the viewport under the header).
 */
const MAX_SIDEBAR_DRAG_FRACTION = 0.5;
const KEYBOARD_RESIZE_STEP_PX = 24;

export interface EpicSidebarColumnProps {
  readonly epicId: string;
  readonly tabId: string;
}

export function EpicSidebarColumn(props: EpicSidebarColumnProps): ReactNode {
  return (
    <ActiveEpicSessionProvider epicId={props.epicId}>
      <EpicSidebarColumnBody epicId={props.epicId} tabId={props.tabId} />
    </ActiveEpicSessionProvider>
  );
}

function EpicSidebarColumnBody(props: EpicSidebarColumnProps): ReactNode {
  const { epicId, tabId } = props;
  const mainCollapsed = useMainPanelCollapsed(tabId);
  const sessionReady = useMaybeOpenEpicHandle() !== null;
  const sidebarWidthPx = useSidebarWidthPx();

  return (
    <>
      {mainCollapsed ? (
        <ColumnRail
          epicId={epicId}
          tabId={tabId}
          orientation="vertical"
          sessionReady={sessionReady}
        />
      ) : null}
      <div
        data-epic-sidebar-panel
        data-testid="epic-sidebar-column"
        data-epic-id={epicId}
        data-collapsed={mainCollapsed ? "true" : "false"}
        data-session-ready={sessionReady ? "true" : "false"}
        className={cn(
          "flex h-full min-h-0 max-w-[50vw] shrink-0 flex-col overflow-hidden bg-background",
          mainCollapsed && "hidden",
        )}
        style={{ width: sidebarWidthPx }}
      >
        <SidebarProvider defaultOpen className="h-full min-h-0 w-full flex-col">
          {mainCollapsed ? null : (
            <ColumnRail
              epicId={epicId}
              tabId={tabId}
              orientation="horizontal"
              sessionReady={sessionReady}
            />
          )}
          <SidebarKeybindingBridge tabId={tabId} />
          <div className="min-h-0 flex-1">
            {sessionReady ? (
              <SidebarSnapshotScope>
                <EpicLeftPanelHost
                  key={epicId}
                  epicId={epicId}
                  tabId={tabId}
                  side={undefined}
                />
              </SidebarSnapshotScope>
            ) : (
              <EpicLeftPanelLoadingHost
                key={epicId}
                epicId={epicId}
                tabId={tabId}
                side={undefined}
              />
            )}
          </div>
        </SidebarProvider>
      </div>
      <SidebarWidthResizeHandle hidden={mainCollapsed} />
    </>
  );
}

/**
 * Live rail when the session handle is available, static rail (no
 * session-bound selectors) while it is not - mirrors the old per-pane
 * `EpicSessionGate` rail fallback. The vertical and horizontal variants are
 * never mounted together: both register the same dnd-kit droppable ids.
 */
function ColumnRail(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly orientation: "vertical" | "horizontal";
  readonly sessionReady: boolean;
}) {
  if (props.sessionReady) {
    return (
      <EpicLeftPanelRail
        epicId={props.epicId}
        tabId={props.tabId}
        orientation={props.orientation}
      />
    );
  }
  return (
    <EpicLeftPanelStaticRail
      epicId={props.epicId}
      tabId={props.tabId}
      orientation={props.orientation}
    />
  );
}

/**
 * Panel bodies gate on snapshot state via `SnapshotGate`; this scope feeds
 * them the same context the canvas side provides in `epic-shell.tsx`. Only
 * rendered while the session handle is non-null (the selectors require it).
 */
function SidebarSnapshotScope(props: { readonly children: ReactNode }) {
  const snapshotLoaded = useEpicSnapshotLoaded();
  const snapshotFetchError = useEpicSnapshotFetchError();
  const value = useMemo(
    () => ({ snapshotLoaded, snapshotFetchError }),
    [snapshotLoaded, snapshotFetchError],
  );
  return (
    <SnapshotLoadingProvider value={value}>
      {props.children}
    </SnapshotLoadingProvider>
  );
}

interface SidebarDragState {
  readonly startWidth: number;
  readonly maxWidth: number;
  readonly panelElement: HTMLElement;
  /** Inline style string at drag start, restored on cancel. */
  readonly initialStyleWidth: string;
  latestWidth: number;
}

function isSidebarPanelElement(
  element: Element | null,
): element is HTMLElement {
  return (
    element instanceof HTMLElement &&
    element.dataset.epicSidebarPanel !== undefined
  );
}

/**
 * Custom sidebar-width handle on the shared `usePointerDragCommit` state
 * machine: per-frame direct `style.width` mutation on the panel element,
 * one store commit on release, `traycer-panel-resizing` freeze for the
 * drag's duration. Double-click resets to the default width; arrow keys
 * nudge by a fixed step (committed immediately). Cancel restores the
 * inline width string captured at drag start (the canvas handle instead
 * recomputes from its committed fractions).
 */
function SidebarWidthResizeHandle(props: { readonly hidden: boolean }) {
  const sidebarWidthPx = useSidebarWidthPx();
  const setSidebarWidthPx = useLeftPanelStore((s) => s.setSidebarWidthPx);
  const dragRef = useRef<SidebarDragState | null>(null);

  const sliderProps = usePointerDragCommit({
    axis: "horizontal",
    onDragStart: (event) => {
      const handle = event.currentTarget;
      const panelElement = handle.previousElementSibling;
      const container = handle.parentElement;
      if (!isSidebarPanelElement(panelElement) || container === null) {
        return false;
      }
      const containerWidth = container.getBoundingClientRect().width;
      if (containerWidth <= 0) return false;
      const startWidth = panelElement.getBoundingClientRect().width;
      dragRef.current = {
        startWidth,
        maxWidth: Math.min(
          MAX_SIDEBAR_WIDTH_PX,
          containerWidth * MAX_SIDEBAR_DRAG_FRACTION,
        ),
        panelElement,
        initialStyleWidth: panelElement.style.width,
        latestWidth: startWidth,
      };
      return true;
    },
    onDragFrame: (deltaPx) => {
      const drag = dragRef.current;
      if (drag === null) return;
      const nextWidth = Math.min(
        drag.maxWidth,
        Math.max(MIN_SIDEBAR_WIDTH_PX, drag.startWidth + deltaPx),
      );
      drag.latestWidth = nextWidth;
      // Direct DOM mutation - zero React renders while the pointer moves.
      drag.panelElement.style.width = `${nextWidth}px`;
    },
    onDragCommit: () => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag === null) return;
      setSidebarWidthPx(drag.latestWidth);
    },
    onDragCancel: () => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag === null) return;
      drag.panelElement.style.width = drag.initialStyleWidth;
    },
    onReset: () => {
      setSidebarWidthPx(DEFAULT_SIDEBAR_WIDTH_PX);
    },
    onKeyNudge: (nudgeDirection) => {
      setSidebarWidthPx(
        sidebarWidthPx + nudgeDirection * KEYBOARD_RESIZE_STEP_PX,
      );
    },
  });

  return (
    <div
      {...sliderProps}
      aria-valuenow={sidebarWidthPx}
      aria-valuemin={MIN_SIDEBAR_WIDTH_PX}
      aria-valuemax={MAX_SIDEBAR_WIDTH_PX}
      aria-label="Resize sidebar"
      data-testid="epic-sidebar-resize-handle"
      className={cn(
        "relative z-10 shrink-0 bg-background ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden",
        "before:pointer-events-none before:absolute before:left-0 before:top-10 before:bottom-0 before:w-2 before:rounded-tl-lg before:border-l before:border-transparent before:transition-colors before:content-[''] hover:before:border-border focus-visible:before:border-border",
        pointerDragHandleAxisClassName("horizontal"),
        props.hidden && "hidden",
      )}
    />
  );
}
