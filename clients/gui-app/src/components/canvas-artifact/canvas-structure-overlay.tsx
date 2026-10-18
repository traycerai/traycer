import { cn } from "@/lib/utils";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import type { CanvasBox } from "@/lib/sandbox/canvas-bridge";
import type { CanvasBoardDocument } from "./canvas-board-document";
import type { CanvasFrameRegistry } from "./canvas-frame-registry";
import {
  useCanvasSelectionStore,
  type CanvasSelection,
} from "./canvas-selection-store";
import {
  reorderRefusal,
  sameLayoutElement,
  structureFacts,
  type CanvasResizeCorner,
} from "./canvas-structure-geometry";
import { useCanvasSiblingLayout } from "./use-canvas-sibling-layout";
import {
  useCanvasStructureGesture,
  type CanvasStructureGesture,
} from "./use-canvas-structure-gesture";

const CORNERS: readonly {
  corner: CanvasResizeCorner;
  label: string;
  className: string;
}[] = [
  {
    corner: "nw",
    label: "top left",
    className: "-left-1 -top-1 cursor-nwse-resize",
  },
  {
    corner: "ne",
    label: "top right",
    className: "-right-1 -top-1 cursor-nesw-resize",
  },
  {
    corner: "sw",
    label: "bottom left",
    className: "-left-1 -bottom-1 cursor-nesw-resize",
  },
  {
    corner: "se",
    label: "bottom right",
    className: "-right-1 -bottom-1 cursor-nwse-resize",
  },
];
const EDGES = [
  "-top-1 left-1 right-1 h-2",
  "-bottom-1 left-1 right-1 h-2",
  "-left-1 top-1 bottom-1 w-2",
  "-right-1 top-1 bottom-1 w-2",
];

function StructureHandles(props: {
  readonly box: CanvasBox;
  readonly canResize: boolean;
  readonly moveNote: string | null;
  readonly gesture: CanvasStructureGesture;
}) {
  const { gesture } = props;
  const handlers = {
    onPointerMove: gesture.move,
    onPointerUp: gesture.end,
    onPointerCancel: gesture.cancel,
    onLostPointerCapture: gesture.lostCapture,
  };
  return (
    <div className="absolute" style={{ left: props.box.x, top: props.box.y, width: props.box.width, height: props.box.height }}>
      {EDGES.map((edge, index) => (
        <TooltipWrapper
          key={edge}
          label={props.moveNote ?? "Drag to reorder within this container"}
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <button
            type="button"
            aria-label={`Reorder element (${index + 1})`}
            disabled={gesture.pending || props.moveNote !== null}
            className={cn(
              "absolute z-10 cursor-grab touch-none [&]:pointer-events-auto",
              edge,
            )}
            onPointerDown={(event) => gesture.start(event, "move")}
            {...handlers}
          />
        </TooltipWrapper>
      ))}
      {props.canResize
        ? CORNERS.map(({ corner, label, className }) => (
            <TooltipWrapper
              key={corner}
              label="Drag to resize; hold Shift to keep proportions"
              side="top"
              sideOffset={undefined}
              align={undefined}
            >
              <button
                type="button"
                aria-label={`Resize element ${label}`}
                disabled={gesture.pending}
                className={cn(
                  "absolute z-20 size-2 touch-none border border-primary bg-background [&]:pointer-events-auto",
                  className,
                )}
                onPointerDown={(event) => gesture.start(event, corner)}
                {...handlers}
              />
            </TooltipWrapper>
          ))
        : null}
    </div>
  );
}
function StructurePreview(props: { readonly gesture: CanvasStructureGesture }) {
  const preview = props.gesture.preview;
  if (preview === null) return null;
  return (
    <>
      {preview.box === null ? null : (
        <div
          data-canvas-resize-preview=""
          className="absolute border border-dashed border-primary bg-primary/10"
          style={{ left: preview.box.x, top: preview.box.y, width: preview.box.width, height: preview.box.height }}
        />
      )}
      {preview.marker === null ? null : (
        <div
          data-canvas-insertion-marker=""
          className="absolute bg-primary"
          style={{ left: preview.marker.x, top: preview.marker.y, width: preview.marker.width, height: preview.marker.height }}
        />
      )}
    </>
  );
}
export function CanvasStructureOverlay(props: {
  readonly selection: CanvasSelection;
  readonly registry: CanvasFrameRegistry;
  readonly document: CanvasBoardDocument | null;
}) {
  const { selection, registry } = props;
  const additional = useCanvasSelectionStore(
    (state) => state.additionalElements,
  );
  const layout = useCanvasSiblingLayout(selection, registry);
  const facts = structureFacts(
    props.document?.sha256 === selection.servedSha256 ? props.document : null,
    [selection.element, ...additional],
    layout,
  );
  const node = facts.nodes.at(0) ?? null;
  const disabled = facts.refusal !== null || additional.length !== 0;
  const gesture = useCanvasStructureGesture({
    selection,
    registry,
    layout,
    node,
    disabled,
  });
  const canResize =
    node !== null &&
    !node.transformed &&
    node.cssWidth !== null &&
    node.cssHeight !== null;
  const moveNote =
    facts.moveRefusal ?? (layout === null ? "Opening element layout…" : reorderRefusal(layout));
  return (
    <>
      {additional.map((element) => {
        const bounds =
          layout?.siblings.find((item) => sameLayoutElement(element, item))
            ?.box ?? element.box;
        return (
          <div
            key={element.tid ?? element.marker ?? element.selector}
            data-canvas-additional-outline=""
            className="absolute border border-primary"
            style={{ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height }}
          />
        );
      })}
      {disabled ? null : (
        <StructureHandles
          box={node?.box ?? selection.element.box}
          canResize={canResize}
          moveNote={moveNote}
          gesture={gesture}
        />
      )}
      <StructurePreview gesture={gesture} />
      {gesture.message === null ? null : (
        <div
          role="status"
          className="absolute left-2 top-2 z-30 max-w-full rounded border bg-popover p-2 text-ui-xs text-popover-foreground"
        >
          {gesture.message}
        </div>
      )}
    </>
  );
}
