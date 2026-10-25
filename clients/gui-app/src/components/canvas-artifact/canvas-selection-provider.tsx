import { useCommentThreadsStore } from "@/stores/comments/comment-threads-store";
import { usePaneFocused } from "@/components/epic-tabs/pane-visibility-context";
import { useQueryClient } from "@tanstack/react-query";
import {
  AnchoredDraftPopover,
  type AnchoredDraftTidInsertion,
} from "@/components/comments/anchored-draft-popover";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useFrameCommentsEnabled } from "@/hooks/comments/use-frame-comments-enabled";
import { useAnchoredDraftStore } from "@/stores/comments/anchored-draft-store";
import { openFrameCommentDraft } from "@/lib/comments/open-frame-comment-draft";
import type { SandboxBridgeHost } from "@/lib/sandbox/bridge-host";
import {
  CanvasCommentIndex,
  CanvasCommentPins,
  CanvasCommentPointPins,
  CanvasCommentsControl,
  CanvasCommentsSidebar,
} from "./canvas-comments";
import type { CanvasSelection } from "./canvas-selection-store";
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
import {
  isCanvasBoardRoot,
  useCanvasSelectionStore,
} from "./canvas-selection-store";
import {
  CanvasAnnotationAction,
  type CanvasAnnotationScope,
} from "./canvas-annotation-action";
import { CanvasBoardPanel } from "./canvas-board-panel";
import type { CanvasLayoutStore } from "./canvas-layout-store";
import { frameLocator } from "./canvas-structure-identity";

function sameSelectedBoard(
  selection: CanvasSelection | null,
  artifactId: string,
  path: string,
  sha256: string,
): boolean {
  return (
    selection?.artifactId === artifactId &&
    selection.boardPath === path &&
    selection.servedSha256 === sha256
  );
}

