import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type RefObject,
} from "react";
import type { ReactFlowInstance, Viewport } from "@xyflow/react";
import type { CanvasFlowNode } from "./canvas-node-context";
import {
  applyWheelStep,
  viewportLayerTransform,
  type CanvasWheelStep,
} from "./canvas-wheel";

/** How long a zoom gesture stays quiet before the canvas redraws at its scale. */
const ZOOM_COMMIT_QUIET_MS = 120;
/** How long any wheel gesture stays quiet before the live boards are picked again. */
const SETTLE_QUIET_MS = 200;

export interface CanvasWheelCamera {
  /** Takes one wheel event's move; the next animation frame applies it. */
  readonly push: (step: CanvasWheelStep) => void;
  /**
   * Another camera move takes over: hand React Flow the zoom the reader has
   * been shown, then forget where the wheel left the camera and stop the
   * settle it was waiting for.
   */
  readonly cancel: () => void;
  /** Whether a wheel gesture has yet to settle the live board set. */
  readonly settling: () => boolean;
  /**
   * React Flow reports each viewport it puts on screen, from the commit that
   * puts it there.
   */
  readonly onShown: (viewport: Viewport) => void;
}

/**
 * Wheel-driven camera moves, at most one per animation frame.
 *
 * A wheel or trackpad delivers events faster than the canvas can redraw.
 * Applying each event as it came left a gesture's events still being worked
 * through seconds after the fingers stopped. Here an event only joins a
 * queue, and one frame moves the camera once by everything queued.
 *
 * A zoom costs far more than a pan: every board is drawn again at the new
 * scale, and the canvas re-renders around it. So while a zoom gesture runs,
 * React Flow is not told at all. The frame only transforms `layerRef`, which
 * scales the pixels already drawn, and React Flow gets the final viewport
 * once the gesture has been quiet for {@link ZOOM_COMMIT_QUIET_MS}. The
 * layer lets go in the commit that draws that viewport, so nothing jumps.
 */
