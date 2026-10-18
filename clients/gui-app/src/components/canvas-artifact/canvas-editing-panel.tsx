import { type ReactNode } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { CanvasPropertiesPanel } from "./canvas-properties-panel";
import {
  CanvasClipboardMenuItems,
  CanvasImageControls,
} from "./canvas-clipboard-controls";
import { CanvasLayersTree } from "./canvas-layers-tree";
import { CanvasTweaksPanel } from "./canvas-tweaks-panel";
import { useCanvasBoardDocument } from "./use-canvas-board-document";
import type { CanvasFrameRegistry } from "./canvas-frame-registry";
import type { CanvasSelection } from "./canvas-selection-store";

export function CanvasEditingPanel(props: {
  readonly artifactId: string;
  readonly boardPath: string;
  readonly registry: CanvasFrameRegistry;
  readonly owner: symbol;
  readonly children: ReactNode;
}) {
  const document = useCanvasBoardDocument(
    props.artifactId,
    props.boardPath,
    props.registry,
    true,
  );
  return (
    <Tabs defaultValue="inspector" className="min-w-0">
      <TabsList variant="line" className="w-full">
        <TabsTrigger value="inspector">Inspector</TabsTrigger>
        <TabsTrigger value="layers">Layers</TabsTrigger>
      </TabsList>
      <TabsContent value="inspector">
        {props.children}
        {document.data === undefined ? null : (
          <CanvasTweaksPanel
            artifactId={props.artifactId}
            boardPath={props.boardPath}
            registry={props.registry}
            document={document.data}
          />
        )}
      </TabsContent>
      <TabsContent value="layers" className="h-[50vh] min-h-0">
        {document.data === undefined ? (
          <p role="status" className="p-3 text-ui-xs text-muted-foreground">
            {document.error?.message ?? "Opening layers…"}
          </p>
        ) : (
          <CanvasLayersTree
            artifactId={props.artifactId}
            boardPath={props.boardPath}
            document={document.data}
            registry={props.registry}
            owner={props.owner}
          />
        )}
      </TabsContent>
    </Tabs>
  );
}
export function CanvasElementEditingPanel(props: {
  readonly selection: CanvasSelection;
  readonly registry: CanvasFrameRegistry;
}) {
  const document = useCanvasBoardDocument(
    props.selection.artifactId,
    props.selection.boardPath,
    props.registry,
    true,
  );
  return (
    <>
      <CanvasPropertiesPanel
        artifactId={props.selection.artifactId}
        menuContent={
          <CanvasClipboardMenuItems
            selection={props.selection}
            registry={props.registry}
            document={document.data ?? null}
          />
        }
      />
      <CanvasImageControls
        selection={props.selection}
        registry={props.registry}
      />
    </>
  );
}
