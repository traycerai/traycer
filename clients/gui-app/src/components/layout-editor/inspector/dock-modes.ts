import { useEffect, useState } from "react";
import {
  useLayoutEditorStore,
  type LayoutDockMode,
  type LayoutDockPosition,
} from "@/stores/layout/layout-editor-store";

/**
 * DevTools-style docking for the inspector (L-38, 5.4).
 *
 * `right` and `left` are flex order in the shell and need nothing here. This
 * module is the third mode: a panel the user picked up and put somewhere,
 * which is the one thing allowed to overlap the canvas because they chose it
 * and can move it again (the scoped exception to P3).
 *
 * The drag is the prototype's physical one (L-29): 1:1 from the grab point
 * with pointer capture, clamped to the window, and a release near either side
 * docks the panel to that side instead of leaving it floating over the thing
 * it is editing.
 */

/** Section 6's frozen float geometry. */
export const FLOAT_DOCK_WIDTH = 380;
const FLOAT_DOCK_MAX_HEIGHT = 560;
const FLOAT_DOCK_VIEWPORT_MARGIN = 92;
/** How close to a side edge a release has to land to dock there. */
export const DOCK_EDGE_SNAP_PX = 24;
/** Where the panel opens before it has ever been dragged. */
const FLOAT_DOCK_DEFAULT_INSET = 48;
/**
 * The strip along the top of the window the panel never covers: the app's own
 * chrome is up there, and a floating panel over it takes the title bar's drag
 * region with it. The prototype's `clampFloat` floor.
 */
const FLOAT_DOCK_TOP_INSET = 28;

export interface DockViewport {
  readonly width: number;
  readonly height: number;
}

export function floatDockHeight(viewportHeight: number): number {
  return Math.min(
    FLOAT_DOCK_MAX_HEIGHT,
    Math.max(0, viewportHeight - FLOAT_DOCK_VIEWPORT_MARGIN),
  );
}

/** Never off-screen, whatever window the position was remembered on. */
export function clampFloatPosition(
  position: LayoutDockPosition,
  viewport: DockViewport,
): LayoutDockPosition {
  const maxX = Math.max(0, viewport.width - FLOAT_DOCK_WIDTH);
  const maxY = Math.max(
    FLOAT_DOCK_TOP_INSET,
    viewport.height - floatDockHeight(viewport.height),
  );
  return {
    x: Math.min(Math.max(position.x, 0), maxX),
    y: Math.min(Math.max(position.y, FLOAT_DOCK_TOP_INSET), maxY),
  };
}

export function defaultFloatPosition(
  viewport: DockViewport,
): LayoutDockPosition {
  return clampFloatPosition(
    {
      x: viewport.width - FLOAT_DOCK_WIDTH - FLOAT_DOCK_DEFAULT_INSET,
      y: FLOAT_DOCK_DEFAULT_INSET,
    },
    viewport,
  );
}

/**
 * Where a float OPENS: the remembered position, or a floating one.
 *
 * The clamp above is a drag-time rule - it has to let the panel reach the snap
 * band, which is how a drag docks it - and a position remembered on a wider
 * window clamps flush against the side on a narrower one. That is what put the
 * panel exactly where the right dock sits, so choosing Float read as a no-op
 * until the user dragged it (LV2-17). A remembered position inside either
 * snap band is therefore not a floating position at all, and the panel opens
 * where an unremembered one does.
 */
export function restingFloatPosition(
  stored: LayoutDockPosition | null,
  viewport: DockViewport,
): LayoutDockPosition {
  if (stored === null) return defaultFloatPosition(viewport);
  const clamped = clampFloatPosition(stored, viewport);
  if (edgeSnapDockMode(clamped, viewport) !== null)
    return defaultFloatPosition(viewport);
  return clamped;
}

/**
 * The side a release docks to, or `null` to stay floating. Measured from the
 * panel's own edges, so a panel clamped flush against a side always snaps.
 */
export function edgeSnapDockMode(
  position: LayoutDockPosition,
  viewport: DockViewport,
): LayoutDockMode | null {
  if (position.x <= DOCK_EDGE_SNAP_PX) return "left";
  if (position.x + FLOAT_DOCK_WIDTH >= viewport.width - DOCK_EDGE_SNAP_PX)
    return "right";
  return null;
}

