import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import type { ArtboardEdit } from "@traycer/protocol/host/epic/artboard-edit";
import type { SandboxBridgeHost } from "@/lib/sandbox/bridge-host";
import type { CanvasBox } from "@/lib/sandbox/canvas-bridge";
import type { CanvasLayoutNode, CanvasSiblingLayout } from "@/lib/sandbox/canvas-layout-bridge";
import type { CanvasFrameRegistry } from "./canvas-frame-registry";
import { useCanvasSelectionStore, type CanvasSelection } from "./canvas-selection-store";
import { canvasSelectionIsCurrent, useCanvasEditAction } from "./use-canvas-edit-action";
import { CANVAS_LAYOUT_CHANGED_NOTE, frameLocator, reorderTarget, resizeElement, sameLayoutElement, sourceLocator, type CanvasResizeCorner } from "./canvas-structure-geometry";

type Point = { readonly x: number; readonly y: number };
type GestureKind = "move" | CanvasResizeCorner;
interface StructureGesture {
  readonly kind: GestureKind;
  readonly pointerId: number;
  readonly start: Point;
  readonly generation: number;
  readonly selection: CanvasSelection;
  readonly bridge: SandboxBridgeHost;
  readonly frame: HTMLIFrameElement;
  readonly layout: CanvasSiblingLayout;
  readonly node: CanvasLayoutNode;
}
interface StructurePreview { readonly box: CanvasBox | null; readonly marker: CanvasBox | null }

function framePoint(frame: HTMLIFrameElement, event: { readonly clientX: number; readonly clientY: number }): Point | null {
  const bounds = frame.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0 || frame.clientWidth <= 0 || frame.clientHeight <= 0) return null;
  return { x: (event.clientX - bounds.x) * frame.clientWidth / bounds.width, y: (event.clientY - bounds.y) * frame.clientHeight / bounds.height };
}
function currentGesture(gesture: StructureGesture, registry: CanvasFrameRegistry): boolean {
  const entry = registry.get(gesture.selection.boardPath);
  return entry.bridge === gesture.bridge && entry.frame === gesture.frame && entry.sha256 === gesture.selection.servedSha256 && useCanvasSelectionStore.getState().generation === gesture.generation && canvasSelectionIsCurrent(gesture.selection);
}
function gesturePreview(gesture: StructureGesture, point: Point, ratio: boolean): StructurePreview {
  if (gesture.kind === "move") return { box: null, marker: reorderTarget(gesture.layout, gesture.node, point)?.marker ?? null };
  const result = resizeElement(gesture.node, gesture.kind, { x: point.x - gesture.start.x, y: point.y - gesture.start.y }, ratio);
  return { box: result?.box ?? null, marker: null };
}
function gestureEdit(gesture: StructureGesture, point: Point, ratio: boolean): ArtboardEdit | null {
  if (gesture.kind !== "move") {
    const size = resizeElement(gesture.node, gesture.kind, { x: point.x - gesture.start.x, y: point.y - gesture.start.y }, ratio);
    return size === null ? null : { kind: "set-box", width: size.width, height: size.height };
  }
  const target = reorderTarget(gesture.layout, gesture.node, point);
  if (target === null) return null;
  const index = gesture.layout.siblings.findIndex((node) => sameLayoutElement(node, gesture.node));
  const next = gesture.layout.siblings[index + 1];
  const currentBefore = next === undefined ? null : sourceLocator(next);
  return JSON.stringify(target.before) === JSON.stringify(currentBefore) ? null : { kind: "move-element", before: target.before };
}

/** Pointer coordinates stay in the frame's CSS pixels, including at canvas zoom. */
export function useCanvasStructureGesture(props: {
  readonly selection: CanvasSelection;
  readonly registry: CanvasFrameRegistry;
  readonly layout: CanvasSiblingLayout | null;
  readonly node: CanvasLayoutNode | null;
  readonly disabled: boolean;
}) {
  const action = useCanvasEditAction(props.selection.artifactId);
  const gesture = useRef<StructureGesture | null>(null);
  const saving = useRef(false);
  const active = useRef(true);
  const [preview, setPreview] = useState<StructurePreview | null>(null);
  useLayoutEffect(() => {
    active.current = true;
    return () => { active.current = false; gesture.current = null; };
  }, []);
  const cancel = (): void => { gesture.current = null; setPreview(null); };
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || gesture.current === null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      gesture.current = null;
      setPreview(null);
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, []);
  const start = (event: PointerEvent<HTMLButtonElement>, kind: GestureKind): void => {
    event.stopPropagation();
    event.preventDefault();
    const entry = props.registry.get(props.selection.boardPath);
    if (event.button !== 0 || props.disabled || action.pending || saving.current || props.layout === null || props.node === null || entry.bridge === null || entry.frame === null) return;
    const point = framePoint(entry.frame, event);
    if (point === null || !canvasSelectionIsCurrent(props.selection) || entry.sha256 !== props.selection.servedSha256) return;
    action.setMessage(null);
    gesture.current = { kind, pointerId: event.pointerId, start: point, generation: useCanvasSelectionStore.getState().generation, selection: props.selection, bridge: entry.bridge, frame: entry.frame, layout: props.layout, node: props.node };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLButtonElement>): void => {
    const current = gesture.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    event.stopPropagation();
    if (!currentGesture(current, props.registry)) { cancel(); return; }
    const point = framePoint(current.frame, event);
    if (point !== null) setPreview(gesturePreview(current, point, event.shiftKey));
  };
  const commit = async (current: StructureGesture, point: Point, ratio: boolean): Promise<void> => {
    const locator = frameLocator(current.node);
    if (locator === null) return;
    saving.current = true;
    try {
      const fresh = await current.bridge.siblingLayout(locator);
      if (!active.current || !currentGesture(current, props.registry)) return;
      if (JSON.stringify(fresh) !== JSON.stringify(current.layout)) { action.setMessage(CANVAS_LAYOUT_CHANGED_NOTE); return; }
      if (current.kind === "move" && reorderTarget(current.layout, current.node, point) === null) {
        action.setMessage("Move elements only within their current container.");
        return;
      }
      const edit = gestureEdit(current, point, ratio);
      if (edit !== null) await action.apply(current.selection, edit);
    } catch {
      if (active.current) action.setMessage("The layout could not be read. Try again.");
    } finally {
      saving.current = false;
    }
  };
  const end = (event: PointerEvent<HTMLButtonElement>): void => {
    const current = gesture.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    event.stopPropagation();
    cancel();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const point = framePoint(current.frame, event);
    if (point === null || Math.hypot(point.x - current.start.x, point.y - current.start.y) < 3 || !currentGesture(current, props.registry)) return;
    void commit(current, point, event.shiftKey);
  };
  return { start, move, end, cancel, preview, message: action.message, pending: action.pending };
}
