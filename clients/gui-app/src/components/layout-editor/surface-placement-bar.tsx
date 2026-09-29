import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { RadioGroup, RadioGroupButtonItem } from "@/components/ui/radio-group";
import {
  PLACEMENT_EDGE_LABELS,
  SURFACE_PLACEMENT,
  surfaceColumnEdge,
  type PlacementEdge,
} from "@/components/layout-editor/canvas/surface-placement";
import { SegmentedControl } from "@/components/layout-editor/inspector/segmented-control";
import { SIDE_STRIP_VIEW_OPTIONS } from "@/components/layout-editor/regions/region-grammar";
import {
  ColumnEdgeContext,
  useColumnOverlayPlacement,
} from "@/components/layout/column-edge-context";
import { LAYOUT } from "@/components/settings/panels/layout-settings.definitions";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";
import { writeArrangementField } from "@/lib/layout/arrangement-gestures";
import type { EdgeSide, SideStripView } from "@/lib/layout/layout-arrangement";
import {
  useLayoutEditorStore,
  type PlacementSurfaceId,
} from "@/stores/layout/layout-editor-store";
import { useLayoutStore } from "@/stores/layout/layout-store";
import { useTitleBarDragSuppression } from "@/stores/layout/title-bar-drag-store";

/** Space between the surface and the bar, and between the bar and the window. */
const BAR_GAP = 8;

/**
 * The placement bar (D14): a small floating bar on the selected tab strip or
 * sidebar, with a pictogram per edge the surface can take - and, while the
 * strip is vertical, the View pair.
 *
 * Every button writes through the same writer as the dock's rows
 * (`writeArrangementField`), so each press is one recorded gesture, and it
 * honours the same availability. It is portalled to `<body>` because the
 * app column is behind the edit firewall, and it sits toward the content, the
 * side the overlay hook (ticket 01) names for the surface's edge.
 */
export function SurfacePlacementBar(): ReactNode {
  const surface = useLayoutEditorStore((state) => state.selectedSurface);
  const node = useLayoutEditorStore((state) =>
    state.selectedSurface === null
      ? null
      : (state.surfaceNodes.get(state.selectedSurface) ?? null),
  );
  const arrangement = useLayoutStore((state) => state.arrangement);
  const availability = useSettingsAvailabilityContext();
  // On a frameless desktop window the strip's empty space is a window drag
  // region, which the OS keeps from the renderer. A selected surface has to be
  // grabbable anywhere, so its drag regions stand down while it is selected.
  useTitleBarDragSuppression("layout-placement-surface", surface !== null);
  // Mounted through a gap in `node`: a placement write swaps the strip for
  // another element, and the registry is empty for the commit between the
  // two. Unmounting there would take a keyboard user's focus with it.
  if (surface === null) return null;
  const facts = SURFACE_PLACEMENT[surface];
  if (!facts.row.availableWhen(availability)) return null;
  const vertical =
    surface === "topBar" && arrangement.tabStripPlacement !== "top";
  const showView =
    vertical && LAYOUT.definitions.sideStripView.availableWhen(availability);
  return createPortal(
    <ColumnEdgeContext value={surfaceColumnEdge(surface, arrangement)}>
      <PlacementBarBody
        surface={surface}
        node={node}
        current={facts.current(arrangement)}
        view={showView ? arrangement.sideStripView : null}
      />
    </ColumnEdgeContext>,
    document.body,
  );
}

