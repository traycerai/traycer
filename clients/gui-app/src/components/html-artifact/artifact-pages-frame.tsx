import { useArtifactExpanded } from "@/components/artifacts/artifact-expanded-context";
import { ArtifactExpandButton } from "@/components/artifacts/artifact-expand-button";
import {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { ArrowLeft, House, Minus, MoreHorizontal, Plus } from "lucide-react";
import { ActualSizeGlyph } from "@/components/epic-canvas/zoom-controls/zoom-controls";
import { useCoarsePointer } from "@/hooks/ui/use-coarse-pointer";
import { useIsNarrowWindow } from "@/hooks/ui/use-narrow-window";
import {
  SandboxFrame,
  type SandboxPageNavigation,
  type SandboxSource,
} from "@/components/sandbox/sandbox-frame";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  artifactPagePaths,
  type ArtifactManifest,
} from "@/lib/sandbox/artifact-serving";
import type {
  SandboxBridgeHost,
  SandboxHtmlView,
  SandboxSize,
  SandboxStatus,
} from "@/lib/sandbox/bridge-host";
import type { CanvasTextSelection } from "@/lib/sandbox/canvas-bridge";
import { cn } from "@/lib/utils";
import { registerHistoryGestureFrame } from "@/components/layout/shell/desktop-history-frame-wheel";
import { useHtmlArtifactLinkOpener } from "./html-artifact-link-context";

const NO_PERMISSIONS = [] as const;
const noop = (): void => undefined;

/**
 * The controls' bottom edge before they have been measured: the top offset
 * plus one row of controls at the pointer's size, so a page usually opens
 * clear of them in its first paint rather than moving once they measure.
 */
const ESTIMATED_CONTROLS_BOTTOM_PX = { fine: 44, coarse: 62 } as const;

/**
 * The space a filling page keeps above its content for the controls floating
 * over its top edge: their bottom edge, measured, so a row of controls that
 * wraps on a narrow tile still clears the page. A page in the chat keeps
 * none, since its controls only come up on hover.
 */
function useControlsInset(
  controls: HTMLDivElement | null,
  active: boolean,
  coarsePointer: boolean,
): number {
  const estimate = coarsePointer
    ? ESTIMATED_CONTROLS_BOTTOM_PX.coarse
    : ESTIMATED_CONTROLS_BOTTOM_PX.fine;
  const [measured, setMeasured] = useState<number | null>(null);
  // A narrow window lays the chip out in flow above the frame (its `max-md`
  // classes), where it covers nothing and takes no room.
  const chipInFlow = useIsNarrowWindow();
  useLayoutEffect(() => {
    if (!active || controls === null) return;
    // An observer reports once as it starts, so this also takes the first
    // measurement, before the page's first paint.
    const observer = new ResizeObserver(() =>
      setMeasured(Math.ceil(controls.offsetTop + controls.offsetHeight)),
    );
    observer.observe(controls);
    return () => observer.disconnect();
  }, [controls, active]);
  if (!active || chipInFlow) return 0;
  return measured ?? estimate;
}

/** Back and Home's state, or `null` where there is no other page to be on. */
interface PageNavigationState {
  readonly canGoBack: boolean;
  readonly canGoHome: boolean;
}

/**
 * Back and Home only mean something where there is another page to be on,
 * and on such an artifact they are there from the first page rather than
 * appearing after the first link.
 */
function pageNavigationFor(
  manifest: ArtifactManifest,
  history: PageHistory,
): PageNavigationState | null {
  const awayFromEntry = history.currentPath !== history.entryPath;
  const canGoBack = history.backStack.length > 0;
  if (!awayFromEntry && !canGoBack && artifactPagePaths(manifest).length <= 1)
    return null;
  // A link to a page the folder lacks leaves the reader on the page that had
  // it, and Home is the way out. An unreachable page is not: Home would read
  // the same failed page again, which is what its own Retry is for.
  return { canGoBack, canGoHome: awayFromEntry || history.missing };
}

/**
 * The page's controls, floating over its top-right corner in the same shell
 * as a markdown artifact's version-history button.
 */
