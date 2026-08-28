import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import { Maximize2, X } from "lucide-react";
import type {
  BrowserSessionInfo,
  BrowserTabInfo,
} from "@traycer/protocol/host/browser/contracts";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useCanvasHostId } from "@/components/epic-canvas/hooks/use-canvas-host-id";
import { useBrowserSessionsContext } from "@/components/epic-canvas/renderers/browser-sessions-context";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import {
  browserTabFaviconUrl,
  browserTabHostname,
  resolveTabTitle,
} from "@/lib/browser-view/browser-tab-display";
import {
  clampPipGeometry,
  defaultPipGeometry,
  geometryForCorner,
  nextPipCorner,
  PIP_NUDGE_PX,
  PIP_RESIZE_STEP_PX,
  readViewportSize,
} from "@/lib/browser-view/pip/pip-geometry";
import { usePipOwnedFrame } from "@/lib/browser-view/pip/pip-frame-capture";
import { useRemotePipSessions } from "@/lib/browser-view/pip/use-pip-epic-sessions";
import {
  captionFreshness,
  dismissPip,
  PIP_CAPTION_FADE_MS,
  PIP_CAPTION_HOLD_MS,
  usePipSnapshot,
  type PipCaption,
  type PipSnapshot,
  type PipStreamHealth,
  type PipTarget,
} from "@/lib/browser-view/pip/pip-store";
import { cn } from "@/lib/utils";
import { useEpicChatRecords } from "@/lib/epic-selectors";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import {
  findOpenTileInTab,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";
import { makeBrowserSessionTileRef } from "@/stores/epics/canvas/tile-schema/browser-tile";
import type { EpicPipGeometry } from "@/stores/epics/canvas/types";

const PIP_DRAG_CLICK_SLOP_PX = 4;
const PIP_OVERLAY_KIND = "pip";

export function AgentBrowserPip(props: {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly surfaceVisible: boolean;
}): ReactElement | null {
  const epicHandle = useMaybeOpenEpicHandle();
  const snapshot = usePipSnapshot(props.epicId);
  if (
    epicHandle === null ||
    !props.surfaceVisible ||
    (snapshot.target === null && snapshot.pendingTarget === null)
  ) {
    return null;
  }
  return (
    <ActiveAgentBrowserPip
      epicId={props.epicId}
      viewTabId={props.viewTabId}
      snapshot={snapshot}
    />
  );
}

function ActiveAgentBrowserPip(props: {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly snapshot: PipSnapshot;
}): ReactElement {
  const snapshot = props.snapshot;
  const canvasHostId = useCanvasHostId();
  const primaryItems = useBrowserSessionsContext().items;
  const remoteHostIds = useMemo(() => {
    const targetHostIds = [
      snapshot.target?.hostId,
      snapshot.pendingTarget?.hostId,
    ].filter(
      (hostId): hostId is string =>
        hostId !== undefined && hostId !== canvasHostId,
    );
    return Array.from(new Set(targetHostIds));
  }, [canvasHostId, snapshot.pendingTarget?.hostId, snapshot.target?.hostId]);
  const remoteItems = useRemotePipSessions(props.epicId, remoteHostIds);
  const items = useMemo(
    () => [...primaryItems, ...remoteItems],
    [primaryItems, remoteItems],
  );
  return (
    <AgentBrowserPipSurface
      epicId={props.epicId}
      viewTabId={props.viewTabId}
      snapshot={snapshot}
      items={items}
    />
  );
}

function AgentBrowserPipSurface(props: {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly snapshot: PipSnapshot;
  readonly items: readonly BrowserSessionInfo[];
}): ReactElement {
  const { epicId, snapshot } = props;
  const frameSrc = usePipOwnedFrame(epicId, snapshot);
  const persisted = useEpicCanvasStore(
    (state) => state.pipGeometryByEpicId[epicId],
  );
  const setPipGeometry = useEpicCanvasStore((state) => state.setPipGeometry);
  const [viewport, setViewport] = useState(readViewportSize);
  const rawGeometry = persisted ?? defaultPipGeometry(viewport);
  const geometry = clampPipGeometry(
    rawGeometry,
    viewport,
    rawGeometry.previewHeight,
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<PipPointerSession | null>(null);
  const dragMovedRef = useRef(false);

  useEffect(() => {
    const onResize = (): void => {
      setViewport(readViewportSize());
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const commitGeometry = useCallback(
    (next: EpicPipGeometry) => {
      const nextViewport = readViewportSize();
      setPipGeometry(
        epicId,
        clampPipGeometry(next, nextViewport, next.previewHeight),
      );
    },
    [epicId, setPipGeometry],
  );

  const applyLiveGeometry = useCallback((next: EpicPipGeometry) => {
    const node = rootRef.current;
    if (node === null) return;
    const fitted = clampPipGeometry(
      next,
      readViewportSize(),
      next.previewHeight,
    );
    const box = pipRootBox(fitted);
    node.style.left = `${String(box.left)}px`;
    node.style.top = `${String(box.top)}px`;
    node.style.width = `${String(box.width)}px`;
    node.style.height = `${String(box.height)}px`;
    node.style.setProperty(
      "--pip-preview-height",
      `${String(fitted.previewHeight)}px`,
    );
  }, []);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, mode: "move" | "resize") => {
      if (event.button !== 0) return;
      if (
        mode === "move" &&
        event.target instanceof Element &&
        event.target.closest("button") !== null
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      dragMovedRef.current = false;
      dragRef.current = {
        pointerId: event.pointerId,
        mode,
        startX: event.clientX,
        startY: event.clientY,
        origin: geometry,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [geometry],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (drag === null || drag.pointerId !== event.pointerId) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (
        Math.abs(dx) > PIP_DRAG_CLICK_SLOP_PX ||
        Math.abs(dy) > PIP_DRAG_CLICK_SLOP_PX
      ) {
        dragMovedRef.current = true;
      }
      applyLiveGeometry(
        drag.mode === "move"
          ? {
              ...drag.origin,
              anchorX: drag.origin.anchorX + dx,
              anchorY: drag.origin.anchorY + dy,
            }
          : {
              ...drag.origin,
              anchorX: drag.origin.anchorX + dx,
              anchorY: drag.origin.anchorY + dy,
              previewWidth: drag.origin.previewWidth + dx,
              previewHeight: drag.origin.previewHeight + dy,
            },
      );
    },
    [applyLiveGeometry],
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (drag === null || drag.pointerId !== event.pointerId) return;
      dragRef.current = null;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      commitGeometry(
        drag.mode === "move"
          ? {
              ...drag.origin,
              anchorX: drag.origin.anchorX + dx,
              anchorY: drag.origin.anchorY + dy,
            }
          : {
              ...drag.origin,
              anchorX: drag.origin.anchorX + dx,
              anchorY: drag.origin.anchorY + dy,
              previewWidth: drag.origin.previewWidth + dx,
              previewHeight: drag.origin.previewHeight + dy,
            },
      );
    },
    [commitGeometry],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismissPip(epicId);
        return;
      }
      if (
        !(event.target instanceof Element) ||
        !event.target.hasAttribute("data-pip-geometry-controls")
      ) {
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        const corner = nextPipCorner(
          geometry,
          readViewportSize(),
          geometry.previewHeight,
        );
        commitGeometry(
          geometryForCorner(
            corner,
            geometry,
            readViewportSize(),
            geometry.previewHeight,
          ),
        );
        return;
      }
      const step = event.shiftKey ? PIP_RESIZE_STEP_PX : PIP_NUDGE_PX;
      const resize = event.shiftKey;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        commitGeometry(
          resize
            ? { ...geometry, previewWidth: geometry.previewWidth - step }
            : { ...geometry, anchorX: geometry.anchorX - step },
        );
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        commitGeometry(
          resize
            ? { ...geometry, previewWidth: geometry.previewWidth + step }
            : { ...geometry, anchorX: geometry.anchorX + step },
        );
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        commitGeometry(
          resize
            ? { ...geometry, previewHeight: geometry.previewHeight - step }
            : { ...geometry, anchorY: geometry.anchorY - step },
        );
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        commitGeometry(
          resize
            ? { ...geometry, previewHeight: geometry.previewHeight + step }
            : { ...geometry, anchorY: geometry.anchorY + step },
        );
      }
    },
    [commitGeometry, epicId, geometry],
  );

  const rootStyle: PipRootStyle = {
    "--pip-preview-height": `${String(geometry.previewHeight)}px`,
    ...pipRootBox(geometry),
  };
  const displayed = snapshot.target !== null;

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label="Browser picture in picture"
      aria-hidden={!displayed}
      data-testid="agent-browser-pip"
      data-browser-overlay={PIP_OVERLAY_KIND}
      data-browser-overlay-id={`agent-browser-pip-${epicId}`}
      data-pip-selection-id={snapshot.target?.selectionId ?? ""}
      data-pip-host-id={snapshot.target?.hostId ?? ""}
      data-pip-health={snapshot.streamHealth}
      className={cn(
        "fixed z-40 overflow-hidden rounded-lg border border-border/80 bg-popover/95 shadow-xl backdrop-blur-sm",
        !displayed && "invisible pointer-events-none",
      )}
      style={rootStyle}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onKeyDownCapture={handleKeyDown}
    >
      <PipWindow
        epicId={epicId}
        viewTabId={props.viewTabId}
        snapshot={snapshot}
        items={props.items}
        frameSrc={frameSrc}
        dragMovedRef={dragMovedRef}
        onHeaderPointerDown={(event) => handlePointerDown(event, "move")}
        onResizePointerDown={(event) => handlePointerDown(event, "resize")}
      />
    </div>
  );
}

