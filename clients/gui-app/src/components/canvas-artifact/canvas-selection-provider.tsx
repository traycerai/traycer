import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type {
  CanvasPageError,
  CanvasElementLocator,
} from "@/lib/sandbox/canvas-bridge";
import { CanvasFrameEventsContext } from "./canvas-surface-context";
import type { CanvasFrameEvents } from "./canvas-frame";
import { CanvasFrameRegistry } from "./canvas-frame-registry";
import { CanvasEditingOverlay } from "./canvas-editing-overlay";
import {
  CanvasEditingPanel,
  CanvasElementEditingPanel,
} from "./canvas-editing-panel";
import { CanvasClipboardBoundary } from "./canvas-clipboard-controls";
import { useCanvasSelectionStore } from "./canvas-selection-store";
import {
  CanvasAnnotationAction,
  type CanvasAnnotationScope,
} from "./canvas-annotation-action";
import { CanvasBoardPanel } from "./canvas-board-panel";
import type { CanvasLayoutStore } from "./canvas-layout-store";
import { frameLocator } from "./canvas-structure-identity";

export function CanvasSelectionProvider(
  props: CanvasAnnotationScope & { readonly children: ReactNode },
) {
  const { epicId, artifactId, artifactTitle, hostId, viewTabId } = props;
  const scope = useMemo(
    () => ({ epicId, artifactId, artifactTitle, hostId, viewTabId }),
    [epicId, artifactId, artifactTitle, hostId, viewTabId],
  );
  const parent = useContext(CanvasFrameEventsContext);
  const [registry] = useState(() => new CanvasFrameRegistry());
  const [selectionOwner] = useState(() => Symbol("canvas-selection"));
  const [errorAttachment, setErrorAttachment] = useState<{
    path: string;
    error: CanvasPageError;
  } | null>(null);
  const requestSequence = useRef(0);
  const pick = useCallback(
    (
      path: string,
      point: { x: number; y: number; additive?: boolean },
    ): void => {
      const entry = registry.get(path);
      const bridge = entry.bridge;
      if (bridge === null || entry.sha256 === null) return;
      const servedSha256 = entry.sha256;
      const sequence = ++requestSequence.current;
      const generation = useCanvasSelectionStore
        .getState()
        .beginPick(selectionOwner, artifactId, path);
      registry.selectBoard(path);
      void bridge
        .hitTest({ x: point.x, y: point.y })
        .then(async (element) => {
          const primary = useCanvasSelectionStore.getState().selection;
          const locator =
            primary === null ? null : frameLocator(primary.element);
          const layout =
            point.additive === true &&
            locator !== null &&
            primary?.artifactId === artifactId &&
            primary.boardPath === path &&
            primary.servedSha256 === servedSha256
              ? await bridge.siblingLayout(locator)
              : null;
          if (
            sequence !== requestSequence.current ||
            registry.get(path).bridge !== bridge ||
            registry.get(path).sha256 !== servedSha256
          )
            return;
          const store = useCanvasSelectionStore.getState();
          const selection =
            element === null
              ? null
              : {
                  artifactId,
                  boardPath: path,
                  page: entry.page,
                  servedSha256,
                  element,
                  textRange: null,
                };
          if (point.additive === true)
            store.completeAdditivePick(
              selectionOwner,
              generation,
              selection,
              layout,
            );
          else store.completePick(selectionOwner, generation, selection);
        })
        .catch(() => {
          /* The next click can retry a frame replaced while answering. */
          useCanvasSelectionStore
            .getState()
            .completeAdditivePick(selectionOwner, generation, null, null);
        });
    },
    [artifactId, registry, selectionOwner],
  );
  const retire = useCallback(
    (path: string): void => {
      registry.update(path, { retype: null });
      useCanvasSelectionStore.getState().retire(selectionOwner, path);
    },
    [registry, selectionOwner],
  );
  const events = useMemo<CanvasFrameEvents>(
    () => ({
      ...parent,
      onSource: (path, source) => {
        registry.update(path, { source });
        parent?.onSource?.(path, source);
      },
      onDoubleClick: (path, element) => {
        if (useCanvasSelectionStore.getState().additionalElements.length > 0)
          return;
        const entry = registry.get(path);
        if (entry.bridge === null) return;
        registry.update(path, {
          retype: {
            id: crypto.randomUUID(),
            generation: useCanvasSelectionStore.getState().generation,
            element,
            sha256: entry.sha256,
            bridge: entry.bridge,
          },
        });
        parent?.onDoubleClick?.(path, element);
      },
      onBridge: (path, bridge) => {
        registry.update(path, { bridge });
        parent?.onBridge(path, bridge);
        const current = useCanvasSelectionStore.getState().selection;
        if (current?.artifactId !== artifactId || current.boardPath !== path)
          return;
        const tid = current.element.tid;
        if (tid === null) {
          if (bridge === null)
            useCanvasSelectionStore.getState().retire(selectionOwner, path);
          return;
        }
      },
      onStatus: (path, status) => {
        parent?.onStatus(path, status);
        const bridge = registry.get(path).bridge;
        const current = useCanvasSelectionStore.getState().selection;
        if (
          status !== "ready" ||
          bridge === null ||
          current?.artifactId !== artifactId ||
          current.boardPath !== path
        )
          return;
        if (useCanvasSelectionStore.getState().additionalElements.length > 0)
          void bridge.setTextSelectionTarget(null);
        else if (current.element.tid !== null)
          void bridge.setTextSelectionTarget({ tid: current.element.tid });
        else if (current.element.marker !== null)
          void bridge.setTextSelectionTarget({
            marker: current.element.marker,
          });
        const tid = current.element.tid;
        if (tid === null) return;
        const generation = useCanvasSelectionStore.getState().generation;
        void bridge
          .describeElement({ tid })
          .then((element) => {
            const selected = useCanvasSelectionStore.getState().selection;
            const mounted = registry.get(path);
            if (
              mounted.bridge !== bridge ||
              useCanvasSelectionStore.getState().generation !== generation ||
              selected?.artifactId !== artifactId ||
              selected.boardPath !== path ||
              selected.element.tid !== tid
            )
              return;
            if (element === null) {
              useCanvasSelectionStore.getState().clear();
              return;
            }
            if (mounted.sha256 !== null)
              useCanvasSelectionStore.getState().select({
                ...selected,
                servedSha256: mounted.sha256,
                element,
                textRange: null,
              });
          })
          .catch(() => {
            /* Preserve the durable tid while a replacement frame starts. */
          });
      },
      onFrame: (path, frame) => {
        registry.update(path, { frame });
        parent?.onFrame?.(path, frame);
      },
      onServedSource: (path, sha256) => {
        registry.update(path, { sha256 });
        parent?.onServedSource?.(path, sha256);
      },
      onBoardPage: (path, page) => {
        registry.update(path, { page });
        parent?.onBoardPage?.(path, page);
      },
      onSize: (path, size) => {
        registry.update(path, { size });
        parent?.onSize?.(path, size);
      },
      onBoardSelect: (path) => {
        registry.selectBoard(path);
        const selection = useCanvasSelectionStore.getState().selection;
        if (
          selection?.artifactId === artifactId &&
          selection.boardPath !== path
        )
          useCanvasSelectionStore.getState().clear();
        parent?.onBoardSelect?.(path);
      },
      onEditPointer: pick,
      onTextSelection: (path, range) => {
        if (useCanvasSelectionStore.getState().additionalElements.length > 0)
          return;
        useCanvasSelectionStore
          .getState()
          .setTextRange(artifactId, path, range);
        parent?.onTextSelection?.(path, range);
      },
      onAddError: (path, error) => {
        setErrorAttachment({ path, error });
        parent?.onAddError?.(path, error);
      },
      renderOverlay: (path) => (
        <CanvasEditingOverlay
          scope={scope}
          boardPath={path}
          registry={registry}
          onPick={pick}
          onRetire={retire}
        />
      ),
      renderPanel: (store) => (
        <CanvasSelectionPanel
          artifactId={artifactId}
          owner={selectionOwner}
          store={store}
          registry={registry}
        />
      ),
    }),
    [artifactId, parent, pick, registry, retire, scope, selectionOwner],
  );
  useEffect(() => {
    let previousPath: string | null = null;
    let previousKey: string | null = null;
    const syncTextTarget = (): void => {
      const state = useCanvasSelectionStore.getState();
      const selected = state.selection;
      const multiple = state.additionalElements.length > 0;
      if (
        previousPath !== null &&
        (selected?.artifactId !== artifactId ||
          selected.boardPath !== previousPath)
      ) {
        void registry.get(previousPath).bridge?.setTextSelectionTarget(null);
        previousPath = null;
        previousKey = null;
      }
      if (selected?.artifactId !== artifactId) return;
      const mounted = registry.get(selected.boardPath);
      const key = `${selected.boardPath}:${mounted.sha256}:${selected.element.marker}:${selected.element.tid}:${multiple}`;
      if (previousKey === key) return;
      previousPath = selected.boardPath;
      previousKey = key;
      let target: CanvasElementLocator | null = null;
      if (!multiple) {
        if (selected.element.tid !== null)
          target = { tid: selected.element.tid };
        else if (selected.element.marker !== null)
          target = { marker: selected.element.marker };
      }
      void mounted.bridge
        ?.setTextSelectionTarget(target)
        .then((accepted) => {
          if (!accepted) previousKey = null;
        })
        .catch(() => {
          previousKey = null;
        });
    };
    const unsubscribe = useCanvasSelectionStore.subscribe(syncTextTarget);
    const unsubscribeFrames = registry.subscribe(syncTextTarget);
    syncTextTarget();
    return () => {
      unsubscribe();
      unsubscribeFrames();
      if (previousPath !== null)
        void registry.get(previousPath).bridge?.setTextSelectionTarget(null);
    };
  }, [artifactId, registry]);
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      requestSequence.current += 1;
      useCanvasSelectionStore.getState().retire(selectionOwner, null);
      if (
        useCanvasSelectionStore.getState().selection?.artifactId === artifactId
      )
        useCanvasSelectionStore.getState().clear();
      setErrorAttachment(null);
    };
    window.addEventListener("keydown", escape);
    return () => {
      requestSequence.current += 1;
      window.removeEventListener("keydown", escape);
      useCanvasSelectionStore.getState().retire(selectionOwner, null);
    };
  }, [artifactId, selectionOwner]);
  return (
    <CanvasFrameEventsContext value={events}>
      <div className="relative h-full w-full">
        <CanvasClipboardBoundary artifactId={artifactId} registry={registry}>
          {props.children}
        </CanvasClipboardBoundary>
        {errorAttachment === null ? null : (
          <div className="absolute right-2 top-2 z-30 flex max-w-full items-start gap-1 rounded-md border bg-popover p-2 text-popover-foreground shadow-sm">
            <div className="flex min-w-0 flex-col gap-2">
              <p className="max-w-80 truncate text-ui-xs">
                {errorAttachment.error.message}
              </p>
              <CanvasAnnotationAction
                key={`${errorAttachment.path}:${errorAttachment.error.message}:${errorAttachment.error.stack}`}
                scope={scope}
                captureRect={() => null}
                record={() => ({
                  kind: "browser-annotation",
                  annotationId: crypto.randomUUID(),
                  source: {
                    kind: "canvas",
                    artifactId,
                    artifactTitle,
                    boardPath: errorAttachment.path,
                    canvasPage: registry.get(errorAttachment.path).page,
                  },
                  capturedAt: Date.now(),
                  comment: [
                    errorAttachment.error.message,
                    errorAttachment.error.stack,
                  ]
                    .filter((line) => line !== null)
                    .join("\n"),
                  counts: { elements: 0, regions: 0, strokes: 0 },
                  elements: [],
                  imageFileName: null,
                  imageHash: null,
                  droppedElementCount: 0,
                })}
              />
            </div>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Dismiss error attachment"
              onClick={() => setErrorAttachment(null)}
            >
              <X />
            </Button>
          </div>
        )}
      </div>
    </CanvasFrameEventsContext>
  );
}

function CanvasSelectionPanel(props: {
  readonly owner: symbol;
  readonly artifactId: string;
  readonly store: CanvasLayoutStore;
  readonly registry: CanvasFrameRegistry;
}) {
  useSyncExternalStore(props.registry.subscribe, props.registry.getSnapshot);
  const selected = useCanvasSelectionStore((state) =>
    state.selection?.artifactId === props.artifactId ? state.selection : null,
  );
  const path = selected?.boardPath ?? props.registry.boardPath;
  if (path === null) return null;
  return (
    <aside className="h-full w-full min-w-0 max-w-sm overflow-y-auto border-l bg-card">
      <CanvasEditingPanel
        key={path}
        artifactId={props.artifactId}
        boardPath={path}
        registry={props.registry}
        owner={props.owner}
      >
        {selected === null ? (
          <CanvasBoardPanel
            store={props.store}
            boardPath={path}
            contentHeight={props.registry.get(path).size?.height ?? null}
          />
        ) : (
          <CanvasElementEditingPanel
            selection={selected}
            registry={props.registry}
          />
        )}
      </CanvasEditingPanel>
    </aside>
  );
}