function ArtifactPageControls(props: {
  /** Hands over the chip's element, for measuring the room it takes. */
  readonly onElement: (element: HTMLDivElement | null) => void;
  /** In the chat the page is a row among others, so its controls come up on hover like every other row's, and stay on touch. */
  readonly revealOnHover: boolean;
  readonly controlSize: "icon-touch" | "icon-sm";
  readonly pages: PageNavigationState | null;
  readonly onBack: () => void;
  readonly onHome: () => void;
  /** The zoom cluster, or `null` for a page that does not zoom. */
  readonly zoom: { readonly ready: boolean; readonly scale: number } | null;
  readonly onScale: (scale: number) => void;
  readonly toolbarControls: ReactNode;
  readonly menuItems: ReactNode;
}) {
  const {
    onElement,
    revealOnHover,
    controlSize,
    pages,
    onBack,
    onHome,
    zoom,
    onScale,
    toolbarControls,
    menuItems,
  } = props;
  const anythingAfterPages =
    zoom !== null || toolbarControls !== undefined || menuItems !== undefined;
  return (
    <div
      ref={onElement}
      // On a narrow window the chip sits in flow above the frame instead
      // (`useControlsInset` keeps no room for it there).
      className="pointer-events-none absolute top-2 right-2 z-30 flex max-w-[calc(100%-1rem)] items-start max-md:static max-md:max-w-full max-md:shrink-0 max-md:justify-end max-md:p-1"
    >
      <div
        role="toolbar"
        aria-label="HTML artifact controls"
        className={cn(
          "pointer-events-auto flex flex-wrap items-center justify-end gap-0.5 rounded-md border border-border/60 bg-canvas p-0.5 shadow-sm",
          revealOnHover &&
            "pointer-events-none opacity-0 transition-opacity group-focus-within/artifact-page:pointer-events-auto group-focus-within/artifact-page:opacity-100 group-hover/artifact-page:pointer-events-auto group-hover/artifact-page:opacity-100 motion-reduce:transition-none pointer-coarse:pointer-events-auto pointer-coarse:opacity-100",
        )}
      >
        {pages === null ? null : (
          <>
            <TooltipWrapper
              label="Back"
              side="top"
              sideOffset={undefined}
              align={undefined}
            >
              <span className="inline-flex">
                <Button
                  type="button"
                  variant="ghost"
                  size={controlSize}
                  aria-label="Back"
                  disabled={!pages.canGoBack}
                  onClick={onBack}
                >
                  <ArrowLeft className="size-4" />
                </Button>
              </span>
            </TooltipWrapper>
            <TooltipWrapper
              label="Home"
              side="top"
              sideOffset={undefined}
              align={undefined}
            >
              <span className="inline-flex">
                <Button
                  type="button"
                  variant="ghost"
                  size={controlSize}
                  aria-label="Home"
                  disabled={!pages.canGoHome}
                  onClick={onHome}
                >
                  <House className="size-4" />
                </Button>
              </span>
            </TooltipWrapper>
            {anythingAfterPages ? (
              <Separator orientation="vertical" className="mx-0.5 h-4" />
            ) : null}
          </>
        )}
        {zoom === null ? null : (
          <HtmlPageZoomControls
            ready={zoom.ready}
            scale={zoom.scale}
            onScale={onScale}
            controlSize={controlSize}
          />
        )}
        {toolbarControls}
        {zoom === null && menuItems === undefined ? null : (
          <HtmlPageMoreActions
            controlSize={controlSize}
            actualSize={
              zoom === null
                ? null
                : {
                    // As the readout shows it: steps of 1.2 rarely land on 1.
                    disabled:
                      !zoom.ready || Math.round(zoom.scale * 100) === 100,
                    onSelect: () => onScale(1),
                  }
            }
            menuItems={menuItems}
          />
        )}
      </div>
    </div>
  );
}

interface PageHistory {
  readonly entryPath: string;
  readonly currentPath: string;
  /** Pages to go back to, the most recent last. There is no Forward. */
  readonly backStack: readonly string[];
  readonly missing: boolean;
  /** The current page exists and its bytes did not arrive from the host. */
  readonly unreachable: boolean;
  /** Counts Back, Home and retry, see {@link SandboxPageNavigation.visit}. */
  readonly visit: number;
}

function freshHistory(entryPath: string): PageHistory {
  return {
    entryPath,
    currentPath: entryPath,
    backStack: [],
    missing: false,
    unreachable: false,
    visit: 0,
  };
}

/** A page the frame showed, a fresh object for each document that proved itself. */
export interface ProvenPage {
  readonly path: string;
}

/**
 * The document on show is the page the reader asked for once it has proved
 * itself: a page still loading, a stand-in and a page Back or Home is leaving
 * are none. Comments go on it when it is one of the artifact's own pages,
 * which are the files the host stamps a comment's id into; any other page on
 * show is `uncommentable`.
 */