type PipRootStyle = CSSProperties & {
  readonly "--pip-preview-height": string;
};

function pipRootBox(geometry: EpicPipGeometry): {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
} {
  return {
    left: geometry.anchorX - geometry.previewWidth,
    top: geometry.anchorY - geometry.previewHeight,
    width: geometry.previewWidth,
    height: geometry.previewHeight,
  };
}

function PipWindow(props: {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly snapshot: PipSnapshot;
  readonly items: readonly BrowserSessionInfo[];
  readonly frameSrc: string | null;
  readonly dragMovedRef: { current: boolean };
  readonly onHeaderPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onResizePointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
}): ReactElement {
  const { snapshot, frameSrc, dragMovedRef } = props;
  const meta = usePipTargetMeta(snapshot.target, props.items);
  const openTile = useOpenPipTarget(props.epicId, props.viewTabId, props.items);
  const restore = (): void => {
    if (snapshot.target === null || !meta.available) return;
    openTile(snapshot.target);
    dismissPip(props.epicId);
  };
  const attribution = [meta.agentName, meta.hostLabel].filter(
    (part): part is string => part !== null && part.length > 0,
  );
  const statusTone = streamHealthTone(snapshot.streamHealth);

  return (
    <div className="relative flex h-(--pip-preview-height) min-h-0 flex-col">
      <div
        role="toolbar"
        tabIndex={0}
        data-pip-geometry-controls
        aria-label="Browser picture in picture"
        className="flex min-h-8 shrink-0 items-center gap-2 px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onPointerDown={props.onHeaderPointerDown}
      >
        <PipFavicon url={meta.faviconUrl} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-ui-xs font-medium text-foreground">
            {meta.title}
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-ui-xs leading-none text-muted-foreground">
            <span
              aria-hidden
              className={cn("size-1.5 shrink-0 rounded-full", statusTone)}
            />
            <span className="truncate">
              {attribution.length > 0 ? attribution.join(" · ") : meta.site}
            </span>
          </div>
        </div>
        <button
          type="button"
          aria-label={
            meta.available
              ? "Restore browser tile"
              : "Browser tab is unavailable"
          }
          disabled={!meta.available}
          data-testid="agent-browser-pip-open"
          className="flex size-6 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-foreground/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
          onClick={restore}
        >
          <Maximize2 className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Close picture in picture"
          data-testid="agent-browser-pip-close"
          className="flex size-6 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-foreground/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => dismissPip(props.epicId)}
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
      <button
        type="button"
        aria-label={meta.available ? "Restore browser tile" : "Browser preview"}
        disabled={!meta.available}
        className="relative min-h-0 flex-1 overflow-hidden bg-background p-0 text-left disabled:cursor-default"
        onClick={() => {
          if (dragMovedRef.current) {
            dragMovedRef.current = false;
            return;
          }
          restore();
        }}
      >
        {frameSrc === null ? (
          <span className="absolute inset-0 flex items-center justify-center text-muted-foreground">
            <AgentSpinningDots
              className={undefined}
              testId="agent-browser-pip-loading"
              variant={undefined}
            />
          </span>
        ) : (
          <img
            src={frameSrc}
            alt="Browser preview"
            className="h-full w-full object-contain outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
            draggable={false}
          />
        )}
        <PipCaptionBadge caption={snapshot.caption} />
        {snapshot.pendingTarget !== null ? (
          <span className="absolute inset-x-2 bottom-2 rounded-md bg-background/85 px-2 py-1 text-center text-ui-xs text-muted-foreground">
            Switching picture in picture…
          </span>
        ) : null}
      </button>
      <button
        type="button"
        aria-label="Resize picture in picture"
        data-pip-geometry-controls
        className="absolute right-0 bottom-0 size-5 cursor-nwse-resize touch-none bg-transparent outline-none after:absolute after:right-1 after:bottom-1 after:size-2 after:border-r after:border-b after:border-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring"
        onPointerDown={props.onResizePointerDown}
      />
    </div>
  );
}