function readViewport(): DockViewport {
  return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * Drives a floating inspector: the resting position React renders, and the
 * header drag that moves it.
 *
 * During a drag the transform is written straight onto the node and the store
 * is left alone - a panel that re-rendered its whole tree on every pointer
 * move would not track the pointer, and the position only becomes a
 * preference once the user lets go.
 */
export function useFloatingDock(root: HTMLElement | null): LayoutDockPosition {
  const floating = useLayoutEditorStore((state) => state.dockMode === "float");
  const stored = useLayoutEditorStore((state) => state.floatPosition);
  const [viewport, setViewport] = useState<DockViewport>(readViewport);
  const [measuredFloating, setMeasuredFloating] = useState(floating);

  // Remeasured as the panel STARTS floating, during the render that begins it,
  // so the first floating frame is already clamped to the window as it is now.
  // Adjusted here rather than in an effect, which would be a cascading render
  // and paint one frame against a viewport the window may have left long ago.
  if (measuredFloating !== floating) {
    setMeasuredFloating(floating);
    if (floating) setViewport(readViewport());
  }

  // And the listener runs only while it floats: `position` is read nowhere
  // else, and this hook is called by the editor root in every window whether or
  // not the editor has ever been opened - one `resize` listener and one render
  // per resize event, for a number nothing draws.
  useEffect(() => {
    if (!floating) return;
    const onResize = (): void => {
      setViewport(readViewport());
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, [floating]);

  const position = restingFloatPosition(stored, viewport);

  useEffect(() => {
    if (!floating || root === null) return;
    // Both are read off the node at grab time, never off the render above: a
    // re-render mid-drag must not move the panel under the pointer.
    let grab: { readonly x: number; readonly y: number } | null = null;
    let origin: LayoutDockPosition = { x: 0, y: 0 };
    let latest: LayoutDockPosition = { x: 0, y: 0 };

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (
        !(target instanceof Element) ||
        target.closest("[data-layout-inspector-header]") === null
      )
        return;
      // A control in the header is a control, not a handle.
      if (target.closest("button, input, a") !== null) return;
      grab = { x: event.clientX, y: event.clientY };
      origin = readTransform(root);
      latest = origin;
      root.setPointerCapture(event.pointerId);
      root.setAttribute("data-dragging", "1");
      event.preventDefault();
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (grab === null) return;
      latest = clampFloatPosition(
        {
          x: origin.x + (event.clientX - grab.x),
          y: origin.y + (event.clientY - grab.y),
        },
        readViewport(),
      );
      writeTransform(root, latest);
    };

    const onPointerUp = (event: PointerEvent): void => {
      if (grab === null) return;
      grab = null;
      root.removeAttribute("data-dragging");
      if (root.hasPointerCapture(event.pointerId))
        root.releasePointerCapture(event.pointerId);
      const side = edgeSnapDockMode(latest, readViewport());
      if (side === null) {
        useLayoutEditorStore.getState().setFloatPosition(latest);
        return;
      }
      // The SIDE is the memory now. Leaving the snap coordinates behind is
      // what made the next Float open the panel flush against the edge it was
      // docked to, one pixel from snapping straight back (I-15).
      useLayoutEditorStore.getState().setFloatPosition(null);
      useLayoutEditorStore.getState().setDockMode(side);
    };

    root.addEventListener("pointerdown", onPointerDown);
    root.addEventListener("pointermove", onPointerMove);
    root.addEventListener("pointerup", onPointerUp);
    root.addEventListener("pointercancel", onPointerUp);
    return () => {
      root.removeEventListener("pointerdown", onPointerDown);
      root.removeEventListener("pointermove", onPointerMove);
      root.removeEventListener("pointerup", onPointerUp);
      root.removeEventListener("pointercancel", onPointerUp);
      root.removeAttribute("data-dragging");
    };
  }, [floating, root]);

  return position;
}

function writeTransform(node: HTMLElement, position: LayoutDockPosition): void {
  node.style.transform = `translate3d(${position.x}px, ${position.y}px, 0)`;
}

function readTransform(node: HTMLElement): LayoutDockPosition {
  const rect = node.getBoundingClientRect();
  return { x: rect.left, y: rect.top };
}