function commentPageOnShow(
  history: PageHistory,
  provenPage: ProvenPage | null,
  ready: boolean,
  manifest: ArtifactManifest,
): {
  readonly commentPage: ProvenPage | null;
  readonly uncommentable: boolean;
} {
  if (
    !ready ||
    history.missing ||
    history.unreachable ||
    provenPage?.path !== history.currentPath
  )
    return { commentPage: null, uncommentable: false };
  return artifactPagePaths(manifest).includes(provenPage.path)
    ? { commentPage: provenPage, uncommentable: false }
    : { commentPage: null, uncommentable: true };
}

/** Opens a page of the artifact as a link would, so Back returns from it. */
export interface ArtifactPagesNavigator {
  readonly openPage: (path: string) => void;
}

interface ArtifactPagesFrameProps {
  readonly ref?: Ref<ArtifactPagesNavigator>;
  readonly source: Extract<SandboxSource, { kind: "artifact" }>;
  readonly title: string;
  readonly className: string;
  /** The page's height in px, or `null` to fill what the row leaves. */
  readonly height: number | null;
  /**
   * Whether a press on the page picks an element to comment on instead of
   * acting on the page. The page stays loaded either way - this is a mode the
   * loaded page is told to take - so its scroll, zoom and own state outlast
   * the switch. A page comments cannot go on shows a notice while this is on.
   */
  readonly commenting: boolean;
  /**
   * The page comments go on, told each time it changes: the page the reader
   * asked for once it proved itself, while it is one of the artifact's own
   * pages, and `null` while a page loads, fails or is not one of them.
   */
  readonly onCommentPage: ((page: ProvenPage | null) => void) | null;
  readonly onSize: (size: SandboxSize) => void;
  readonly onStatus: (status: SandboxStatus) => void;
  readonly onBridge: ((bridge: SandboxBridgeHost | null) => void) | null;
  readonly onTextSelection:
    | ((selection: CanvasTextSelection | null) => void)
    | null;
  /** Hands over the iframe element, and `null` once it is gone. */
  readonly onFrame: ((frame: HTMLIFrameElement | null) => void) | null;
  /** Layers drawn over the page, such as comment outlines and pins. */
  readonly overlay: ReactNode;
  /**
   * Keeps the mounted document through a source change it already carries,
   * such as the page's own first-comment id; `undefined` reloads on every
   * change. See the frame's own `sourceEquivalent`.
   */
  readonly sourceEquivalent:
    | ((previous: SandboxSource, next: SandboxSource) => boolean)
    | undefined;
  /** Controls shown in the floating chip, after zoom. */
  readonly toolbarControls?: ReactNode;
  /** Rows for the chip's "More actions" menu, after Actual size. */
  readonly menuItems?: ReactNode;
}

/**
 * A served plain-html artifact: a folder of pages the reader moves between
 * inside one frame. The app keeps its own page stack, so Back and Home work
 * whatever the page does, and a link to a page the folder lacks says so
 * instead of leaving a blank frame. Every surface that shows such an
 * artifact (the canvas tile, the chat row) renders it through here.
 *
 * The expansion is NOT raised here. It belongs to whoever composes the whole
 * surface, because the comment draft and the selection overlay are siblings of
 * this frame, not children of it: an expansion starting inside the frame would
 * leave the draft outside the raised surface, behind an inert document.
 * `html-artifact-comment-surface.tsx`, `html-artifact-frame.tsx` and the chat
 * row each raise one around everything that belongs to their surface.
 */