function PipCaptionBadge(props: {
  readonly caption: PipCaption | null;
}): ReactElement | null {
  const { caption } = props;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (caption === null) return;
    const deadlines = [
      caption.arrivedAt + PIP_CAPTION_HOLD_MS,
      caption.arrivedAt + PIP_CAPTION_HOLD_MS + PIP_CAPTION_FADE_MS,
    ];
    const timers = deadlines.map((deadline) =>
      window.setTimeout(
        () => setNow(Date.now()),
        Math.max(0, deadline - Date.now()),
      ),
    );
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [caption]);
  if (caption === null) return null;
  const freshness = captionFreshness(caption, now);
  if (freshness === "expired") return null;
  return (
    <span
      data-testid="agent-browser-pip-caption"
      className={cn(
        "pointer-events-none absolute bottom-2 left-2 max-w-[min(85%,20rem)] truncate rounded-md bg-background/80 px-1.5 py-0.5 text-ui-xs text-muted-foreground transition-opacity duration-300",
        freshness === "fading" ? "opacity-0" : "opacity-90",
      )}
    >
      {caption.cellTitle}
    </span>
  );
}

function PipFavicon(props: { readonly url: string | null }): ReactElement {
  if (props.url === null) {
    return (
      <span
        aria-hidden
        className="size-3.5 shrink-0 rounded-sm bg-muted-foreground/30"
      />
    );
  }
  return (
    <img
      src={props.url}
      alt=""
      className="size-3.5 shrink-0 rounded-sm"
      onError={(event) => {
        event.currentTarget.style.visibility = "hidden";
      }}
    />
  );
}

