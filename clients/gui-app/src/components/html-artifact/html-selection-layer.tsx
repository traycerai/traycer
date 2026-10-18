import { useEffect, useRef, useState, type ReactNode } from "react";
import { SelectionOutline } from "@/components/canvas-artifact/canvas-selection-overlay";
import {
  canvasSelectionShields,
  clipCanvasBox,
} from "@/components/canvas-artifact/canvas-selection-geometry";
import {
  sameCanvasBox,
  selectedCanvasBox,
} from "@/components/canvas-artifact/canvas-selection-refresh";
import { Button } from "@/components/ui/button";
import type { SandboxBridgeHost } from "@/lib/sandbox/bridge-host";
import type {
  CanvasBox,
  CanvasElementLocator,
} from "@/lib/sandbox/canvas-bridge";
import {
  isHtmlSelectionClick,
  moveHtmlSelectionGesture,
  type HtmlSelectionGesture,
} from "./html-selection-gesture";
import {
  useHtmlSelectionStore,
  type HtmlSelection,
} from "./html-selection-store";

export interface HtmlSelectionLayerProps {
  readonly artifactId: string;
  readonly servedSha256: string | null;
  readonly frame: HTMLIFrameElement | null;
  /** Only the current document's ready bridge may answer selection requests. */
  readonly bridge: SandboxBridgeHost | null;
  readonly actionControls?: (selection: HtmlSelection) => ReactNode;
  readonly overlay?: ReactNode;
}

const EMPTY_ENTRY = { enabled: false, selection: null, generation: 0 };

function selectionElement(selection: HtmlSelection | null) {
  return selection === null || selection.kind === "page"
    ? null
    : selection.element;
}

function selectionTarget(
  marker: number | null | undefined,
  tid: string | null | undefined,
): CanvasElementLocator | null {
  if (tid !== null && tid !== undefined) return { tid };
  if (marker !== null && marker !== undefined) return { marker };
  return null;
}

function HtmlSelectionOutline({
  selection,
  box,
  dimensions,
}: {
  readonly selection: HtmlSelection | null;
  readonly box: CanvasBox | null;
  readonly dimensions: { readonly width: number; readonly height: number };
}) {
  if (selection === null || selection.kind === "page" || box === null)
    return null;
  return (
    <div data-html-selection-outline="">
      {selection.kind === "text"
        ? selection.range.rects.map((rect) => {
            const clipped = clipCanvasBox(rect, { x: 0, y: 0, ...dimensions });
            return clipped === null ? null : (
              <div
                key={`${rect.x}:${rect.y}:${rect.width}:${rect.height}`}
                className="absolute bg-primary/20"
                style={{
                  left: clipped.x,
                  top: clipped.y,
                  width: clipped.width,
                  height: clipped.height,
                }}
              />
            );
          })
        : null}
      <SelectionOutline
        box={box}
        generated={selection.element.generated}
        hideHandles
      />
    </div>
  );
}

function HtmlSelectionActions({
  selection,
  box,
  width,
  actionControls,
}: {
  readonly selection: HtmlSelection | null;
  readonly box: CanvasBox | null;
  readonly width: number;
  readonly actionControls: HtmlSelectionLayerProps["actionControls"];
}) {
  if (selection === null || actionControls === undefined) return null;
  if (selection.kind !== "page" && box === null) return null;
  const position =
    box === null
      ? { left: 0, top: 0 }
      : {
          right: Math.max(0, width - box.x - box.width),
          top: box.y < 38 ? 40 : box.y - 38,
        };
  return (
    <div
      className="absolute z-20 flex max-w-full items-start gap-1 [&]:pointer-events-auto"
      style={position}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {actionControls(selection)}
    </div>
  );
}

