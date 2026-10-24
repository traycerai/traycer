import { useRef, useState, type ReactNode } from "react";
import { ArrowLeft, House, Minus, Plus } from "lucide-react";
import { ActualSizeGlyph } from "@/components/epic-canvas/zoom-controls/zoom-controls";
import { useCoarsePointer } from "@/hooks/ui/use-coarse-pointer";
import {
  SandboxFrame,
  type SandboxPageNavigation,
  type SandboxSource,
} from "@/components/sandbox/sandbox-frame";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import type {
  SandboxBridgeHost,
  SandboxSize,
  SandboxStatus,
} from "@/lib/sandbox/bridge-host";
import type { CanvasTextSelection } from "@/lib/sandbox/canvas-bridge";
import { cn } from "@/lib/utils";

const NO_PERMISSIONS = [] as const;
const noop = (): void => undefined;

interface PageHistory {
  readonly entryPath: string;
  readonly currentPath: string;
  /** Pages to go back to, the most recent last. There is no Forward. */
  readonly backStack: readonly string[];
  readonly missing: boolean;
  /** Counts Back and Home, see {@link SandboxPageNavigation.visit}. */
  readonly visit: number;
}

function freshHistory(entryPath: string): PageHistory {
  return {
    entryPath,
    currentPath: entryPath,
    backStack: [],
    missing: false,
    visit: 0,
  };
}

/**
 * A served plain-html artifact: a folder of pages the reader moves between
 * inside one frame. The app keeps its own page stack, so Back and Home work
 * whatever the page does, and a link to a page the folder lacks says so
 * instead of leaving a blank frame. Every surface that shows such an
 * artifact (the canvas tile, the chat row) renders it through here.
 */
