import {
  selectionMatches,
  selectedCanvasBox,
  sameCanvasBox,
} from "./canvas-selection-refresh";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import type { CanvasBox, CanvasElement } from "@/lib/sandbox/canvas-bridge";
import {
  canvasSelectionCaptureRect,
  clipCanvasBox,
} from "./canvas-selection-geometry";
import {
  useCanvasSelectionStore,
  isCanvasBoardRoot,
  sameCanvasElement,
  type CanvasSelection,
} from "./canvas-selection-store";
import {
  CanvasSelectionAction,
  type CanvasAnnotationScope,
} from "./canvas-annotation-action";
import type { CanvasFrameRegistry } from "./canvas-frame-registry";

function canvasHoverBox(
  hovered: CanvasElement | null,
  selected: CanvasElement | null,
  dimensions: { width: number; height: number },
): CanvasBox | null {
  if (
    hovered === null ||
    (selected !== null && sameCanvasElement(selected, hovered))
  )
    return null;
  return clipCanvasBox(hovered.box, { x: 0, y: 0, ...dimensions });
}

function SelectionActionBar(props: {
  readonly frame: HTMLIFrameElement;
  readonly box: CanvasBox;
  /**
   * Painted invisible rather than unmounted: the Send to chat action inside
   * owns the capture in flight, and unmounting it would drop that mutation's
   * completion on the floor.
   */
  readonly hidden: boolean;
  readonly children: ReactNode;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const stage =
    props.frame.closest(".react-flow") ??
    props.frame.closest("[role=dialog]") ??
    props.frame.parentElement;
  useLayoutEffect(() => {
    if (stage === null) return;
    let animation = 0;
    const place = (): void => {
      const node = bar.current;
      if (node === null) return;
      const bounds = props.frame.getBoundingClientRect();
      const viewport = stage.getBoundingClientRect();
      const scaleX = bounds.width / (props.frame.clientWidth || 1);
      const scaleY = bounds.height / (props.frame.clientHeight || 1);
      const top = bounds.top + props.box.y * scaleY - viewport.top;
      const bottom = top + props.box.height * scaleY;
      node.style.maxWidth = `${Math.max(0, viewport.width - 16)}px`;
      const width = node.offsetWidth;
      const height = node.offsetHeight;
      node.style.left = `${Math.max(8, Math.min(bounds.left + props.box.x * scaleX - viewport.left, viewport.width - width - 8))}px`;
      node.style.top = `${top >= height + 8 ? top - height - 8 : bottom + 8}px`;
      animation = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(animation);
  }, [props.frame, props.box, stage]);
  if (stage === null) return null;
  return createPortal(
    <div
      ref={bar}
      data-canvas-selection-action=""
      className={cn(
        "canvas-nopan touch-auto absolute z-20 flex max-w-full items-start gap-1 rounded-md border bg-popover p-1 text-popover-foreground shadow-sm pointer-events-auto",
        props.hidden && "invisible",
      )}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {props.children}
    </div>,
    stage,
  );
}

function SelectionOutline(props: {
  readonly box: CanvasBox;
  readonly generated: boolean;
  readonly emphasized: boolean;
  readonly hideHandles: boolean | undefined;
}) {
  return (
    <div
      data-canvas-selection-outline=""
      className={cn(
        "absolute border border-primary",
        props.emphasized && "ring-1 ring-primary bg-primary/5",
      )}
      style={{
        left: props.box.x,
        top: props.box.y,
        width: props.box.width,
        height: props.box.height,
      }}
    >
      {!props.generated && !props.hideHandles
        ? [
            "-left-1 -top-1",
            "-right-1 -top-1",
            "-left-1 -bottom-1",
            "-right-1 -bottom-1",
          ].map((position) => (
            <span
              key={position}
              className={cn(
                "absolute size-2 border border-primary bg-background",
                position,
              )}
            />
          ))
        : null}
    </div>
  );
}

export function CanvasSelectionOverlay(props: {
  readonly controls?: ReactNode;
  readonly actionControls?: ReactNode;
  readonly hideAction?: boolean;
  /**
   * Paint the action bar invisible but keep it mounted: another surface is
   * offering the same actions for the moment, and the bar's send keeps state
   * worth coming back to (which chat it attached to).
   */
  readonly concealAction?: boolean;
  readonly commenting?: boolean;
  readonly hideHandles?: boolean;
  readonly scope: CanvasAnnotationScope;
  readonly boardPath: string;
  readonly registry: CanvasFrameRegistry;
  readonly onPick: (
    path: string,
    point: { x: number; y: number; additive?: boolean },
  ) => void;
  readonly onRetire: (path: string) => void;
  readonly onEscape: () => void;
  /** Shift+Enter on the shield; `null` where the selection cannot widen. */
  readonly onSelectParent: (() => void) | null;
}) {
  useSyncExternalStore(props.registry.subscribe, props.registry.getSnapshot);
  const entry = props.registry.get(props.boardPath);
  const selection = useCanvasSelectionStore((state) =>
    state.selection?.artifactId === props.scope.artifactId &&
    state.selection.boardPath === props.boardPath
      ? state.selection
      : null,
  );
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const additional = useCanvasSelectionStore(
    (state) => state.additionalElements,
  );
  const capturing = useCanvasSelectionStore((state) => state.capturing);
  const multiple = selection !== null && additional.length > 0;
  const gesture = useRef<{
    x: number;
    y: number;
    additive: boolean;
    start: { x: number; y: number };
    textDrag: boolean;
  } | null>(null);
  const [pointerDown, setPointerDown] = useState(false);
  const [hovered, setHovered] = useState<CanvasElement | null>(null);
  const hoverRequest = useRef({ time: 0, pending: false, generation: 0 });
  const frame = entry.frame;
  const bridge = entry.bridge;
  const { onRetire, boardPath } = props;
  useEffect(
    () => () => {
      onRetire(boardPath);
    },
    [onRetire, boardPath],
  );
  const hasSelection = selection !== null;
  const marker = selection?.element.marker;
  const tid = selection?.element.tid;
  useEffect(() => {
    if (!hasSelection) return;
    const down = (event: PointerEvent): void => {
      if (
        event.target instanceof Element &&
        event.target.closest(
          "[data-canvas-selection-action],[data-radix-popper-content-wrapper]",
        )
      )
        return;
      setPointerDown(true);
    };
    const up = (): void => setPointerDown(false);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    window.addEventListener("blur", up);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      window.removeEventListener("blur", up);
    };
  }, [hasSelection]);
  useEffect(() => {
    if (frame === null) return;
    const resize = (): void =>
      setDimensions({ width: frame.clientWidth, height: frame.clientHeight });
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [frame]);
  useEffect(() => {
    if (bridge === null || marker === undefined || tid === undefined) return;
    let active = true;
    let pending = false;
    const refresh = async (): Promise<void> => {
      if (pending) return;
      const current = useCanvasSelectionStore.getState().selection;
      if (
        !selectionMatches(current, {
          artifactId: props.scope.artifactId,
          boardPath: props.boardPath,
          marker,
          tid,
        })
      )
        return;
      pending = true;
      try {
        const box = await selectedCanvasBox(bridge, current.element);
        if (!active || props.registry.get(props.boardPath).bridge !== bridge)
          return;
        if (box === null) {
          if (tid === null) useCanvasSelectionStore.getState().clear();
          return;
        }
        if (!sameCanvasBox(box, current.element.box)) {
          useCanvasSelectionStore
            .getState()
            .updateElement(
              current.artifactId,
              current.boardPath,
              current.element.marker,
              { ...current.element, box },
            );
        }
      } catch {
        /* A replaced or disposed frame will be registered again. */
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 250);
    const layoutChanged = (): void => {
      void refresh();
    };
    window.addEventListener("resize", layoutChanged);
    window.addEventListener("scroll", layoutChanged, true);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("resize", layoutChanged);
      window.removeEventListener("scroll", layoutChanged, true);
    };
    // Geometry updates must not restart the polling clock.
  }, [
    bridge,
    props.registry,
    props.boardPath,
    props.scope.artifactId,
    marker,
    tid,
  ]);
  const box =
    selection === null
      ? null
      : clipCanvasBox(selection.element.box, { x: 0, y: 0, ...dimensions });
  const pointInFrame = (point: {
    clientX: number;
    clientY: number;
  }): { x: number; y: number } | null => {
    if (frame === null) return null;
    const bounds = frame.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return null;
    return {
      x: ((point.clientX - bounds.x) * frame.clientWidth) / bounds.width,
      y: ((point.clientY - bounds.y) * frame.clientHeight) / bounds.height,
    };
  };
  const hover = (point: { x: number; y: number }): void => {
    const state = hoverRequest.current;
    if (bridge === null || state.pending || performance.now() - state.time < 33)
      return;
    state.pending = true;
    state.time = performance.now();
    const generation = state.generation;
    void bridge
      .hitTest(point)
      .then((element) => {
        if (
          state.generation !== generation ||
          props.registry.get(props.boardPath).bridge !== bridge
        )
          return;
        setHovered(
          element === null || isCanvasBoardRoot(element) ? null : element,
        );
      })
      .catch(() => undefined)
      .finally(() => {
        state.pending = false;
      });
  };
  const hoverBox = canvasHoverBox(
    hovered,
    selection?.element ?? null,
    dimensions,
  );
  const captureRect = (): CanvasBox | null =>
    frame === null || box === null
      ? null
      : canvasSelectionCaptureRect(frame, box);
  return (
    <div
      // XYFlow captures Shift-pointerdown before our shields can receive it.
      // Its nokey opt-out leaves element selection with this overlay.
      className="nokey pointer-events-none absolute inset-0 z-10"
      data-canvas-selection-overlay=""
    >
      <div
        role="presentation"
        className={cn(
          "absolute inset-0 touch-auto [&]:pointer-events-auto",
          props.commenting && "cursor-crosshair",
        )}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.defaultPrevented) return;
          if (event.key === "Escape") {
            // The node wrapper would otherwise deselect the board before the
            // provider can clear just the element on the first Escape.
            event.preventDefault();
            event.stopPropagation();
            props.onEscape();
            return;
          }
          // Shift+Enter widens the selection to the parent element, as design
          // tools do. There is no visible control for it: the hit test picks
          // the deepest element, and this is the quiet way up.
          if (
            event.key === "Enter" &&
            event.shiftKey &&
            selection !== null &&
            props.onSelectParent !== null
          ) {
            event.preventDefault();
            event.stopPropagation();
            props.onSelectParent();
          }
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const start = pointInFrame(event);
          if (start === null) return;
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          if (selection !== null && !props.commenting)
            void bridge?.selectTextRange({ start, end: start });
          setPointerDown(true);
          setHovered(null);
          hoverRequest.current.generation++;
          gesture.current = {
            x: event.clientX,
            y: event.clientY,
            additive: !props.commenting && event.shiftKey,
            start,
            textDrag:
              !props.commenting &&
              !event.shiftKey &&
              !multiple &&
              box !== null &&
              start.x >= box.x &&
              start.x <= box.x + box.width &&
              start.y >= box.y &&
              start.y <= box.y + box.height,
          };
        }}
        onPointerMove={(event) => {
          const point = pointInFrame(event);
          if (point === null) return;
          const start = gesture.current;
          if (start === null) hover(point);
          else if (
            start.textDrag &&
            Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4
          )
            void bridge?.selectTextRange({ start: start.start, end: point });
        }}
        onPointerLeave={() => {
          hoverRequest.current.generation++;
          setHovered(null);
        }}
        onPointerCancel={() => {
          gesture.current = null;
          setPointerDown(false);
        }}
        onLostPointerCapture={() => {
          gesture.current = null;
          setPointerDown(false);
        }}
        onPointerUp={(event) => {
          const start = gesture.current;
          gesture.current = null;
          setPointerDown(false);
          const point = pointInFrame(event);
          if (start === null || point === null) return;
          if (
            Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4
          ) {
            if (start.textDrag)
              void bridge?.selectTextRange({ start: start.start, end: point });
            return;
          }
          props.onPick(props.boardPath, {
            ...point,
            ...(start.additive ? { additive: true } : {}),
          });
        }}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const point = pointInFrame(event);
          if (point !== null && !props.commenting) void bridge?.retypeAt(point);
        }}
      />
      {hoverBox === null || pointerDown || capturing ? null : (
        <SelectionOutline
          box={hoverBox}
          generated={false}
          emphasized={false}
          hideHandles
        />
      )}
      <CanvasSelectionPaint
        selection={selection}
        box={box}
        frame={frame}
        // A press while the bar is concealed is the user working in the
        // surface standing in for it (typing in the draft box, pressing its
        // buttons); the bar is already out of sight, and unmounting it would
        // drop the chat its send remembers.
        hideAction={
          Boolean(props.hideAction) || (pointerDown && !props.concealAction)
        }
        concealAction={Boolean(props.concealAction)}
        hideHandles={props.hideHandles}
        capturing={capturing}
        scope={props.scope}
        actionControls={props.actionControls}
        captureRect={captureRect}
      />
      {capturing ? null : props.controls}
    </div>
  );
}