function streamHealthTone(health: PipStreamHealth): string {
  if (health === "live") return "bg-emerald-400";
  if (health === "stale") return "bg-amber-400";
  return "bg-muted-foreground/40";
}

function resolvePipHostLabel(
  target: PipTarget | null,
  canvasHostId: string | null,
  label: string | null,
): string | null {
  if (
    target === null ||
    canvasHostId === null ||
    target.hostId === canvasHostId
  ) {
    return null;
  }
  return label ?? target.hostId;
}

function resolvePipTabMeta(tab: BrowserTabInfo | undefined): {
  readonly title: string;
  readonly site: string | null;
  readonly faviconUrl: string | null;
} {
  if (tab === undefined) {
    return { title: "Browser", site: null, faviconUrl: null };
  }
  return {
    title: resolveTabTitle(tab),
    site: browserTabHostname(tab.url),
    faviconUrl: browserTabFaviconUrl(tab.url),
  };
}

function usePipTargetMeta(
  target: PipTarget | null,
  items: readonly BrowserSessionInfo[],
): {
  readonly title: string;
  readonly site: string | null;
  readonly faviconUrl: string | null;
  readonly agentName: string | null;
  readonly hostLabel: string | null;
  readonly available: boolean;
} {
  const chats = useEpicChatRecords();
  const canvasHostId = useCanvasHostId();
  const hostEntry = useHostDirectoryEntry(target?.hostId ?? "");
  const session =
    target === null
      ? undefined
      : findPipSession(items, target.hostId, target.sessionId);
  const tab = session?.tabs.find((item) => item.tabId === target?.tabId);
  const driverChatId = tab?.drivenBy.at(-1)?.chatId ?? null;
  const agentName =
    chats.find((chat) => chat.id === driverChatId)?.title ?? null;
  const hostLabel = resolvePipHostLabel(
    target,
    canvasHostId,
    hostEntry?.label ?? null,
  );
  const tabMeta = resolvePipTabMeta(tab);
  return {
    ...tabMeta,
    agentName,
    hostLabel,
    available: session !== undefined && tab !== undefined,
  };
}

function useOpenPipTarget(
  epicId: string,
  viewTabId: string,
  items: readonly BrowserSessionInfo[],
): (target: PipTarget) => void {
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareOpen = useEpicCanvasStore(
    (state) => state.prepareOpenTileInTabFocusTarget,
  );
  const prepareFocus = useEpicCanvasStore(
    (state) => state.prepareSetActiveTileTabFocusTarget,
  );
  return useCallback(
    (target: PipTarget) => {
      const session = findPipSession(items, target.hostId, target.sessionId);
      const tab = session?.tabs.find((item) => item.tabId === target.tabId);
      if (session === undefined || tab === undefined) return;
      const tile = makeBrowserSessionTileRef({
        hostId: target.hostId,
        sessionId: target.sessionId,
        tabId: target.tabId,
      });
      const existingPointer = findOpenTileInTab(viewTabId, {
        id: tile.id,
        hostId: target.hostId,
      });
      navigateNested(epicId, viewTabId, () =>
        existingPointer === null
          ? prepareOpen(viewTabId, tile)
          : prepareFocus(
              viewTabId,
              existingPointer.paneId,
              existingPointer.instanceId,
            ),
      );
    },
    [epicId, items, navigateNested, prepareFocus, prepareOpen, viewTabId],
  );
}

function findPipSession(
  items: readonly BrowserSessionInfo[],
  hostId: string,
  sessionId: string,
): BrowserSessionInfo | undefined {
  return items.find(
    (session) => session.hostId === hostId && session.sessionId === sessionId,
  );
}

interface PipPointerSession {
  readonly pointerId: number;
  readonly mode: "move" | "resize";
  readonly startX: number;
  readonly startY: number;
  readonly origin: EpicPipGeometry;
}