export function ArtifactPagesFrame(props: {
  readonly source: Extract<SandboxSource, { kind: "artifact" }>;
  readonly title: string;
  readonly className: string;
  /** The page's height in px, or `null` to fill what the row leaves. */
  readonly height: number | null;
  readonly onSize: (size: SandboxSize) => void;
  readonly onStatus: (status: SandboxStatus) => void;
  readonly onBridge: ((bridge: SandboxBridgeHost | null) => void) | null;
  readonly onTextSelection:
    | ((selection: CanvasTextSelection | null) => void)
    | null;
  /** Hands over the iframe element, and `null` once it is gone. */
  readonly onFrame: ((frame: HTMLIFrameElement | null) => void) | null;
  /**
   * Layers drawn over the page. Comments and selection are anchored to the
   * entry page's bytes, so they are told when another page is showing.
   */
  readonly renderOverlay: ((onEntryPage: boolean) => ReactNode) | null;
  readonly toolbarControls?: ReactNode;
}) {
  const {
    source,
    title,
    className,
    height,
    onSize,
    onStatus,
    onBridge,
    onTextSelection,
    onFrame,
    renderOverlay,
  } = props;
  const entryPath = source.entryPath === "" ? "index.html" : source.entryPath;
  const bridgeRef = useRef<SandboxBridgeHost | null>(null);
  const scaleRef = useRef(1);
  const [scale, setScale] = useState(1);
  const [ready, setReady] = useState(false);
  const coarsePointer = useCoarsePointer();
  const controlSize = coarsePointer ? "icon-touch" : "icon-sm";
  const changeScale = (next: number): void => {
    bridgeRef.current?.setHtmlView(height === null, next);
  };
  const [history, setHistory] = useState(() => freshHistory(entryPath));
  let current = history;
  if (history.entryPath !== entryPath) {
    current = freshHistory(entryPath);
    setHistory(current);
  }
  const { currentPath, backStack, missing } = current;

  const pageNavigation: SandboxPageNavigation = {
    path: currentPath,
    visit: current.visit,
    onNavigate: (path) => {
      setHistory((previous) =>
        path === previous.currentPath
          ? { ...previous, missing: false }
          : {
              ...previous,
              currentPath: path,
              backStack: [...previous.backStack, previous.currentPath],
              missing: false,
            },
      );
    },
    onPageMissing: () => {
      setHistory((previous) => ({ ...previous, missing: true }));
    },
  };
  const goBack = (): void => {
    setHistory((previous) => {
      const target = previous.backStack.at(-1);
      if (target === undefined) return previous;
      return {
        ...previous,
        currentPath: target,
        backStack: previous.backStack.slice(0, -1),
        missing: false,
        visit: previous.visit + 1,
      };
    });
  };
  const goHome = (): void => {
    setHistory((previous) => ({
      ...previous,
      currentPath: previous.entryPath,
      backStack: [],
      missing: false,
      visit: previous.visit + 1,
    }));
  };

  const fills = height === null;
  return (
    <div className={cn("relative flex w-full flex-col", fills && "h-full")}>
      {fills ||
      currentPath !== entryPath ||
      backStack.length > 0 ||
      props.toolbarControls ? (
        <div className="pointer-events-none absolute top-2 right-2 z-30 flex max-w-[calc(100%-1rem)] items-start">
          <div
            role="toolbar"
            aria-label="HTML artifact controls"
            className="pointer-events-auto flex flex-wrap items-center justify-end gap-1 rounded-md border border-border/60 bg-canvas p-0.5 shadow-sm"
          >
            {currentPath !== entryPath || backStack.length > 0 ? (
              <>
                <TooltipWrapper
                  label="Back"
                  side="top"
                  sideOffset={undefined}
                  align={undefined}
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size={controlSize}
                    aria-label="Back"
                    disabled={backStack.length === 0}
                    onClick={goBack}
                  >
                    <ArrowLeft className="size-4" />
                  </Button>
                </TooltipWrapper>
                <TooltipWrapper
                  label="Home"
                  side="top"
                  sideOffset={undefined}
                  align={undefined}
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size={controlSize}
                    aria-label="Home"
                    onClick={goHome}
                  >
                    <House className="size-4" />
                  </Button>
                </TooltipWrapper>
              </>
            ) : null}
            {fills ? (
              <HtmlPageZoomControls
                ready={ready}
                scale={scale}
                onScale={changeScale}
                controlSize={controlSize}
              />
            ) : null}
            {props.toolbarControls}
          </div>
        </div>
      ) : null}
      <div className={cn("relative w-full", fills && "min-h-0 flex-1")}>
        <SandboxFrame
          source={source}
          kind="page"
          title={title}
          appName={null}
          networkPolicy="https-only"
          appCsp={null}
          permissions={NO_PERMISSIONS}
          appRequests={null}
          className={className}
          height={height}
          onSize={onSize}
          onStatus={(status) => {
            setReady(status === "ready");
            if (status === "ready")
              bridgeRef.current?.setHtmlView(fills, scaleRef.current);
            onStatus(status);
          }}
          onRequestTeardown={noop}
          displayMode="inline"
          onBridge={(bridge) => {
            bridgeRef.current = bridge;
            if (bridge === null) setReady(false);
            onBridge?.(bridge);
          }}
          onHtmlZoom={(next) => {
            scaleRef.current = next;
            setScale(next);
          }}
          onTextSelection={(selection) => onTextSelection?.(selection)}
          pageNavigation={pageNavigation}
          ref={onFrame}
        />
        {renderOverlay?.(currentPath === entryPath && !missing)}
        {missing ? (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-background p-4 text-ui-sm text-muted-foreground">
            <span>This page is not in the artifact.</span>
            <Button type="button" variant="outline" size="sm" onClick={goHome}>
              Go home
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function HtmlPageZoomControls(props: {
  readonly ready: boolean;
  readonly scale: number;
  readonly onScale: (scale: number) => void;
  readonly controlSize: "icon-touch" | "icon-sm";
}) {
  const { ready, scale, onScale, controlSize } = props;
  return (
    <>
      <TooltipWrapper
        label="Zoom out"
        side="bottom"
        sideOffset={undefined}
        align={undefined}
      >
        <Button
          type="button"
          variant="muted"
          size={controlSize}
          aria-label="Zoom out"
          disabled={!ready || scale <= 0.25}
          onClick={() => onScale(Math.max(0.25, scale / 1.2))}
        >
          <Minus className="size-3.5" />
        </Button>
      </TooltipWrapper>
      <span
        role="status"
        aria-label="Zoom level"
        className="min-w-9 text-center text-ui-xs tabular-nums"
      >
        {ready ? `${Math.round(scale * 100)}%` : "–"}
      </span>
      <TooltipWrapper
        label="Zoom in"
        side="bottom"
        sideOffset={undefined}
        align={undefined}
      >
        <Button
          type="button"
          variant="muted"
          size={controlSize}
          aria-label="Zoom in"
          disabled={!ready || scale >= 4}
          onClick={() => onScale(Math.min(4, scale * 1.2))}
        >
          <Plus className="size-3.5" />
        </Button>
      </TooltipWrapper>
      <TooltipWrapper
        label="Actual size"
        side="bottom"
        sideOffset={undefined}
        align={undefined}
      >
        <Button
          type="button"
          variant="muted"
          size={controlSize}
          aria-label="Actual size"
          disabled={!ready}
          onClick={() => onScale(1)}
        >
          <ActualSizeGlyph />
        </Button>
      </TooltipWrapper>
    </>
  );
}