function CanvasSelectionPaint(props: {
  readonly selection: CanvasSelection | null;
  readonly box: CanvasBox | null;
  readonly frame: HTMLIFrameElement | null;
  readonly hideAction: boolean;
  readonly concealAction: boolean;
  readonly hideHandles: boolean | undefined;
  readonly capturing: boolean;
  readonly scope: CanvasAnnotationScope;
  readonly actionControls: ReactNode;
  readonly captureRect: () => CanvasBox | null;
}) {
  return props.selection !== null && props.box !== null ? (
    <>
      {props.capturing
        ? null
        : props.selection.textRange?.rects.map((rect) => (
            <div
              key={`${rect.x}:${rect.y}:${rect.width}:${rect.height}`}
              className="absolute bg-primary/20"
              style={{
                left: rect.x,
                top: rect.y,
                width: rect.width,
                height: rect.height,
              }}
            />
          ))}
      {props.capturing ? null : (
        <SelectionOutline
          box={props.box}
          generated={props.selection.element.generated}
          emphasized
          hideHandles={props.hideHandles}
        />
      )}
      {props.hideAction || props.frame === null ? null : (
        <SelectionActionBar
          frame={props.frame}
          box={props.box}
          hidden={props.capturing || props.concealAction}
        >
          {props.actionControls}
          <CanvasSelectionAction
            key={`${props.selection.servedSha256}:${props.selection.element.marker ?? props.selection.element.selector}:${props.selection.textRange?.start ?? ""}:${props.selection.textRange?.end ?? ""}`}
            scope={props.scope}
            selection={props.selection}
            captureRect={props.captureRect}
          />
        </SelectionActionBar>
      )}
    </>
  ) : null;
}
