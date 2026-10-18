import { CanvasCommentAction } from "./canvas-comments";
import { useState, useSyncExternalStore } from "react";
import type { CanvasAnnotationScope } from "./canvas-annotation-action";
import type {
  CanvasFrameRegistry,
  CanvasSelectionFrame,
} from "./canvas-frame-registry";
import { CanvasSelectionOverlay } from "./canvas-selection-overlay";
import {
  sameCanvasElement,
  useCanvasSelectionStore,
  type CanvasSelection,
} from "./canvas-selection-store";
import { useCanvasBoardDocument } from "./use-canvas-board-document";
import {
  canvasSourceElement,
  canvasTextDraftTarget,
  type CanvasBoardDocument,
  type CanvasTextDraftTarget,
} from "./canvas-board-document";
import { CanvasInlineTextEditor } from "./canvas-inline-text-editor";
import { CanvasTextToolbar } from "./canvas-text-toolbar";
import {
  canvasLiveText,
  CANVAS_SCRIPT_TEXT_NOTE,
} from "./canvas-text-validation";
import type { CanvasElementLocator } from "@/lib/sandbox/canvas-bridge";
import { CanvasStructureOverlay } from "./canvas-structure-overlay";

function currentRetype(
  selection: CanvasSelection | null,
  entry: CanvasSelectionFrame,
  generation: number,
  dismissed: string | null,
) {
  const request = entry.retype;
  if (
    selection === null ||
    request === null ||
    request.id === dismissed ||
    request.generation !== generation ||
    request.sha256 !== selection.servedSha256 ||
    entry.sha256 !== request.sha256 ||
    entry.bridge === null ||
    entry.bridge !== request.bridge ||
    !sameCanvasElement(request.element, selection.element)
  )
    return null;
  return request;
}
async function readRetypeText(context: {
  readonly registry: CanvasFrameRegistry;
  readonly selection: CanvasSelection;
  readonly request: NonNullable<CanvasSelectionFrame["retype"]>;
  readonly target: CanvasTextDraftTarget;
}): Promise<string | null> {
  const { registry, selection, request, target } = context;
  const isCurrent = (): boolean => {
    const entry = registry.get(selection.boardPath);
    return (
      entry.retype?.id === request.id &&
      entry.bridge === request.bridge &&
      entry.sha256 === request.sha256
    );
  };
  if (!isCurrent()) return null;
  const { tid, marker } = request.element;
  let locator: CanvasElementLocator;
  if (tid !== null) locator = { tid };
  else if (marker !== null) locator = { marker };
  else return null;
  const element = await request.bridge.describeElement(locator);
  return element !== null &&
    isCurrent() &&
    sameCanvasElement(request.element, element)
    ? canvasLiveText(target, element)
    : null;
}
function EditingControls(props: {
  readonly selection: CanvasSelection;
  readonly document: CanvasBoardDocument | undefined;
  readonly pending: boolean;
  readonly request: CanvasSelectionFrame["retype"];
  readonly registry: CanvasFrameRegistry;
  readonly onClose: () => void;
}) {
  const request = props.request;
  if (request === null) return null;
  const source =
    props.document?.sha256 === props.selection.servedSha256
      ? canvasSourceElement(props.document, props.selection.element)
      : null;
  const target = source === null ? null : canvasTextDraftTarget(source);
  const liveText =
    target === null ? null : canvasLiveText(target, request.element);
  if (target !== null && liveText === target.text)
    return (
      <CanvasInlineTextEditor
        key={request.id}
        selection={props.selection}
        target={target}
        readText={() =>
          readRetypeText({
            registry: props.registry,
            selection: props.selection,
            request,
            target,
          })
        }
        onClose={props.onClose}
      />
    );
  let message = "Ask the agent to change this element.";
  if (props.pending) message = "Opening text…";
  else if (target !== null) message = CANVAS_SCRIPT_TEXT_NOTE;
  return (
    <div
      role="status"
      className="absolute left-2 top-2 z-30 rounded border bg-popover p-2 text-ui-xs pointer-events-auto"
      onPointerDown={(event) => event.stopPropagation()}
    >
      {message}
    </div>
  );
}
export function CanvasEditingOverlay(props: {
  readonly scope: CanvasAnnotationScope;
  readonly tileId: string;
  readonly boardPath: string;
  readonly registry: CanvasFrameRegistry;
  readonly onPick: (
    path: string,
    point: { x: number; y: number; additive?: boolean },
  ) => void;
  readonly onRetire: (path: string) => void;
}) {
  useSyncExternalStore(props.registry.subscribe, props.registry.getSnapshot);
  const selection = useCanvasSelectionStore((state) =>
    state.selection?.artifactId === props.scope.artifactId &&
    state.selection.boardPath === props.boardPath
      ? state.selection
      : null,
  );
  const generation = useCanvasSelectionStore((state) => state.generation);
  const additional = useCanvasSelectionStore(
    (state) => state.additionalElements,
  );
  const document = useCanvasBoardDocument(
    props.scope.artifactId,
    props.boardPath,
    props.registry,
    selection !== null,
  );
  const [dismissed, setDismissed] = useState<string | null>(null);
  const entry = props.registry.get(props.boardPath);
  const request = currentRetype(selection, entry, generation, dismissed);
  const controls =
    selection === null ? null : (
      <EditingControls
        key={
          request === null
            ? `${selection.servedSha256}:${selection.element.marker}:${selection.textRange?.start}:${selection.textRange?.end}`
            : request.id
        }
        selection={selection}
        document={document.data}
        pending={document.isPending}
        request={request}
        registry={props.registry}
        onClose={() => setDismissed(request?.id ?? null)}
      />
    );
  return (
    <CanvasSelectionOverlay
      {...props}
      controls={
        <>
          {controls}
          {selection !== null && request === null ? (
            <CanvasStructureOverlay
              selection={selection}
              registry={props.registry}
              document={document.data ?? null}
            />
          ) : null}
        </>
      }
      actionControls={
        request === null && selection !== null && additional.length === 0 ? (
          <>
            <CanvasTextToolbar
              inline
              selection={selection}
              document={document.data ?? null}
            />
            <CanvasCommentAction
              scope={props.scope}
              tileId={props.tileId}
              selection={selection}
              registry={props.registry}
            />
          </>
        ) : null
      }
      hideAction={request !== null || additional.length > 0}
      hideHandles
    />
  );
}
