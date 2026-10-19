import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import type { ArtboardEdit } from "@traycer/protocol/host/epic/artboard-edit";
import type { CanvasBoardDocument } from "./canvas-board-document";
import type { CanvasFrameRegistry } from "./canvas-frame-registry";
import {
  useCanvasSelectionStore,
  type CanvasSelection,
} from "./canvas-selection-store";
import { useCanvasStructureAction } from "./use-canvas-structure-action";
import { useCanvasSiblingLayout } from "./use-canvas-sibling-layout";
import {
  alignElements,
  arrangementRefusal,
  distributeElements,
  sourceLocator,
  structureFacts,
  type CanvasAlignMode,
  type CanvasStructureFacts,
} from "./canvas-structure-geometry";

const ALIGNMENTS: readonly { mode: CanvasAlignMode; label: string }[] = [
  { mode: "left", label: "Left" },
  { mode: "center", label: "Center" },
  { mode: "right", label: "Right" },
  { mode: "top", label: "Top" },
  { mode: "middle", label: "Middle" },
  { mode: "bottom", label: "Bottom" },
];
interface ArrangeControlsProps {
  readonly facts: CanvasStructureFacts;
  readonly pending: boolean;
  readonly apply: (edit: ArtboardEdit | null) => void;
}
function StructureButton(props: {
  readonly label: string;
  readonly name: string;
  readonly note: string | null;
  readonly pending: boolean;
  readonly onClick: () => void;
}) {
  return (
    <TooltipWrapper
      label={props.note}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <Button
        size="xs"
        variant="outline"
        aria-label={props.name}
        disabled={props.pending || props.note !== null}
        onClick={props.onClick}
      >
        {props.label}
      </Button>
    </TooltipWrapper>
  );
}
function ArrangementButtons({ facts, pending, apply }: ArrangeControlsProps) {
  const alignNote = facts.refusal ?? arrangementRefusal(facts.nodes, 2);
  const distributeNote = facts.refusal ?? arrangementRefusal(facts.nodes, 3);
  return (
    <>
      <div
        role="toolbar"
        aria-label="Arrange elements"
        className="flex flex-wrap gap-1"
      >
        {ALIGNMENTS.map(({ mode, label }) => (
          <StructureButton
            key={mode}
            name={`Align ${mode}`}
            label={label}
            note={alignNote}
            pending={pending}
            onClick={() => apply(alignElements(facts.nodes, mode))}
          />
        ))}
        <StructureButton
          name="Distribute horizontally"
          label="Distribute horizontally"
          note={distributeNote}
          pending={pending}
          onClick={() => apply(distributeElements(facts.nodes, "x"))}
        />
        <StructureButton
          name="Distribute vertically"
          label="Distribute vertically"
          note={distributeNote}
          pending={pending}
          onClick={() => apply(distributeElements(facts.nodes, "y"))}
        />
      </div>
      {alignNote === null ? null : (
        <p className="text-ui-xs text-muted-foreground">{alignNote}</p>
      )}
    </>
  );
}
function GroupingControls(
  props: ArrangeControlsProps & {
    readonly setMessage: (message: string | null) => void;
  },
) {
  const { facts, pending, apply } = props;
  const [wrapOpen, setWrapOpen] = useState(false);
  const [className, setClassName] = useState("");
  const wrap = (tag: "div" | "section", classes: string | null): void => {
    if (facts.wrapRefusal !== null) return;
    if (
      classes !== null &&
      (!classes.isWellFormed() ||
        classes.includes("\0") ||
        classes.length > 4096)
    ) {
      props.setMessage(
        "Enter a class name without invalid characters, up to 4096 characters.",
      );
      return;
    }
    const locators = facts.nodes.map(sourceLocator);
    if (locators.some((locator) => locator === null)) return;
    apply({
      kind: "wrap-elements",
      tag,
      className: classes,
      locators: locators.filter((locator) => locator !== null),
    });
  };
  return (
    <>
      <div className="flex flex-wrap gap-1">
        <StructureButton
          name="Group"
          label="Group"
          note={facts.wrapRefusal}
          pending={pending}
          onClick={() => wrap("div", null)}
        />
        <StructureButton
          name="Wrap"
          label="Wrap"
          note={facts.wrapRefusal}
          pending={pending}
          onClick={() => setWrapOpen(!wrapOpen)}
        />
      </div>
      {facts.wrapRefusal === null ? null : (
        <p className="text-ui-xs text-muted-foreground">{facts.wrapRefusal}</p>
      )}
      {wrapOpen ? (
        <div className="grid gap-1">
          <Input
            size="sm"
            aria-label="Wrapper class (optional)"
            placeholder="Class (optional)"
            value={className}
            maxLength={4096}
            onChange={(event) => setClassName(event.currentTarget.value)}
          />
          <div className="flex gap-1">
            <StructureButton
              name="Wrap in div"
              label="Wrap in div"
              note={facts.wrapRefusal}
              pending={pending}
              onClick={() => wrap("div", className || null)}
            />
            <StructureButton
              name="Wrap in section"
              label="Wrap in section"
              note={facts.wrapRefusal}
              pending={pending}
              onClick={() => wrap("section", className || null)}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
export function CanvasStructureToolbar(props: {
  readonly selection: CanvasSelection;
  readonly registry: CanvasFrameRegistry;
  readonly document: CanvasBoardDocument | null;
}) {
  const { selection, registry } = props;
  const additional = useCanvasSelectionStore(
    (state) => state.additionalElements,
  );
  const selectionMessage = useCanvasSelectionStore(
    (state) => state.selectionMessage,
  );
  const layout = useCanvasSiblingLayout(selection, registry);
  const action = useCanvasStructureAction(selection, registry, layout);
  const facts = structureFacts(
    props.document?.sha256 === selection.servedSha256 ? props.document : null,
    [selection.element, ...additional],
    layout,
  );
  const controls = {
    facts,
    pending: action.pending,
    apply: (edit: ArtboardEdit | null) => {
      void action.apply(edit);
    },
  };
  if (
    layout === null ||
    props.document === null ||
    props.document.sha256 !== selection.servedSha256 ||
    (additional.length === 0 && facts.unwrapRefusal !== null)
  )
    return action.message === null ? null : (
      <p role="status" className="p-3 text-ui-xs text-destructive">
        {action.message}
      </p>
    );
  return (
    <div
      className="grid gap-2 border-b p-3"
      onPointerDown={(event) => event.stopPropagation()}
    >
      {additional.length > 0 ? (
        <p className="text-ui-xs font-medium">
          Arrange · {additional.length + 1} selected
        </p>
      ) : null}
      {action.pending ? (
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
      ) : null}
      {additional.length > 0 ? (
        <>
          <ArrangementButtons {...controls} />
          <GroupingControls
            key={`${selection.servedSha256}:${selection.element.marker}:${selection.element.tid}`}
            {...controls}
            setMessage={action.setMessage}
          />
          <p className="text-ui-xs text-muted-foreground">
            Shift-click to add elements. Drag an outline to reorder within its
            container.
          </p>
        </>
      ) : (
        <div className="flex">
          <StructureButton
            name="Ungroup"
            label="Ungroup"
            note={facts.unwrapRefusal}
            pending={action.pending}
            onClick={() => controls.apply({ kind: "unwrap-element" })}
          />
        </div>
      )}
      {action.message === null ? null : (
        <p role="status" className="text-ui-xs text-destructive">
          {action.message}
        </p>
      )}
      {selectionMessage === null ? null : (
        <p role="status" className="text-ui-xs text-muted-foreground">
          {selectionMessage}
        </p>
      )}
    </div>
  );
}