export function CanvasSelectionProvider(
  props: CanvasAnnotationScope & {
    readonly children: ReactNode;
    readonly viewOnly?: boolean;
  },
) {
  const { epicId, artifactId, artifactTitle, hostId, viewTabId } = props;
  const scope = useMemo(
    () => ({ epicId, artifactId, artifactTitle, hostId, viewTabId }),
    [epicId, artifactId, artifactTitle, hostId, viewTabId],
  );
  const parent = useContext(CanvasFrameEventsContext);
  const [registry] = useState(() => new CanvasFrameRegistry());
  const hostClient = useTabHostClient();
  const queryClient = useQueryClient();
  const paneFocused = usePaneFocused();
  const commentsEnabled = useFrameCommentsEnabled() && props.viewOnly !== true;
  const [draftOwner] = useState(() => crypto.randomUUID());
  const [commentMessage, setCommentMessage] = useState<string | null>(null);
  const openComment = useCallback(
    (selection: CanvasSelection): void => {
      if (!commentsEnabled) return;
      const entry = registry.get(selection.boardPath);
      if (entry.bridge === null || entry.frame === null) return;
      const generation = useCanvasSelectionStore.getState().generation;
      void openFrameCommentDraft({
        epicId,
        tileId: draftOwner,
        artifactType: "canvas",
        selection,
        bridge: entry.bridge,
        frame: entry.frame,
        source: entry.source,
        queryClient,
        isCurrent: () =>
          registry.get(selection.boardPath).bridge === entry.bridge &&
          registry.get(selection.boardPath).sha256 === selection.servedSha256 &&
          useCanvasSelectionStore.getState().generation === generation,
      })
        .then(setCommentMessage)
        .catch(() =>
          setCommentMessage("The page changed. Select the element again."),
        );
    },
    [commentsEnabled, registry, epicId, draftOwner, queryClient],
  );
  const [selectionOwner] = useState(() => Symbol("canvas-selection"));
  // The revision each board's LIVE document adopted in place (a stamped
  // comment tid): its frame keeps the mounted document when the head moves to
  // `after`. Keyed to the bridge so a replaced document never inherits an old
  // certificate - a reverted-then-redone head must reload normally.
  const adoptedRevisions = useRef(
    new Map<
      string,
      {
        readonly bridge: SandboxBridgeHost;
        readonly from: string;
        readonly to: string;
      }
    >(),
  );
  const adoptInsertedTid = useCallback(
    async (insertion: AnchoredDraftTidInsertion): Promise<void> => {
      const entry = registry.get(insertion.boardPath);
      if (entry.bridge === null || entry.sha256 !== insertion.sha256Before)
        return;
      const stamped = await entry.bridge
        .stampTid({
          marker: insertion.marker,
          tagName: insertion.tagName,
          tid: insertion.tid,
        })
        .catch(() => false);
      if (!stamped) return;
      // Later markers in the live document move with the inserted attribute,
      // so a second comment on this board still locates its element. Every
      // shift must land; a document that lost one cannot claim the revision.
      for (const splice of insertion.splices) {
        const shifted = await entry.bridge
          .shiftMarkers({
            at: splice.start,
            delta: splice.replacement.length - (splice.end - splice.start),
          })
          .catch(() => false);
        if (!shifted) return;
      }
      // Revalidate against the live frame: a replacement document that
      // mounted during the awaits above owns the registry now.
      const current = registry.get(insertion.boardPath);
      if (
        current.bridge !== entry.bridge ||
        current.sha256 !== insertion.sha256Before
      )
        return;
      adoptedRevisions.current.set(insertion.boardPath, {
        bridge: entry.bridge,
        from: insertion.sha256Before,
        to: insertion.sha256After,
      });
      registry.update(insertion.boardPath, {
        sha256: insertion.sha256After,
      });
    },
    [registry],
  );
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
      if (registry.view?.commenting)
        useCommentThreadsStore.getState().setActiveThread(epicId, null);
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
        .then(async (hit) => {
          const element = isCanvasBoardRoot(hit) ? null : hit;
          const primary = useCanvasSelectionStore.getState().selection;
          const locator =
            primary === null ? null : frameLocator(primary.element);
          const layout =
            point.additive === true &&
            locator !== null &&
            sameSelectedBoard(primary, artifactId, path, servedSha256)
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
          if (selection !== null && registry.view?.tool === "comment")
            openComment(selection);
        })
        .catch(() => {
          /* The next click can retry a frame replaced while answering. */
          useCanvasSelectionStore
            .getState()
            .completeAdditivePick(selectionOwner, generation, null, null);
        });
    },
    [artifactId, registry, selectionOwner, openComment, epicId],
  );
  const retire = useCallback(
    (path: string): void => {
      registry.update(path, { retype: null });
      useCanvasSelectionStore.getState().retire(selectionOwner, path);
    },
    [registry, selectionOwner],
  );
  const escapeSelection = useCallback((): void => {
    registry.view?.setCommenting(false);
    requestSequence.current += 1;
    const state = useCanvasSelectionStore.getState();
    const hadElement =
      state.selection?.artifactId === artifactId ||
      state.pendingPick?.owner === selectionOwner;
    state.retire(selectionOwner, null);
    if (useCanvasSelectionStore.getState().selection?.artifactId === artifactId)
      useCanvasSelectionStore.getState().clear();
    if (!hadElement) {
      registry.view?.clearNodeSelection();
      registry.selectBoard(null);
      parent?.onBoardSelect?.(null);
    }
    setErrorAttachment(null);
  }, [artifactId, selectionOwner, registry, parent]);
  const events = useMemo<CanvasFrameEvents>(
    () => ({
      ...parent,
      commentsEnabled,
      onCanvasView: (view) => {
        registry.setView(view);
        parent?.onCanvasView?.(view);
      },
      onPaneComment: (point) => {
        if (!commentsEnabled) return;
        useCommentThreadsStore.getState().setActiveThread(epicId, null);
        useAnchoredDraftStore.getState().setDraft(epicId, {
          draftId: crypto.randomUUID(),
          tileId: draftOwner,
          artifactId,
          artifactType: "canvas",
          anchor: {
            kind: "canvas-point",
            page: point.page,
            x: point.canvas.x,
            y: point.canvas.y,
            label: "Pinned on canvas",
          },
          quotedText: "",
          selection: null,
          retargeted: false,
          rect: { ...point.screen, width: 0, height: 0 },
        });
      },
      renderCanvasPins: (page, viewport) => (
        <CanvasCommentPointPins
          scope={scope}
          page={page}
          viewport={viewport}
          registry={registry}
        />
      ),
      renderToolbarControls: () =>
        commentsEnabled ? <CanvasCommentsControl registry={registry} /> : null,
      renderCommentsSidebar: () => <CanvasCommentsSidebar scope={scope} />,
      renderCommentDraft: () =>
        props.viewOnly === true ? null : (
          <AnchoredDraftPopover
            epicId={epicId}
            artifactId={artifactId}
            tileId={draftOwner}
            hostClient={hostClient}
            onCreated={() => undefined}
            onClosed={() => undefined}
            onTidInserted={adoptInsertedTid}
          />
        ),
      sourceAdopted: (path, previousSha256, nextSha256) => {
        const record = adoptedRevisions.current.get(path);
        return (
          record !== undefined &&
          record.from === previousSha256 &&
          record.to === nextSha256 &&
          record.bridge === registry.get(path).bridge
        );
      },
      onSource: (path, source) => {
        registry.update(path, { source });
        parent?.onSource?.(path, source);
      },
      onDoubleClick: (path, element) => {
        if (props.viewOnly === true || registry.view?.tool === "comment")
          return;
        if (useCanvasSelectionStore.getState().additionalElements.length > 0)
          return;
        const entry = registry.get(path);
        if (
          entry.bridge === null ||
          entry.sha256 === null ||
          isCanvasBoardRoot(element)
        )
          return;
        requestSequence.current += 1;
        registry.selectBoard(path);
        const store = useCanvasSelectionStore.getState();
        const generation = store.beginPick(selectionOwner, artifactId, path);
        store.completePick(selectionOwner, generation, {
          artifactId,
          boardPath: path,
          page: entry.page,
          servedSha256: entry.sha256,
          element,
          textRange: null,
        });
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
        const state = useCanvasSelectionStore.getState();
        const selection = state.selection;
        if (
          path === null ||
          (selection?.artifactId === artifactId &&
            selection.boardPath !== path) ||
          (state.pendingPick?.owner === selectionOwner &&
            state.pendingPick.boardPath !== path)
        ) {
          requestSequence.current += 1;
          state.retire(selectionOwner, null);
          if (selection?.artifactId === artifactId) state.clear();
        }
        parent?.onBoardSelect?.(path);
      },
      onEditPointer: pick,
      onTextSelection: (path, range) => {
        if (useCanvasSelectionStore.getState().additionalElements.length > 0)
          return;
        useCanvasSelectionStore
          .getState()
          .setTextRange(artifactId, path, range);
        const selection = useCanvasSelectionStore.getState().selection;
        const draft = useAnchoredDraftStore.getState().byEpicId[epicId];
        if (
          range !== null &&
          selection?.artifactId === artifactId &&
          (registry.view?.tool === "comment" || draft?.tileId === draftOwner)
        )
          openComment(selection);
        parent?.onTextSelection?.(path, range);
      },
      onAddError: (path, error) => {
        setErrorAttachment({ path, error });
        parent?.onAddError?.(path, error);
      },
      renderOverlay: (path, editing) => (
        <>
          {editing && props.viewOnly !== true ? (
            <CanvasEditingOverlay
              scope={scope}
              commenting={registry.view?.commenting === true}
              tileId={draftOwner}
              boardPath={path}
              registry={registry}
              onPick={pick}
              onRetire={retire}
              onEscape={escapeSelection}
            />
          ) : null}
          <CanvasCommentPins
            scope={scope}
            boardPath={path}
            registry={registry}
          />
        </>
      ),
      renderPanel: (store, { onClose }) => (
        <CanvasSelectionPanel
          artifactId={artifactId}
          owner={selectionOwner}
          store={store}
          registry={registry}
          onClose={onClose}
        />
      ),
    }),
    [
      artifactId,
      parent,
      pick,
      registry,
      retire,
      escapeSelection,
      scope,
      selectionOwner,
      commentsEnabled,
      epicId,
      draftOwner,
      openComment,
      adoptInsertedTid,
      props.viewOnly,
      hostClient,
    ],
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
      if (event.key !== "Escape" || event.defaultPrevented || !paneFocused)
        return;
      if (
        useAnchoredDraftStore.getState().byEpicId[epicId]?.tileId === draftOwner
      )
        return;
      escapeSelection();
      event.preventDefault();
    };
    window.addEventListener("keydown", escape);
    return () => {
      requestSequence.current += 1;
      window.removeEventListener("keydown", escape);
      useCanvasSelectionStore.getState().retire(selectionOwner, null);
    };
  }, [selectionOwner, paneFocused, escapeSelection, epicId, draftOwner]);
  return (
    <CanvasFrameEventsContext value={events}>
      <div className="relative h-full w-full">
        {props.viewOnly === true ? (
          props.children
        ) : (
          <CanvasClipboardBoundary artifactId={artifactId} registry={registry}>
            {props.children}
          </CanvasClipboardBoundary>
        )}
        <CanvasCommentIndex
          scope={scope}
          tileId={draftOwner}
          registry={registry}
        />
        {commentMessage === null ? null : (
          <div
            role="status"
            className="absolute bottom-2 left-2 z-30 rounded-md border bg-popover p-2 text-ui-xs text-popover-foreground"
          >
            {commentMessage}
          </div>
        )}
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
  readonly onClose: () => void;
}) {
  const path = useSyncExternalStore(
    props.registry.subscribe,
    () => props.registry.boardPath,
  );
  const contentHeight = useSyncExternalStore(props.registry.subscribe, () =>
    path === null ? null : (props.registry.get(path).size?.height ?? null),
  );
  const selected = useCanvasSelectionStore((state) =>
    state.selection?.artifactId === props.artifactId &&
    state.selection.boardPath === path
      ? state.selection
      : null,
  );
  return (
    <aside
      aria-label="Inspector"
      className="flex h-full w-full min-w-0 max-w-sm flex-col overflow-hidden border-l bg-card shadow-lg"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 p-3">
        <span className="text-ui-sm font-medium">Inspector</span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Close inspector"
          onClick={props.onClose}
        >
          <X />
        </Button>
      </div>
      {path === null ? (
        <p className="p-3 text-ui-xs text-muted-foreground">
          Select an artboard to inspect it.
        </p>
      ) : (
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
              contentHeight={contentHeight}
            />
          ) : (
            <CanvasElementEditingPanel
              selection={selected}
              registry={props.registry}
            />
          )}
        </CanvasEditingPanel>
      )}
    </aside>
  );
}