function PlacementBarBody(props: {
  readonly surface: PlacementSurfaceId;
  /** `null` between two elements of a swapped surface: the bar holds still. */
  readonly node: HTMLElement | null;
  readonly current: PlacementEdge;
  /** The strip's View, or `null` where the pair is not drawn. */
  readonly view: SideStripView | null;
}): ReactNode {
  const { surface, node, current, view } = props;
  const facts = SURFACE_PLACEMENT[surface];
  const placement = useColumnOverlayPlacement("top");
  const side = placement?.side ?? null;
  const barRef = useRef<HTMLDivElement | null>(null);

  // Before paint, so the bar never shows a frame at the window's corner.
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (bar === null || node === null) return;
    return followNode(bar, node, side);
  }, [node, side]);

  return (
    <div
      ref={barRef}
      data-layout-placement-bar={surface}
      role="group"
      aria-label={surface === "topBar" ? "Tabs placement" : "Sidebar placement"}
      className="pointer-events-none fixed top-0 left-0 flex items-center gap-1.5 rounded-lg border border-border bg-popover p-1 text-popover-foreground opacity-0 shadow-md data-placed:pointer-events-auto data-placed:opacity-100"
    >
      {/* A radio group: one Tab stop, arrows move and select. */}
      <RadioGroup
        aria-label={surface === "topBar" ? "Tabs position" : "Sidebar side"}
        value={current}
        onValueChange={(next) => {
          const edge = facts.edges.find((candidate) => candidate === next);
          if (edge !== undefined) facts.write(edge);
        }}
        variant="row"
      >
        {facts.edges.map((edge) => {
          const label = PLACEMENT_EDGE_LABELS[edge];
          return (
            <TooltipWrapper
              key={edge}
              label={label}
              side="bottom"
              sideOffset={undefined}
              align={undefined}
            >
              <RadioGroupButtonItem
                value={edge}
                render={
                  <Button
                    type="button"
                    aria-label={label}
                    data-placement-edge={edge}
                    variant="muted"
                    size="icon-sm"
                  >
                    <PlacementPictogram surface={surface} edge={edge} />
                  </Button>
                }
              />
            </TooltipWrapper>
          );
        })}
      </RadioGroup>
      {view === null ? null : (
        // Pointing at the view previews what it changes, as its row does.
        <span
          className="contents"
          onPointerEnter={() => {
            useLayoutEditorStore.getState().setHoveredSetting("sideStripView");
          }}
          onPointerLeave={() => {
            useLayoutEditorStore.getState().setHoveredSetting(null);
          }}
        >
          <SegmentedControl
            ariaLabel="Tabs view"
            options={SIDE_STRIP_VIEW_OPTIONS}
            value={view}
            disabled={false}
            onChange={(next) => {
              const option = SIDE_STRIP_VIEW_OPTIONS.find(
                (candidate) => candidate.value === next,
              );
              if (option !== undefined)
                writeArrangementField("sideStripView", option.value);
            }}
          />
        </span>
      )}
    </div>
  );
}

/**
 * A window with the surface drawn at one edge: a band across the top or down a
 * side for the tab strip, a narrow column beside the content for the sidebar.
 */
function PlacementPictogram(props: {
  readonly surface: PlacementSurfaceId;
  readonly edge: PlacementEdge;
}): ReactNode {
  const { surface, edge } = props;
  const band = surface === "topBar" ? 5 : 4;
  const rect =
    edge === "top"
      ? { x: 1, y: 1, width: 18, height: band }
      : { x: edge === "left" ? 1 : 19 - band, y: 1, width: band, height: 12 };
  return (
    <svg aria-hidden viewBox="0 0 20 14" className="h-3.5 w-5" fill="none">
      <rect
        x="0.5"
        y="0.5"
        width="19"
        height="13"
        rx="2"
        stroke="currentColor"
        strokeOpacity="0.6"
      />
      <rect {...rect} rx="1" fill="currentColor" />
    </svg>
  );
}

/**
 * Keep `bar` beside `node` for as long as it is mounted, re-reading the rect
 * every frame for the ring's reason (L-90): a placement write, a dock switch
 * and a float toggle all move the surface without resizing it. A frame on
 * which nothing moved writes nothing.
 */
function followNode(
  bar: HTMLElement,
  node: HTMLElement,
  side: EdgeSide | null,
): () => void {
  let frame = 0;
  let last = "";
  const tick = (): void => {
    frame = requestAnimationFrame(tick);
    const rect = node.getBoundingClientRect();
    const width = bar.offsetWidth;
    const height = bar.offsetHeight;
    let x = rect.left + rect.width / 2 - width / 2;
    let y = rect.bottom + BAR_GAP;
    if (side !== null) {
      x = side === "right" ? rect.right + BAR_GAP : rect.left - BAR_GAP - width;
      y = rect.top + BAR_GAP;
    }
    x = Math.min(Math.max(x, BAR_GAP), window.innerWidth - width - BAR_GAP);
    y = Math.min(Math.max(y, BAR_GAP), window.innerHeight - height - BAR_GAP);
    const transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px)`;
    if (transform === last) return;
    last = transform;
    bar.style.transform = transform;
    // Shown from its first placement on: never a frame at the window's
    // corner, and no hiding (which would drop focus) while a node is swapped.
    bar.dataset.placed = "1";
  };
  tick();
  return () => {
    cancelAnimationFrame(frame);
  };
}