export function HtmlSelectionLayer({
  artifactId,
  servedSha256,
  frame,
  bridge,
  actionControls,
  overlay,
}: HtmlSelectionLayerProps) {
  const { enabled, selection, generation } =
    useHtmlSelectionStore((state) => state.byArtifact.get(artifactId)) ??
    EMPTY_ENTRY;
  const element = selectionElement(selection);
  const marker = element?.marker;
  const tid = element?.tid;
  const selector = element?.selector;
  const gesture = useRef<HtmlSelectionGesture | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  useEffect(
    () => () => {
      useHtmlSelectionStore.getState().setEnabled(artifactId, false);
    },
    [artifactId],
  );

  useEffect(() => {
    if (frame === null) return;
    const resize = (): void =>
      setDimensions({
        width: frame.clientWidth,
        height: frame.clientHeight,
      });
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [frame]);

  useEffect(() => {
    void bridge?.setMode(enabled ? "edit" : "play");
  }, [bridge, enabled]);

  useEffect(() => {
    const target = enabled ? selectionTarget(marker, tid) : null;
    void bridge?.setTextSelectionTarget(target);
  }, [bridge, enabled, marker, tid]);

  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent): void => {
      if (
        event.key !== "Escape" ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey
      )
        return;
      const target = event.target;
      // Frame shortcuts are replayed on the iframe itself. Do not consume
      // Escape from another tile or from a dialog opened over this one.
      if (
        target !== frame &&
        !(target instanceof Node && root.current?.contains(target))
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      gesture.current = null;
      useHtmlSelectionStore.getState().setEnabled(artifactId, false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [enabled, artifactId, frame]);

  useEffect(() => {
    if (bridge === null || !enabled || selector === undefined) return;
    let active = true;
    let pending = false;
    const refresh = async (): Promise<void> => {
      const current = useHtmlSelectionStore
        .getState()
        .byArtifact.get(artifactId);
      const selected = current?.selection ?? null;
      if (
        pending ||
        current?.generation !== generation ||
        selected === null ||
        selected.kind === "page"
      )
        return;
      pending = true;
      try {
        const nextBox = await selectedCanvasBox(bridge, selected.element);
        if (
          active &&
          (nextBox === null || !sameCanvasBox(selected.element.box, nextBox))
        )
          useHtmlSelectionStore
            .getState()
            .updateBox(artifactId, generation, nextBox);
      } catch {
        // A disposed frame will be registered again with a fresh selection.
      }
      pending = false;
    };
    const layoutChanged = (): void => {
      void refresh();
    };
    layoutChanged();
    const timer = window.setInterval(layoutChanged, 250);
    const observer = new ResizeObserver(layoutChanged);
    if (frame !== null) observer.observe(frame);
    window.addEventListener("resize", layoutChanged);
    window.addEventListener("scroll", layoutChanged, true);
    return () => {
      active = false;
      window.clearInterval(timer);
      observer.disconnect();
      window.removeEventListener("resize", layoutChanged);
      window.removeEventListener("scroll", layoutChanged, true);
    };
  }, [artifactId, bridge, enabled, frame, generation, marker, tid, selector]);

  const box =
    element === null
      ? null
      : clipCanvasBox(element.box, { x: 0, y: 0, ...dimensions });
  const shields = canvasSelectionShields(
    box,
    dimensions.width,
    dimensions.height,
  );
  const pick = async (clientX: number, clientY: number): Promise<void> => {
    if (frame === null || bridge === null) return;
    const bounds = frame.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return;
    const ticket = useHtmlSelectionStore.getState().beginPick(artifactId);
    if (ticket === null) return;
    const hit = await bridge.hitTest({
      x: ((clientX - bounds.x) * frame.clientWidth) / bounds.width,
      y: ((clientY - bounds.y) * frame.clientHeight) / bounds.height,
    });
    useHtmlSelectionStore
      .getState()
      .completePick(artifactId, ticket, hit, servedSha256);
  };

  return (
    <div
      ref={root}
      tabIndex={-1}
      className="nokey pointer-events-none absolute inset-0 z-10"
      data-html-selection-layer=""
      data-active={enabled}
    >
      {enabled
        ? shields.map((shield) => (
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
                event.stopPropagation();
                if (event.button !== 0 || !event.isPrimary) return;
                event.preventDefault();
                root.current?.focus();
                gesture.current = {
                  pointerId: event.pointerId,
                  x: event.clientX,
                  y: event.clientY,
                  dragged: false,
                };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                const start = gesture.current;
                if (start?.pointerId === event.pointerId)
                  gesture.current = moveHtmlSelectionGesture(start, {
                    x: event.clientX,
                    y: event.clientY,
                  });
              }}
              onPointerUp={(event) => {
                event.stopPropagation();
                const start = gesture.current;
                gesture.current = null;
                if (event.currentTarget.hasPointerCapture(event.pointerId))
                  event.currentTarget.releasePointerCapture(event.pointerId);
                if (
                  start !== null &&
                  isHtmlSelectionClick(start, event.pointerId, {
                    x: event.clientX,
                    y: event.clientY,
                  })
                )
                  void pick(event.clientX, event.clientY);
              }}
              onPointerCancel={() => {
                gesture.current = null;
              }}
              onLostPointerCapture={() => {
                gesture.current = null;
              }}
            />
          ))
        : null}
      {enabled ? (
        <HtmlSelectionOutline
          selection={selection}
          box={box}
          dimensions={dimensions}
        />
      ) : null}
      <div className="absolute inset-0 z-10">{overlay}</div>
      {enabled ? (
        <HtmlSelectionActions
          selection={selection}
          box={box}
          width={dimensions.width}
          actionControls={actionControls}
        />
      ) : null}
      <div className="absolute right-2 top-2 z-30 rounded-md bg-popover [&]:pointer-events-auto">
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-pressed={enabled}
          disabled={bridge === null}
          onClick={() =>
            useHtmlSelectionStore.getState().setEnabled(artifactId, !enabled)
          }
        >
          Comment
        </Button>
      </div>
    </div>
  );
}
