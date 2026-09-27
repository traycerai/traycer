import { SidebarArtwork } from "@/components/layout/sidebar-artwork";
/**
 * Per-pane Epic sidebar. It is mounted beneath the same `EpicSessionProvider`
 * as its canvas, so split Epics retain independent sidebar/session ownership.
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
import { memo, useCallback, useMemo, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { ColumnEdgeContext } from "@/components/layout/column-edge-context";
import { SnapshotLoadingProvider } from "@/components/epic-canvas/snapshots/snapshot-loading-context";
import { useHeaderTabTitle } from "@/components/layout/tabs/header-tab-presentation";
import { PanelTaskHeaderBody } from "@/components/epic-canvas/sidebar/panel-task-header-body";
import { MonogramChip } from "@/components/layout/tabs/monogram-chip";
import {
  sideTabTileOf,
  tabAutoTint,
} from "@/components/layout/tabs/tab-identity";
import { useHeaderTabAppearance } from "@/hooks/appearance/use-header-tab-appearance";
import {
  useEpicSnapshotFetchError,
  useEpicSnapshotLoaded,
  useRegisteredEpicLocalHome,
  useRegisteredEpicPermissionRole,
  useRegisteredEpicTitleGenerating,
} from "@/lib/epic-selectors";
import {
  SIDE_TAB_TITLE_CLASS,
  SIDE_TAB_TITLE_INPUT_CLASS,
} from "@/components/layout/tabs/side-strip/side-strip-tokens";
import {
  useInlineRename,
  type InlineRename,
} from "@/hooks/ui/use-inline-rename";
import { isEditableRole } from "@/lib/epic-permissions";
import { getEpicSessionHandleHostClient } from "@/lib/registries/epic-session-registry";
import { reconcileAuthoritativeEpicTitleInCloudTaskCaches } from "@/lib/cloud-epic-tasks-query/cache";
import {
  settleDetachedEpicTitleCommit,
  settleEpicTitleWrite,
} from "@/lib/epic-title-write-settlement";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
import { useHeaderTabForRef } from "@/stores/tabs/use-header-tabs";
import { tabAppearance, type HeaderTab } from "@/stores/tabs/types";
import {
  GROUND_RESIZE_HANDLE_LINE_CLASS,
  pointerDragHandleAxisClassName,
  usePointerDragCommit,
} from "@/components/epic-canvas/canvas/use-pointer-drag-commit";
import type { EdgeSide } from "@/lib/layout/layout-arrangement";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import {
  DEFAULT_SIDEBAR_WIDTH_PX,
  MAX_SIDEBAR_WIDTH_PX,
  useLeftPanelStore,
  useMainPanelCollapsed,
  useMinSidebarWidthPx,
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
  readonly side: EdgeSide;
}

// Top-level activation rerenders every retained EpicSurface with new activity
// context values. The sidebar identity does not change, and its live inputs use
// context or component-owned store subscriptions that update through this memo.
export const EpicSidebarColumn = memo(function EpicSidebarColumn(
  props: EpicSidebarColumnProps,
): ReactNode {
  return (
    <EpicSidebarColumnBody
      epicId={props.epicId}
      tabId={props.tabId}
      side={props.side}
    />
  );
});

function EpicSidebarColumnBody(props: EpicSidebarColumnProps): ReactNode {
  const { epicId, tabId, side } = props;
  const mainCollapsed = useMainPanelCollapsed(tabId);
  const sessionReady = useMaybeOpenEpicHandle() !== null;
  const sidebarWidthPx = useSidebarWidthPx();
  // Widened past the persisted preference when this (or another open) tab's
  // rail currently needs more room than that - see bug #1's fix in
  // `sidebar-rail-width-store.ts`. The persisted value itself is untouched;
  // narrowing the rail's content (closing panels, another tab taking over)
  // lets the panel settle back to it without a second write.
  const minWidthPx = useMinSidebarWidthPx();
  const effectiveWidthPx = Math.max(sidebarWidthPx, minWidthPx);

  const collapsedRail = mainCollapsed ? (
    <div className="shrink-0 overflow-clip bg-background">
      <ColumnRail
        epicId={epicId}
        tabId={tabId}
        orientation="vertical"
        sessionReady={sessionReady}
      />
    </div>
  ) : null;

  const panel = (
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
      style={{ width: effectiveWidthPx }}
    >
      <SidebarArtwork />
      <SidebarProvider defaultOpen className="h-full min-h-0 w-full flex-col">
        {mainCollapsed ? null : (
          <>
            <ColumnRail
              epicId={epicId}
              tabId={tabId}
              orientation="horizontal"
              sessionReady={sessionReady}
            />
            <PanelTaskHeader epicId={epicId} tabId={tabId} />
          </>
        )}
        <SidebarKeybindingBridge tabId={tabId} />
        <div className="min-h-0 flex-1">
          {sessionReady ? (
            <SidebarSnapshotScope>
              <EpicLeftPanelHost key={epicId} epicId={epicId} tabId={tabId} />
            </SidebarSnapshotScope>
          ) : (
            <EpicLeftPanelLoadingHost
              key={epicId}
              epicId={epicId}
              tabId={tabId}
            />
          )}
        </div>
      </SidebarProvider>
    </div>
  );

  const handle = (
    <SidebarWidthResizeHandle side={side} hidden={mainCollapsed} />
  );

  return (
    <ColumnEdgeContext.Provider value={side}>
      {/* Fragment order is DOM order, never CSS `order`: the collapsed
          vertical rail has to sit at the PANE's outer edge, and the handle
          has to be adjacent to the panel on the side matching `side` so
          `SidebarWidthResizeHandle` can find it through a sibling lookup. */}
      {side === "right" ? (
        <>
          {handle}
          {panel}
          {collapsedRail}
        </>
      ) : (
        <>
          {collapsedRail}
          {panel}
          {handle}
        </>
      )}
    </ColumnEdgeContext.Provider>
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
 * The panel sheet's header (D12): the task's rail tile chip and its title, so
 * the panel says which task it belongs to. The chip is the strip's own, in
 * the tab colour or else the epic's auto tint (D11).
 */
