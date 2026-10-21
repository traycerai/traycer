import { useState, type ReactNode } from "react";
import { ArrowLeft, House } from "lucide-react";
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
    <div className={cn("flex w-full flex-col", fills && "h-full")}>
      {currentPath !== entryPath || backStack.length > 0 ? (
        <div
          role="toolbar"
          aria-label="Artifact pages"
          className="flex h-8 shrink-0 items-center gap-1 border-b border-border px-2"
        >
          <TooltipWrapper
            label="Back"
            side="top"
            sideOffset={undefined}
            align={undefined}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
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
              size="icon-sm"
              aria-label="Home"
              onClick={goHome}
            >
              <House className="size-4" />
            </Button>
          </TooltipWrapper>
          <div className="flex min-w-0 flex-1 items-center gap-1.5 pl-1 text-ui-xs">
            <span className="max-w-1/2 shrink-0 truncate">{title}</span>
            <span aria-hidden="true" className="text-muted-foreground">
              ›
            </span>
            <span className="min-w-0 truncate font-mono text-muted-foreground">
              {currentPath}
            </span>
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
          onStatus={onStatus}
          onRequestTeardown={noop}
          displayMode="inline"
          onBridge={onBridge}
          onTextSelection={(selection) => onTextSelection?.(selection)}
          pageNavigation={pageNavigation}
          ref={onFrame}
        />
        {renderOverlay?.(currentPath === entryPath && !missing)}
        {missing ? (
          <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-2 bg-background p-4 text-ui-sm text-muted-foreground">
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