export function ArtifactPagesFrame(props: ArtifactPagesFrameProps) {
  const {
    source,
    title,
    className,
    height,
    commenting,
    onSize,
    onStatus,
    onBridge,
    onTextSelection,
    onFrame,
    overlay,
    sourceEquivalent,
    ref,
  } = props;
  const expanded = useArtifactExpanded();
  // A link out of the artifact opens its target in a tile, through whatever
  // the surface around this frame provides (`HtmlArtifactLinks`).
  const openArtifactLink = useHtmlArtifactLinkOpener();
  const entryPath = source.entryPath === "" ? "index.html" : source.entryPath;
  const bridgeRef = useRef<SandboxBridgeHost | null>(null);
  // A wheel the page could not use reaches the app's back/forward swipe
  // before it moves the transcript, as it would over a Markdown artifact.
  const unregisterFrame = useRef<(() => void) | null>(null);
  const attachFrame = (frame: HTMLIFrameElement | null): void => {
    unregisterFrame.current?.();
    unregisterFrame.current =
      frame === null
        ? null
        : registerHistoryGestureFrame(frame, (held) =>
            bridgeRef.current?.notify("traycer/history-gesture/hold", {
              held,
            }),
          );
    onFrame?.(frame);
  };
  const [controlsElement, setControlsElement] = useState<HTMLDivElement | null>(
    null,
  );
  const scaleRef = useRef(1);
  const [scale, setScale] = useState(1);
  const [ready, setReady] = useState(false);
  // The page of the document that last proved itself. Back and Home move
  // `currentPath` at once while the page they leave is still loaded, so the
  // comment mode follows this, not the request.
  const [provenPage, setProvenPage] = useState<ProvenPage | null>(null);
  const coarsePointer = useCoarsePointer();
  const controlSize = coarsePointer ? "icon-touch" : "icon-sm";
  const [history, setHistory] = useState(() => freshHistory(entryPath));
  let current = history;
  if (history.entryPath !== entryPath) {
    current = freshHistory(entryPath);
    setHistory(current);
  }
  const { currentPath } = current;

  const pageNavigation: SandboxPageNavigation = {
    path: currentPath,
    visit: current.visit,
    onNavigate: (path) => {
      setProvenPage({ path });
      setHistory((previous) =>
        path === previous.currentPath
          ? { ...previous, missing: false, unreachable: false }
          : {
              ...previous,
              currentPath: path,
              backStack: [...previous.backStack, previous.currentPath],
              missing: false,
              unreachable: false,
            },
      );
    },
    // One load has one answer, so each of these displaces the other rather
    // than stacking a second overlay on the first.
    onPageMissing: () => {
      setHistory((previous) => ({
        ...previous,
        missing: true,
        unreachable: false,
      }));
    },
    onPageUnreachable: () => {
      setHistory((previous) => ({
        ...previous,
        missing: false,
        unreachable: true,
      }));
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
        unreachable: false,
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
      unreachable: false,
      visit: previous.visit + 1,
    }));
  };
  // The same page again, which is a reload: the server caches nothing it could
  // not read, so this is a fresh read of the page the reader asked for.
  const readAgain = (): void => {
    setHistory((previous) => ({
      ...previous,
      unreachable: false,
      visit: previous.visit + 1,
    }));
  };
  useImperativeHandle(
    ref,
    () => ({
      // Asking for the page already asked for reads it again, which is what
      // gets a reader off a stand-in shown in its place.
      openPage: (path) => {
        setHistory((previous) => ({
          ...previous,
          currentPath: path,
          backStack:
            path === previous.currentPath
              ? previous.backStack
              : [...previous.backStack, previous.currentPath],
          missing: false,
          unreachable: false,
          visit: previous.visit + 1,
        }));
      },
    }),
    [],
  );

  const standIn = pageStandIn(current, { goHome, readAgain });
  // An expanded surface fills its panel whatever sizing the inline row asked
  // for - the same substitution the detached copy used to make for itself by
  // passing `height={null}` and `h-full w-full`. It carries the zoom controls
  // and keeps the controls on show for the same reason it did.
  const fills = height === null || expanded;
  const { commentPage, uncommentable } = commentPageOnShow(
    current,
    provenPage,
    ready,
    source.manifest,
  );
  const commentingHere = commenting && commentPage !== null;
  const reportCommentPage = useEffectEvent((page: ProvenPage | null) =>
    props.onCommentPage?.(page),
  );
  useEffect(() => {
    reportCommentPage(commentPage);
  }, [commentPage]);
  const viewAt = (next: number): SandboxHtmlView => ({
    enabled: fills,
    scale: next,
    commenting: commentingHere,
  });
  const changeScale = (next: number): void => {
    bridgeRef.current?.setHtmlView(viewAt(next));
  };
  // Every load is a fresh document that opens for reading, so it is told its
  // view and mode once its proof has rendered, and again on each change.
  const tellReadyPage = useEffectEvent(() => {
    const bridge = bridgeRef.current;
    if (!ready || bridge === null) return;
    bridge.setHtmlView(viewAt(scaleRef.current));
    void bridge.setMode(commentingHere ? "edit" : "play");
  });
  useEffect(() => {
    tellReadyPage();
    // `fills` too: it follows `expanded`, and an already-ready page that is not
    // told its new view keeps the old one - a surface expanded from a fixed-height
    // row would stay zoom-disabled until something else happened to send a view.
    // `tellReadyPage` reads the live scale, so the reader keeps theirs.
  }, [provenPage, commentingHere, fills]);
  const pages = pageNavigationFor(source.manifest, current);
  const zoom = fills ? { ready, scale } : null;
  const pageInsetTop = useControlsInset(controlsElement, fills, coarsePointer);
  return (
    <div
      className={cn(
        "group/artifact-page relative flex w-full flex-col",
        fills && "h-full",
      )}
    >
      <ArtifactPageControls
        onElement={setControlsElement}
        revealOnHover={!fills}
        controlSize={controlSize}
        pages={pages}
        onBack={goBack}
        onHome={goHome}
        zoom={zoom}
        onScale={changeScale}
        toolbarControls={
          <>
            {props.toolbarControls}
            <ArtifactExpandButton />
          </>
        }
        menuItems={props.menuItems}
      />
      <div className={cn("relative w-full", fills && "min-h-0 flex-1")}>
        <SandboxFrame
          pageInsetTop={pageInsetTop}
          source={source}
          kind="page"
          title={title}
          appName={null}
          networkPolicy="https-only"
          appCsp={null}
          permissions={NO_PERMISSIONS}
          appRequests={null}
          className={expanded ? "h-full w-full" : className}
          height={fills ? null : height}
          onSize={onSize}
          onStatus={(status) => {
            setReady(status === "ready");
            onStatus(status);
          }}
          onRequestTeardown={noop}
          displayMode={expanded ? "fullscreen" : "inline"}
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
          onArtifactLink={openArtifactLink}
          pageNavigation={pageNavigation}
          sourceEquivalent={sourceEquivalent}
          ref={attachFrame}
        />
        {overlay}
        {standIn ??
          (commenting && uncommentable ? (
            <PageStandIn
              sentence="Comments can't be added on this page."
              action="Go home"
              onAct={goHome}
            />
          ) : null)}
      </div>
    </div>
  );
}