export function PanelTaskHeader(props: {
  readonly epicId: string;
  readonly tabId: string;
}) {
  const tab = useHeaderTabAppearance(
    useHeaderTabForRef({ kind: "epic", id: props.tabId }),
  );
  if (tab === null) return null;
  return <PanelTaskHeaderRow epicId={props.epicId} tab={tab} />;
}

function PanelTaskHeaderRow(props: {
  readonly epicId: string;
  readonly tab: HeaderTab;
}) {
  const { resolvedTabName, displayName } = useHeaderTabTitle(props.tab);
  const rename = usePanelTaskTitleRename(props.epicId, resolvedTabName);
  const titleGenerating = useRegisteredEpicTitleGenerating(props.epicId);
  const appearance = tabAppearance(props.tab);
  const Icon = props.tab.icon;
  const tile = sideTabTileOf({
    appearance,
    title: resolvedTabName,
    titleGenerating,
    fallback: Icon === null ? null : <Icon className="size-3.5" />,
  });
  return (
    <PanelTaskHeaderBody
      testId="epic-sidebar-task-header"
      chip={
        <MonogramChip
          tile={tile}
          tint={appearance?.color ?? tabAutoTint(props.epicId)}
          tinted={tile.kind !== "generating"}
        />
      }
      title={displayName}
      titleEditor={
        rename.isEditing ? (
          <input
            {...rename.inputProps}
            aria-label="Edit task title"
            data-testid="epic-sidebar-task-header-title-input"
            className={cn(
              SIDE_TAB_TITLE_INPUT_CLASS,
              SIDE_TAB_TITLE_CLASS,
              "font-semibold",
            )}
          />
        ) : null
      }
      titleAction={
        rename.canEdit ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Rename task"
            data-testid="epic-sidebar-task-header-rename"
            onClick={rename.startEditing}
          >
            <Pencil />
          </Button>
        ) : null
      }
    />
  );
}

/**
 * Inline rename for the panel's task title. The panel sits inside the task's
 * session, so the rename is that session's own write command - it reaches the
 * host serving the task, and the title overlay shows it at once - exactly as
 * the tab strip and the mobile header write it. The admission rule is theirs
 * too: an editable role, and a cloud verdict unless the task is local-homed.
 * `title` is the RAW title, so the "Untitled task" fallback is never seeded
 * into the input.
 */
