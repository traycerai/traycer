import {
  selectionMatches,
  selectedCanvasBox,
  sameCanvasBox,
} from "./canvas-selection-refresh";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import type { CanvasBox } from "@/lib/sandbox/canvas-bridge";
import {
  canvasSelectionShields,
  clipCanvasBox,
  transformCanvasBox,
} from "./canvas-selection-geometry";
import {
  useCanvasSelectionStore,
  type CanvasSelection,
} from "./canvas-selection-store";
import {
  CanvasSelectionAction,
  type CanvasAnnotationScope,
} from "./canvas-annotation-action";
import type { CanvasFrameRegistry } from "./canvas-frame-registry";

function actionPosition(
  selection: CanvasSelection | null,
  box: CanvasBox | null,
): { x: number; y: number } {
  const anchor = selection?.textRange?.rects.at(0) ?? box;
  return {
    x: Math.max(0, anchor?.x ?? 0),
    y: Math.max(0, (anchor?.y ?? 0) - 38),
  };
}

export function CanvasSelectionOverlay(props: {
  readonly controls?: ReactNode;
  readonly actionControls?: ReactNode;
  readonly hideAction?: boolean;
  readonly scope: CanvasAnnotationScope;
  readonly boardPath: string;
  readonly registry: CanvasFrameRegistry;
  readonly onPick: (path: string, point: { x: number; y: number }) => void;
  readonly onRetire: (path: string) => void;
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
  const gesture = useRef<{ x: number; y: number } | null>(null);
  const frame = entry.frame;
  const bridge = entry.bridge;
  const { onRetire, boardPath } = props;
  useEffect(
    () => () => {
      onRetire(boardPath);
    },
    [onRetire, boardPath],
  );
  const marker = selection?.element.marker;
  const tid = selection?.element.tid;
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
  const position = actionPosition(selection, box);
  const shields = canvasSelectionShields(
    box,
    dimensions.width,
    dimensions.height,
  );
  const captureRect = (): CanvasBox | null => {
    if (
      frame === null ||
      box === null ||
      frame.clientWidth === 0 ||
      frame.clientHeight === 0
    )
      return null;
    const bounds = frame.getBoundingClientRect();
    const padded = clipCanvasBox(
      {
        x: box.x - 20,
        y: box.y - 20,
        width: box.width + 40,
        height: box.height + 40,
      },
      { x: 0, y: 0, width: frame.clientWidth, height: frame.clientHeight },
    );
    return padded === null
      ? null
      : clipCanvasBox(
          transformCanvasBox(padded, {
            x: bounds.x,
            y: bounds.y,
            scaleX: bounds.width / frame.clientWidth,
            scaleY: bounds.height / frame.clientHeight,
          }),
          { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
        );
  };
  return (
    <div
      className="pointer-events-none absolute inset-0 z-10"
      data-canvas-selection-overlay=""
    >
      {shields.map((shield) => (
        <div
          key={`${shield.x}:${shield.y}:${shield.width}:${shield.height}`}
          className="absolute [&]:pointer-events-auto"
          style={{
            left: shield.x,
            top: shield.y,
            width: shield.width,
            height: shield.height,
          }}
          onPointerDown={(event) => {
            gesture.current =
              event.button === 0 && !event.shiftKey
                ? { x: event.clientX, y: event.clientY }
                : null;
          }}
          onPointerUp={(event) => {
            const start = gesture.current;
            gesture.current = null;
            if (
              start === null ||
              frame === null ||
              Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4
            )
              return;
            const bounds = frame.getBoundingClientRect();
            if (bounds.width === 0 || bounds.height === 0) return;
            props.onPick(props.boardPath, {
              x:
                ((event.clientX - bounds.x) * frame.clientWidth) / bounds.width,
              y:
                ((event.clientY - bounds.y) * frame.clientHeight) /
                bounds.height,
            });
          }}
        />
      ))}
      {selection !== null && box !== null ? (
        <>
          {selection.textRange?.rects.map((rect) => (
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
          <div
            className="absolute border border-primary"
            style={{
              left: box.x,
              top: box.y,
              width: box.width,
              height: box.height,
            }}
          >
            {!selection.element.generated
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
          {props.hideAction ? null : (
            <div
              className="absolute z-20 flex max-w-full items-start gap-1 [&]:pointer-events-auto"
              style={{
                left: position.x,
                top: position.y,
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              {props.actionControls}
              {selection.element.generated ? (
                <div className="rounded bg-popover p-1 text-ui-xs text-popover-foreground">
                  Generated by a script, ask the agent
                </div>
              ) : null}
              <CanvasSelectionAction
                key={`${selection.servedSha256}:${selection.element.marker ?? selection.element.selector}:${selection.textRange?.start ?? ""}:${selection.textRange?.end ?? ""}`}
                scope={props.scope}
                selection={selection}
                captureRect={captureRect}
              />
            </div>
          )}
        </>
      ) : null}
      {props.controls}
    </div>
  );
}
