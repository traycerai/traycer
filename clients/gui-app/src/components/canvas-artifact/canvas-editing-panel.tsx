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
import {
  useCanvasSelectionStore,
  type CanvasSelection,
} from "./canvas-selection-store";
import { CanvasStructureToolbar } from "./canvas-structure-toolbar";

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
  const selection = useCanvasSelectionStore((state) =>
    state.selection?.artifactId === props.artifactId &&
    state.selection.boardPath === props.boardPath
      ? state.selection
      : null,
  );
  const multiple = useCanvasSelectionStore(
    (state) => state.additionalElements.length > 0,
  );
  return (
    <Tabs defaultValue="design" className="min-h-0 min-w-0 flex-1">
      <TabsList variant="line" size="sm" className="w-full shrink-0">
        <TabsTrigger value="design">Design</TabsTrigger>
        <TabsTrigger value="code">Code</TabsTrigger>
        <TabsTrigger value="tweaks">Tweaks</TabsTrigger>
      </TabsList>
      <TabsContent
        value="design"
        className="flex min-h-0 flex-col overflow-hidden"
      >
        <section
          aria-label="Layers"
          className="flex min-h-0 max-h-[40%] shrink-0 flex-col border-b"
        >
          <h3 className="px-3 pb-2 text-ui-xs font-medium">Layers</h3>
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
        </section>
        <div className="min-h-0 flex-1 overflow-y-auto">{props.children}</div>
      </TabsContent>
      <TabsContent value="code" className="min-h-0 overflow-y-auto">
        {selection === null || multiple ? (
          <p className="p-3 text-ui-xs text-muted-foreground">
            {selection === null
              ? "Select an element to edit its CSS."
              : "Select one element to edit its CSS."}
          </p>
        ) : (
          <CanvasPropertiesPanel artifactId={props.artifactId} tab="code" />
        )}
      </TabsContent>
      <TabsContent value="tweaks" className="min-h-0 overflow-y-auto">
        {document.data === undefined ? (
          <p role="status" className="p-3 text-ui-xs text-muted-foreground">
            {document.error?.message ?? "Opening tweaks…"}
          </p>
        ) : (
          <CanvasTweaksPanel
            artifactId={props.artifactId}
            boardPath={props.boardPath}
            registry={props.registry}
            document={document.data}
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
  const multiple = useCanvasSelectionStore(
    (state) => state.additionalElements.length > 0,
  );
  const document = useCanvasBoardDocument(
    props.selection.artifactId,
    props.selection.boardPath,
    props.registry,
    true,
  );
  return (
    <>
      <CanvasStructureToolbar
        selection={props.selection}
        registry={props.registry}
        document={document.data ?? null}
      />
      {multiple ? (
        <p className="p-3 text-ui-xs text-muted-foreground">
          Select one element to edit its properties or text.
        </p>
      ) : (
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
      )}
    </>
  );
}
