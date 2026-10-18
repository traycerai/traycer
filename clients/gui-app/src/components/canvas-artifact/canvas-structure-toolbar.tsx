import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ArtboardEdit } from "@traycer/protocol/host/epic/artboard-edit";
import type { CanvasBoardDocument } from "./canvas-board-document";
import type { CanvasFrameRegistry } from "./canvas-frame-registry";
import { useCanvasSelectionStore, type CanvasSelection } from "./canvas-selection-store";
import { useCanvasEditAction, canvasSelectionIsCurrent } from "./use-canvas-edit-action";
import { useCanvasSiblingLayout } from "./use-canvas-sibling-layout";
import { alignElements, arrangementRefusal, distributeElements, sourceLocator, structureFacts, type CanvasAlignMode } from "./canvas-structure-geometry";

const ALIGNMENTS: readonly { mode: CanvasAlignMode; label: string }[] = [
  { mode: "left", label: "Left" }, { mode: "center", label: "Center" }, { mode: "right", label: "Right" },
  { mode: "top", label: "Top" }, { mode: "middle", label: "Middle" }, { mode: "bottom", label: "Bottom" },
];
export function CanvasStructureToolbar(props: {
  readonly selection: CanvasSelection;
  readonly registry: CanvasFrameRegistry;
  readonly document: CanvasBoardDocument | null;
}) {
  const { selection, registry } = props;
  const additional = useCanvasSelectionStore((state) => state.additionalElements);
  const layout = useCanvasSiblingLayout(selection, registry);
  const action = useCanvasEditAction(selection.artifactId);
  const [wrapOpen, setWrapOpen] = useState(false);
  const [className, setClassName] = useState("");
  const facts = structureFacts(props.document?.sha256 === selection.servedSha256 ? props.document : null, [selection.element, ...additional], layout);
  const alignNote = facts.refusal ?? arrangementRefusal(facts.nodes, 2);
  const distributeNote = facts.refusal ?? arrangementRefusal(facts.nodes, 3);
  const apply = (edit: ArtboardEdit | null): void => {
    if (edit === null || action.pending || !canvasSelectionIsCurrent(selection) || registry.get(selection.boardPath).sha256 !== selection.servedSha256) return;
    void action.apply(selection, edit);
  };
  const wrap = (tag: "div" | "section", classes: string | null): void => {
    if (facts.wrapRefusal !== null) return;
    if (classes !== null && (!classes.isWellFormed() || classes.includes("\0") || classes.length > 4096)) { action.setMessage("Enter a class name without invalid characters, up to 4096 characters."); return; }
    const locators = facts.nodes.map(sourceLocator);
    if (locators.some((locator) => locator === null)) return;
    apply({ kind: "wrap-elements", tag, className: classes, locators: locators.filter((locator) => locator !== null) });
  };
  return (
    <div className="grid gap-2 border-b p-3" onPointerDown={(event) => event.stopPropagation()}>
      <p className="text-ui-xs font-medium">Arrange · {additional.length + 1} selected</p>
      <div role="toolbar" aria-label="Arrange elements" className="flex flex-wrap gap-1">
        {ALIGNMENTS.map(({ mode, label }) => <Button key={mode} size="xs" variant="outline" aria-label={`Align ${mode}`} title={alignNote ?? `Align ${mode}`} disabled={action.pending || alignNote !== null} onClick={() => apply(alignElements(facts.nodes, mode))}>{label}</Button>)}
        <Button size="xs" variant="outline" disabled={action.pending || distributeNote !== null} title={distributeNote ?? undefined} onClick={() => apply(distributeElements(facts.nodes, "x"))}>Distribute horizontally</Button>
        <Button size="xs" variant="outline" disabled={action.pending || distributeNote !== null} title={distributeNote ?? undefined} onClick={() => apply(distributeElements(facts.nodes, "y"))}>Distribute vertically</Button>
      </div>
      {alignNote === null ? null : <p className="text-ui-xs text-muted-foreground">{alignNote}</p>}
      <div className="flex flex-wrap gap-1">
        <Button size="xs" variant="outline" disabled={action.pending || facts.wrapRefusal !== null} title={facts.wrapRefusal ?? undefined} onClick={() => wrap("div", null)}>Group</Button>
        <Button size="xs" variant="outline" disabled={action.pending || facts.wrapRefusal !== null} title={facts.wrapRefusal ?? undefined} onClick={() => setWrapOpen(!wrapOpen)}>Wrap</Button>
        <Button size="xs" variant="outline" disabled={action.pending || facts.unwrapRefusal !== null} title={facts.unwrapRefusal ?? undefined} onClick={() => apply({ kind: "unwrap-element" })}>Ungroup</Button>
      </div>
      {facts.wrapRefusal === null ? null : <p className="text-ui-xs text-muted-foreground">{facts.wrapRefusal}</p>}
      {wrapOpen ? <div className="grid gap-1">
        <Input size="sm" aria-label="Wrapper class (optional)" placeholder="Class (optional)" value={className} maxLength={4096} onChange={(event) => setClassName(event.currentTarget.value)} />
        <div className="flex gap-1"><Button size="xs" variant="outline" disabled={action.pending || facts.wrapRefusal !== null} onClick={() => wrap("div", className || null)}>Wrap in div</Button><Button size="xs" variant="outline" disabled={action.pending || facts.wrapRefusal !== null} onClick={() => wrap("section", className || null)}>Wrap in section</Button></div>
      </div> : null}
      <p className="text-ui-xs text-muted-foreground">Shift-click to add elements. Drag an outline to reorder within its container.</p>
      {action.message === null ? null : <p role="status" className="text-ui-xs text-destructive">{action.message}</p>}
    </div>
  );
}