export function useCanvasWheelCamera({
  flow,
  stageRef,
  layerRef,
  suspended,
  onMove,
  onSettle,
}: {
  readonly flow: ReactFlowInstance<CanvasFlowNode> | null;
  readonly stageRef: RefObject<HTMLDivElement | null>;
  /** Wraps everything drawn in canvas coordinates; its origin is the stage's. */
  readonly layerRef: RefObject<HTMLDivElement | null>;
  /** Something else owns the viewport: queued moves are dropped unapplied. */
  readonly suspended: boolean;
  readonly onMove: (viewport: Viewport) => void;
  /** The gesture has been quiet long enough to pick the live boards again. */
  readonly onSettle: (viewport: Viewport) => void;
}): CanvasWheelCamera {
  const steps = useRef<CanvasWheelStep[]>([]);
  const frame = useRef<number | null>(null);
  const settleTimer = useRef<number | null>(null);
  const commitTimer = useRef<number | null>(null);
  // What React Flow has drawn. It trails the wheel by however long React
  // takes to render a viewport, which on a busy canvas is several frames.
  const shown = useRef<Viewport | null>(null);
  // Where the wheel has put the camera. A move computed from `shown` instead
  // would undo the moves still on their way to the screen.
  const camera = useRef<Viewport | null>(null);
  // A zoom gesture React Flow has not been told about yet.
  const zooming = useRef(false);
  // The viewport the layer is showing ahead of React Flow.
  const held = useRef<Viewport | null>(null);
  // Set once the wheel no longer owns the camera: whatever React Flow draws
  // next is the picture, whether or not it is the viewport the layer held.
  const releaseOnShown = useRef(false);

  const paintLayer = useCallback((): void => {
    const layer = layerRef.current;
    if (layer === null || shown.current === null || held.current === null)
      return;
    layer.style.transformOrigin = "0 0";
    // Keeps the layer's own pixels while it scales, instead of drawing them
    // again at every step.
    layer.style.willChange = "transform";
    layer.style.transform = viewportLayerTransform(shown.current, held.current);
  }, [layerRef]);
  const releaseLayer = useCallback((): void => {
    held.current = null;
    releaseOnShown.current = false;
    const layer = layerRef.current;
    if (layer === null) return;
    layer.style.transform = "";
    layer.style.willChange = "";
    layer.style.transformOrigin = "";
  }, [layerRef]);

  const applyQueued = useCallback((): void => {
    if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    frame.current = null;
    const queued = steps.current;
    steps.current = [];
    const stage = stageRef.current;
    const from = camera.current ?? shown.current;
    if (queued.length === 0 || stage === null || from === null) return;
    const bounds = stage.getBoundingClientRect();
    const stageOrigin = { x: bounds.left, y: bounds.top };
    camera.current = queued.reduce(
      (viewport, step) => applyWheelStep(viewport, step, stageOrigin),
      from,
    );
    if (queued.some((step) => step.kind === "zoom")) zooming.current = true;
  }, [stageRef]);
  const commit = useCallback((): void => {
    if (flow === null || camera.current === null) return;
    void flow.setViewport(camera.current);
    onMove(camera.current);
  }, [flow, onMove]);
  const commitZoom = useCallback((): void => {
    if (commitTimer.current !== null) window.clearTimeout(commitTimer.current);
    commitTimer.current = null;
    if (!zooming.current) return;
    zooming.current = false;
    held.current = camera.current;
    paintLayer();
    commit();
    // React Flow may have nothing to draw: the gesture came back to where it
    // began. Otherwise the layer waits for `onShown`.
    if (
      shown.current !== null &&
      held.current !== null &&
      sameViewport(shown.current, held.current)
    )
      releaseLayer();
  }, [commit, paintLayer, releaseLayer]);

  const onFrame = useCallback((): void => {
    frame.current = null;
    applyQueued();
    // Pans that join a zoom gesture ride the layer with it and are drawn in
    // the same commit; on their own they go straight to React Flow.
    if (!zooming.current) commit();
    if (zooming.current || held.current !== null) {
      held.current = camera.current;
      paintLayer();
    }
  }, [applyQueued, commit, paintLayer]);

  const dropQueued = useCallback((): void => {
    if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    frame.current = null;
    steps.current = [];
  }, []);
  const stopTimers = useCallback((): void => {
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    settleTimer.current = null;
    if (commitTimer.current !== null) window.clearTimeout(commitTimer.current);
    commitTimer.current = null;
  }, []);

  const cancel = useCallback((): void => {
    if (zooming.current) {
      applyQueued();
      commitZoom();
    }
    dropQueued();
    stopTimers();
    camera.current = null;
    if (held.current !== null) releaseOnShown.current = true;
  }, [applyQueued, commitZoom, dropQueued, stopTimers]);

  // Unmounting has no viewport left to hand over, and takes the layer along.
  useEffect(
    () => () => {
      dropQueued();
      stopTimers();
    },
    [dropQueued, stopTimers],
  );
  // A layout effect: the layer must let go in the commit that hands the
  // viewport to a fullscreen board, or that board is drawn through it.
  useLayoutEffect(() => {
    if (!suspended) return;
    dropQueued();
    if (commitTimer.current !== null) window.clearTimeout(commitTimer.current);
    commitTimer.current = null;
    // The zoom the reader saw is where the canvas returns to afterwards.
    if (zooming.current && camera.current !== null) onMove(camera.current);
    zooming.current = false;
    releaseLayer();
  }, [suspended, dropQueued, onMove, releaseLayer]);

  const push = useCallback(
    (step: CanvasWheelStep): void => {
      if (flow === null) return;
      steps.current.push(step);
      if (settleTimer.current !== null)
        window.clearTimeout(settleTimer.current);
      settleTimer.current = window.setTimeout(() => {
        settleTimer.current = null;
        // Timers can fire out of order under load; settle on what is shown.
        applyQueued();
        commitZoom();
        const settled = camera.current ?? shown.current;
        if (settled !== null) onSettle(settled);
      }, SETTLE_QUIET_MS);
      if (zooming.current || step.kind === "zoom") {
        if (commitTimer.current !== null)
          window.clearTimeout(commitTimer.current);
        commitTimer.current = window.setTimeout(() => {
          commitTimer.current = null;
          // A busy main thread can run this before the frame it was behind.
          applyQueued();
          commitZoom();
        }, ZOOM_COMMIT_QUIET_MS);
      }
      frame.current ??= window.requestAnimationFrame(onFrame);
    },
    [flow, applyQueued, commitZoom, onFrame, onSettle],
  );
  const settling = useCallback((): boolean => settleTimer.current !== null, []);
  const onShown = useCallback(
    (viewport: Viewport): void => {
      shown.current = viewport;
      // Once a gesture has settled, a viewport React Flow draws is no longer
      // the wheel's own move catching up: something else moved the camera.
      if (settleTimer.current === null && !zooming.current)
        camera.current = null;
      if (held.current === null) return;
      // Once the zoom is the one the layer held, React Flow has drawn it; a
      // pan still on its way shows up a frame later, as any pan does.
      const drawn =
        !zooming.current &&
        Math.abs(viewport.zoom - held.current.zoom) <= ZOOM_EPSILON;
      if (releaseOnShown.current || drawn) releaseLayer();
      else paintLayer();
    },
    [paintLayer, releaseLayer],
  );
  return { push, cancel, settling, onShown };
}

const ZOOM_EPSILON = 1e-9;

function sameViewport(a: Viewport, b: Viewport): boolean {
  return (
    Math.abs(a.zoom - b.zoom) <= ZOOM_EPSILON &&
    Math.abs(a.x - b.x) <= 1e-6 &&
    Math.abs(a.y - b.y) <= 1e-6
  );
}
