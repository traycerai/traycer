import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import type { CanvasBox } from "@/lib/sandbox/canvas-bridge";
import type { CanvasBoardDocument } from "./canvas-board-document";
import type { CanvasFrameRegistry } from "./canvas-frame-registry";
import { useCanvasSelectionStore, type CanvasSelection } from "./canvas-selection-store";
import { sameLayoutElement, structureFacts, type CanvasResizeCorner } from "./canvas-structure-geometry";
import { useCanvasSiblingLayout } from "./use-canvas-sibling-layout";
import { useCanvasStructureGesture } from "./use-canvas-structure-gesture";

function boxStyle(box: CanvasBox): CSSProperties {
  return { left: box.x, top: box.y, width: box.width, height: box.height };
}
const CORNERS: readonly { corner: CanvasResizeCorner; label: string; className: string }[] = [
  { corner: "nw", label: "top left", className: "-left-1 -top-1 cursor-nwse-resize" },
  { corner: "ne", label: "top right", className: "-right-1 -top-1 cursor-nesw-resize" },
  { corner: "sw", label: "bottom left", className: "-left-1 -bottom-1 cursor-nesw-resize" },
  { corner: "se", label: "bottom right", className: "-right-1 -bottom-1 cursor-nwse-resize" },
];
const EDGES = ["-top-1 left-1 right-1 h-2", "-bottom-1 left-1 right-1 h-2", "-left-1 top-1 bottom-1 w-2", "-right-1 top-1 bottom-1 w-2"];

export function CanvasStructureOverlay(props: {
  readonly selection: CanvasSelection;
  readonly registry: CanvasFrameRegistry;
  readonly document: CanvasBoardDocument | null;
}) {
  const { selection, registry } = props;
  const additional = useCanvasSelectionStore((state) => state.additionalElements);
  const layout = useCanvasSiblingLayout(selection, registry);
  const facts = structureFacts(props.document?.sha256 === selection.servedSha256 ? props.document : null, [selection.element, ...additional], layout);
  const node = facts.nodes[0] ?? null;
  const disabled = facts.refusal !== null || additional.length !== 0;
  const gesture = useCanvasStructureGesture({ selection, registry, layout, node, disabled });
  const canResize = node !== null && !node.transformed && node.cssWidth !== null && node.cssHeight !== null;
  const box = node?.box ?? selection.element.box;
  return (
    <>
      {additional.map((element) => {
        const bounds = layout?.siblings.find((item) => sameLayoutElement(element, item))?.box ?? element.box;
        return <div key={element.tid ?? element.marker ?? element.selector} data-canvas-additional-outline="" className="absolute border border-primary" style={boxStyle(bounds)} />;
      })}
      {disabled ? null : <div className="absolute" style={boxStyle(box)}>
        {EDGES.map((edge, index) => <button key={edge} type="button" aria-label={`Reorder element (${index + 1})`} title="Drag to reorder within this container" disabled={gesture.pending || layout === null || layout.siblings.length < 2} className={cn("absolute z-10 cursor-grab touch-none [&]:pointer-events-auto", edge)} onPointerDown={(event) => gesture.start(event, "move")} onPointerMove={gesture.move} onPointerUp={gesture.end} onPointerCancel={gesture.cancel} onLostPointerCapture={gesture.cancel} />)}
        {canResize ? CORNERS.map(({ corner, label, className }) => <button key={corner} type="button" aria-label={`Resize element ${label}`} title="Drag to resize; hold Shift to keep proportions" disabled={gesture.pending} className={cn("absolute z-20 size-2 touch-none border border-primary bg-background [&]:pointer-events-auto", className)} onPointerDown={(event) => gesture.start(event, corner)} onPointerMove={gesture.move} onPointerUp={gesture.end} onPointerCancel={gesture.cancel} onLostPointerCapture={gesture.cancel} />) : null}
      </div>}
      {gesture.preview?.box === null || gesture.preview?.box === undefined ? null : <div data-canvas-resize-preview="" className="absolute border border-dashed border-primary bg-primary/10" style={boxStyle(gesture.preview.box)} />}
      {gesture.preview?.marker === null || gesture.preview?.marker === undefined ? null : <div data-canvas-insertion-marker="" className="absolute bg-primary" style={boxStyle(gesture.preview.marker)} />}
      {gesture.message === null ? null : <div role="status" className="absolute left-2 top-2 z-30 max-w-full rounded border bg-popover p-2 text-ui-xs text-popover-foreground">{gesture.message}</div>}
    </>
  );
}