function usePanelTaskTitleRename(
  epicId: string,
  title: string,
): InlineRename & { readonly canEdit: boolean } {
  const handle = useMaybeOpenEpicHandle();
  const queryClient = useQueryClient();
  const permissionRole = useRegisteredEpicPermissionRole(epicId);
  const localHome = useRegisteredEpicLocalHome(epicId);
  const cloudAuthorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const canEdit =
    handle !== null &&
    isEditableRole(permissionRole) &&
    (localHome || cloudAuthorized);
  const commit = useCallback(
    async (next: string) => {
      if (handle === null) return;
      // Re-checked at COMMIT: an edit opened before a demotion must not land
      // on the retained credential afterwards.
      if (
        !localHome &&
        !authorizesCloudCapability(useAuthStore.getState().status)
      ) {
        return;
      }
      const sessionClient = getEpicSessionHandleHostClient(handle);
      const hostId = sessionClient?.getActiveHostId() ?? null;
      const userId = sessionClient?.getRequestContextUserId() ?? null;
      const state = handle.store.getState();
      const commandId = await state.enqueueWriteCommand({
        kind: "update-epic-title",
        title: next,
        updatedAt: Date.now(),
      });
      if (commandId === null) return;
      settleEpicTitleWrite(state.waitForWriteCommand(commandId), {
        onCommitted: () => {
          if (userId === null) return;
          reconcileAuthoritativeEpicTitleInCloudTaskCaches(
            queryClient,
            { hostId, userId },
            epicId,
            next,
          );
        },
        source: "Epic panel header",
      });
    },
    [epicId, handle, localHome, queryClient],
  );
  const rename = useInlineRename({
    value: title,
    canEdit,
    onCommit: (next: string) => {
      settleDetachedEpicTitleCommit(commit(next), "Epic panel header");
    },
  });
  return { ...rename, canEdit };
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
  readonly minWidth: number;
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
 *
 * `side` decides which sibling is the panel (previous for a left sidebar,
 * next for a right one, matching the fragment order `EpicSidebarColumnBody`
 * renders) and negates the drag delta and the arrow nudge for a right
 * sidebar, so both read as "toward the canvas grows the panel" regardless
 * of which edge the canvas is on.
 */
export function SidebarWidthResizeHandle(props: {
  readonly side: EdgeSide;
  readonly hidden: boolean;
}) {
  const { side, hidden } = props;
  const sidebarWidthPx = useSidebarWidthPx();
  const minWidthPx = useMinSidebarWidthPx();
  const setSidebarWidthPx = useLeftPanelStore((s) => s.setSidebarWidthPx);
  const dragRef = useRef<SidebarDragState | null>(null);
  const sign = side === "right" ? -1 : 1;

  const sliderProps = usePointerDragCommit({
    axis: "horizontal",
    onDragStart: (event) => {
      const handle = event.currentTarget;
      const panelElement =
        side === "right"
          ? handle.nextElementSibling
          : handle.previousElementSibling;
      const container = handle.parentElement;
      if (!isSidebarPanelElement(panelElement) || container === null) {
        return false;
      }
      const containerWidth = container.getBoundingClientRect().width;
      if (containerWidth <= 0) return false;
      const startWidth = panelElement.getBoundingClientRect().width;
      dragRef.current = {
        startWidth,
        minWidth: minWidthPx,
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
        Math.max(drag.minWidth, drag.startWidth + deltaPx * sign),
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
        sidebarWidthPx + nudgeDirection * sign * KEYBOARD_RESIZE_STEP_PX,
      );
    },
  });

  return (
    <div
      {...sliderProps}
      aria-valuenow={Math.max(sidebarWidthPx, minWidthPx)}
      aria-valuemin={minWidthPx}
      aria-valuemax={MAX_SIDEBAR_WIDTH_PX}
      aria-label="Resize sidebar"
      data-testid="epic-sidebar-resize-handle"
      className={cn(
        "relative z-10 shrink-0 ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden",
        pointerDragHandleAxisClassName("horizontal"),
        GROUND_RESIZE_HANDLE_LINE_CLASS,
        "md:w-0",
        hidden && "hidden",
      )}
    />
  );
}