/**
 * What stands in for the page when the frame has none to show, and the way
 * out it offers. The two answers are exclusive — one load has one answer —
 * and they offer different ways out on purpose: a page the folder lacks was
 * reached by a link and has the artifact's own entry page to fall back to,
 * while a page whose bytes did not arrive exists and is worth asking for
 * again. The second is usually the entry page itself, where Home would reload
 * the very document that failed.
 */
function pageStandIn(
  history: PageHistory,
  actions: { readonly goHome: () => void; readonly readAgain: () => void },
): ReactNode {
  if (history.unreachable) {
    return (
      <PageStandIn
        sentence="Couldn't load this page from its host."
        action="Retry"
        onAct={actions.readAgain}
      />
    );
  }
  if (history.missing) {
    return (
      <PageStandIn
        sentence="This page is not in the artifact."
        action="Go home"
        onAct={actions.goHome}
      />
    );
  }
  return null;
}

/** A stand-in replaces the page and is announced where the page is read. */
function PageStandIn(props: {
  readonly sentence: string;
  readonly action: string;
  readonly onAct: () => void;
}) {
  return (
    <div
      role="status"
      className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-background p-4 text-ui-sm text-muted-foreground"
    >
      <span>{props.sentence}</span>
      <Button type="button" variant="outline" size="sm" onClick={props.onAct}>
        {props.action}
      </Button>
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
    </>
  );
}

/**
 * What the chip keeps one click away: Actual size, which a page rarely needs
 * once zoomed by pinch or the buttons, and the caller's own rows (Download).
 */
function HtmlPageMoreActions(props: {
  readonly controlSize: "icon-touch" | "icon-sm";
  readonly actualSize: {
    readonly disabled: boolean;
    readonly onSelect: () => void;
  } | null;
  readonly menuItems: ReactNode;
}) {
  return (
    <DropdownMenu modal={false}>
      <TooltipWrapper
        label="More actions"
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size={props.controlSize}
            aria-label="More actions"
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
      </TooltipWrapper>
      <DropdownMenuContent align="end">
        {props.actualSize === null ? null : (
          <DropdownMenuItem
            disabled={props.actualSize.disabled}
            onSelect={props.actualSize.onSelect}
          >
            <ActualSizeGlyph />
            Actual size
          </DropdownMenuItem>
        )}
        {props.actualSize !== null && props.menuItems !== undefined ? (
          <DropdownMenuSeparator />
        ) : null}
        {props.menuItems}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
