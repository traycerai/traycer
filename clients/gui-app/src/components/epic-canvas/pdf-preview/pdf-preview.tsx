/**
 * PDF viewer for the asset-stream surfaces, built on pdf.js's own viewer
 * components (`pdfjs-dist/web/pdf_viewer`) rather than hand-rolled canvases
 * (PDF preview design, Q2): `PDFViewer` brings page virtualization (render
 * visible pages ± buffer - the memory requirement mobile makes mandatory),
 * the text layer (selection), and `PDFFindController` (document search),
 * so the hand-written part is only this React shell and its toolbar.
 *
 * Loaded exclusively through `pdf-preview-lazy.tsx`: pdf.js is a ~1-2 MB
 * chunk that must never enter the main bundle (same treatment as pdfmake's
 * artifact export). Everything here is CSP-clean by construction - script +
 * same-origin worker + canvas, no frames, no plugins - which is the whole
 * reason pdf.js was chosen over Chromium's built-in viewer.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import {
  EventBus,
  PDFFindController,
  PDFLinkService,
  PDFViewer,
} from "pdfjs-dist/web/pdf_viewer.mjs";
import "pdfjs-dist/web/pdf_viewer.css";
// Must come after pdf_viewer.css - undoes the Tailwind-preflight box-sizing
// leak that skews the text/annotation layers (see the file's comment).
import "./pdf-preview.css";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ListTree,
  Minus,
  Plus,
  RotateCw,
  Scan,
  Search,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { appLogger } from "@/lib/logger";
import { PdfOutlinePanel, type PdfOutlineEntry } from "./pdf-outline-panel";

// Same-origin worker chunk emitted by Vite - `script-src 'self'` already
// covers it. Assigned at module scope so a second mount never races the
// first document load. If this ever fails to load, pdf.js silently parses
// on the MAIN thread instead of erroring - the recurring field bug of every
// comparable integration - which `pdf-preview.test.tsx` guards against.
GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/**
 * Per-page canvas pixel budget. pdf.js's default (2^25) is tuned for
 * desktop; iOS WKWebView blanks canvases well before that under total
 * canvas-memory pressure, and this component ships to the Capacitor app in
 * the same bundle with no opt-out (mobile is wholesale gui-app reuse). One
 * conservative budget everywhere beats a platform fork: 2^24 still allows
 * a full A4 page at ~3x device pixel ratio.
 */
const MAX_CANVAS_PIXELS = 2 ** 24;

const ZOOM_STEP = 1.1;
const MIN_SCALE = 0.25;
const MAX_SCALE = 5;

export interface PdfPreviewProps {
  /** Blob URL of the validated PDF bytes (from `useFileAsset`). */
  readonly url: string;
  /** Toolbar caption; surfaces pass their path-like label of choice. */
  readonly fileName: string;
  /** Compact mode drops the toolbar label - for surfaces with their own title. */
  readonly compact: boolean;
  /**
   * Host-surface actions appended to the toolbar (e.g. the tile's Open
   * Externally button), so the viewer bar can be the surface's ONLY bar.
   */
  readonly toolbarActions: ReactNode;
  /**
   * Bytes reached a blob URL but pdf.js could not parse them as a PDF -
   * the exact counterpart of `ImagePreview`'s `onDecodeError`: the caller
   * (the hook's `reportDecodeFailure`) discards the cache entry and flips
   * the tile to the uniform fallback.
   */
  readonly onRenderFailure: () => void;
}

type ViewerBinding = {
  readonly viewer: PDFViewer;
  readonly eventBus: EventBus;
  readonly linkService: PDFLinkService;
  readonly document: PDFDocumentProxy;
};

export default function PdfPreview(props: PdfPreviewProps): ReactNode {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const bindingRef = useRef<ViewerBinding | null>(null);
  const [documentReady, setDocumentReady] = useState(false);
  const [pageCount, setPageCount] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [scalePercent, setScalePercent] = useState<number | null>(null);
  const [outline, setOutline] = useState<readonly PdfOutlineEntry[]>([]);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchState, setMatchState] = useState<{
    readonly current: number;
    readonly total: number;
  } | null>(null);

  // Which automatic scale mode is in force: `"page-width"` until the user
  // zooms manually, then `null`. A resize observer re-applies the mode so
  // fit-to-width survives tile resizes AND a mount whose container had no
  // laid-out width yet when `pagesinit` fired (where pdf.js silently falls
  // back to 100%).
  const scaleModeRef = useRef<"page-width" | null>("page-width");

  const onRenderFailureRef = useRef(props.onRenderFailure);
  useEffect(() => {
    onRenderFailureRef.current = props.onRenderFailure;
  });

  // Focus-on-open for the search field (jsx-a11y forbids the `autoFocus`
  // prop; an explicit user gesture opening the bar is the a11y-sane case).
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  const matchCountLabel = (() => {
    if (matchState === null) return "";
    if (matchState.total > 0) {
      return `${matchState.current} / ${matchState.total}`;
    }
    return query === "" ? "" : "0 results";
  })();

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    let cancelled = false;
    // Read through a call so control-flow analysis never "proves" the flag
    // still false after an await - cleanup flips it from outside this
    // closure.
    const isCancelled = (): boolean => cancelled;
    let binding: ViewerBinding | null = null;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    let resizeObserver: ResizeObserver | null = null;

    scaleModeRef.current = "page-width";
    setDocumentReady(false);
    setPageCount(0);
    setPageNumber(1);
    setPageInput("1");
    setScalePercent(null);
    setOutline([]);
    setMatchState(null);

    const open = async (): Promise<void> => {
      // `connect-src blob:` is already in the CSP (the lightbox depends on
      // it), and handing pdf.js raw bytes keeps its worker off the network
      // path entirely.
      const response = await fetch(props.url);
      const bytes = await response.arrayBuffer();
      if (isCancelled()) return;

      loadingTask = getDocument({ data: bytes });
      const pdfDocument = await loadingTask.promise;
      if (isCancelled()) {
        void pdfDocument.destroy();
        return;
      }

      const eventBus = new EventBus();
      const linkService = new PDFLinkService({
        eventBus,
        // LinkTarget.BLANK - external links leave through window.open, which
        // the desktop shell's security handlers already govern; internal
        // destinations navigate within the viewer.
        externalLinkTarget: 2,
      });
      const findController = new PDFFindController({
        eventBus,
        linkService,
        updateMatchesCountOnProgress: true,
      });
      const viewer = new PDFViewer({
        container,
        eventBus,
        linkService,
        findController,
        maxCanvasPixels: MAX_CANVAS_PIXELS,
        // pdfjs-dist 5.7's PDFPageDetailView (the sharp overlay canvas for
        // deep zoom on restricted-scale pages) defines no `resume()`, yet
        // the render queue calls `view.resume()` whenever a paused detail
        // view regains priority - an uncaught TypeError on every zoom /
        // page-nav interaction on multi-page documents (found by live
        // testing). Disable the detail path: within our 2^24 canvas budget
        // the base canvas already covers a full page at ~3x DPR.
        enableDetailCanvas: false,
      });
      linkService.setViewer(viewer);

      eventBus.on("pagesinit", () => {
        // Fit-to-width initial view (design Q8): in a preview tile the
        // first question is "what does this say", and page-fit renders
        // text too small in a height-constrained tile.
        viewer.currentScaleValue = "page-width";
        setDocumentReady(true);
      });
      eventBus.on("pagechanging", (evt: { readonly pageNumber: number }) => {
        setPageNumber(evt.pageNumber);
        setPageInput(String(evt.pageNumber));
      });
      eventBus.on("scalechanging", (evt: { readonly scale: number }) => {
        setScalePercent(Math.round(evt.scale * 100));
      });
      eventBus.on(
        "updatefindmatchescount",
        (evt: {
          readonly matchesCount: {
            readonly current: number;
            readonly total: number;
          };
        }) => {
          setMatchState(evt.matchesCount);
        },
      );
      eventBus.on(
        "updatefindcontrolstate",
        (evt: {
          readonly matchesCount: {
            readonly current: number;
            readonly total: number;
          };
        }) => {
          setMatchState(evt.matchesCount);
        },
      );

      viewer.setDocument(pdfDocument);
      linkService.setDocument(pdfDocument, null);
      setPageCount(pdfDocument.numPages);

      // pdf.js types promise an array, but a document without an outline
      // resolves `null` at runtime.
      const outlineItems: readonly PdfOutlineEntry[] | null = await pdfDocument
        .getOutline()
        .catch((): null => null);
      if (isCancelled()) {
        void pdfDocument.destroy();
        return;
      }
      setOutline(outlineItems ?? []);

      // Keep the automatic fit in force across container resizes (tile
      // resize, outline pane toggle, first layout after a zero-width
      // mount). Re-applying an unchanged computed scale is a no-op inside
      // pdf.js, so this never fights a manual zoom (which clears the mode).
      resizeObserver = new ResizeObserver(() => {
        if (scaleModeRef.current !== null && bindingRef.current !== null) {
          bindingRef.current.viewer.currentScaleValue = scaleModeRef.current;
        }
      });
      resizeObserver.observe(container);

      binding = { viewer, eventBus, linkService, document: pdfDocument };
      bindingRef.current = binding;
    };

    open().catch((error: unknown) => {
      if (isCancelled()) return;
      appLogger.warn("pdf-preview: document failed to open", {
        error: error instanceof Error ? error.message : String(error),
      });
      onRenderFailureRef.current();
    });

    return () => {
      cancelled = true;
      bindingRef.current = null;
      resizeObserver?.disconnect();
      if (binding !== null) {
        // Destroying the document tears down the viewer's render loop; the
        // container's DOM goes with this component's unmount. (5.x types
        // no longer accept `setDocument(null)` as an explicit detach.)
        void binding.document.destroy();
      } else {
        void loadingTask?.destroy();
      }
    };
  }, [props.url]);

  const goToPage = useCallback((target: number) => {
    const binding = bindingRef.current;
    if (binding === null) return;
    const clamped = Math.min(Math.max(target, 1), binding.document.numPages);
    binding.viewer.currentPageNumber = clamped;
  }, []);

  const handlePageInputCommit = useCallback(() => {
    const parsed = Number.parseInt(pageInput, 10);
    if (Number.isNaN(parsed)) {
      setPageInput(String(pageNumber));
      return;
    }
    goToPage(parsed);
  }, [goToPage, pageInput, pageNumber]);

  const zoomBy = useCallback((factor: number) => {
    const binding = bindingRef.current;
    if (binding === null) return;
    scaleModeRef.current = null;
    const next = Math.min(
      Math.max(binding.viewer.currentScale * factor, MIN_SCALE),
      MAX_SCALE,
    );
    binding.viewer.currentScale = next;
  }, []);

  const handleFitWidth = useCallback(() => {
    const binding = bindingRef.current;
    if (binding === null) return;
    scaleModeRef.current = "page-width";
    binding.viewer.currentScaleValue = "page-width";
  }, []);

  const handleRotate = useCallback(() => {
    const binding = bindingRef.current;
    if (binding === null) return;
    binding.viewer.pagesRotation = (binding.viewer.pagesRotation + 90) % 360;
  }, []);

  const handleOutlineNavigate = useCallback((entry: PdfOutlineEntry) => {
    const binding = bindingRef.current;
    if (binding === null) return;
    if (entry.dest !== null) {
      void binding.linkService.goToDestination(entry.dest);
      return;
    }
    if (entry.url !== null) {
      // Same exit as the annotation layer's external links (LinkTarget.BLANK):
      // window.open, governed by the desktop shell's security handlers.
      window.open(entry.url, "_blank", "noopener");
    }
  }, []);

  const dispatchFind = useCallback(
    (type: "" | "again", findPrevious: boolean) => {
      const binding = bindingRef.current;
      if (binding === null) return;
      binding.eventBus.dispatch("find", {
        source: null,
        type,
        query,
        caseSensitive: false,
        entireWord: false,
        highlightAll: true,
        findPrevious,
        matchDiacritics: false,
      });
    },
    [query],
  );

  // Live search: dispatch a fresh find as the query changes (debounced), the
  // way every findbar behaves - live testing showed Enter-only search reads
  // as broken (a standing "0 results" while typing, nothing until Enter).
  // An emptied query dispatches too: pdf.js treats it as "clear highlights".
  // Enter stays "next match" via `dispatchFind("again", ...)`.
  useEffect(() => {
    if (!searchOpen) return;
    const timer = setTimeout(() => {
      const binding = bindingRef.current;
      if (binding === null) return;
      binding.eventBus.dispatch("find", {
        source: null,
        type: "",
        query,
        caseSensitive: false,
        entireWord: false,
        highlightAll: true,
        findPrevious: false,
        matchDiacritics: false,
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [query, searchOpen]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery("");
    setMatchState(null);
    const binding = bindingRef.current;
    if (binding === null) return;
    // Empty query clears the highlights.
    binding.eventBus.dispatch("find", {
      source: null,
      type: "",
      query: "",
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: false,
      matchDiacritics: false,
    });
  }, []);

  // Desktop zoom affordance beyond the buttons; touch pinch is the mobile
  // verification pass's follow-up, not silently assumed working.
  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
    },
    [zoomBy],
  );

  const hasOutline = outline.length > 0;

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div
        role="toolbar"
        aria-label="PDF preview controls"
        className="relative z-10 flex h-8 shrink-0 items-center justify-between gap-2 border-b border-canvas-border/70 px-2"
      >
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {hasOutline ? (
            <TooltipWrapper
              label="Document outline"
              side="top"
              sideOffset={undefined}
              align={undefined}
            >
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-pressed={outlineOpen}
                onClick={() => setOutlineOpen((value) => !value)}
                aria-label="Document outline"
              >
                <ListTree className="size-4" />
              </Button>
            </TooltipWrapper>
          ) : null}
          {props.compact ? null : (
            <StartTruncatedText className="min-w-0 flex-1 text-ui-xs text-muted-foreground">
              {props.fileName}
            </StartTruncatedText>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <TooltipWrapper
            label="Previous page"
            side="top"
            sideOffset={undefined}
            align={undefined}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={!documentReady || pageNumber <= 1}
              onClick={() => goToPage(pageNumber - 1)}
              aria-label="Previous page"
            >
              <ChevronLeft className="size-4" />
            </Button>
          </TooltipWrapper>
          <div className="flex items-center gap-1 text-ui-xs text-muted-foreground">
            <Input
              // Empty until pagesinit - a "1" next to "/ 0" reads as a
              // contradictory state, not a loading one.
              value={documentReady ? pageInput : ""}
              disabled={!documentReady}
              onChange={(event) => setPageInput(event.target.value)}
              onBlur={handlePageInputCommit}
              onKeyDown={(event) => {
                if (event.key === "Enter") handlePageInputCommit();
              }}
              inputMode="numeric"
              aria-label="Page number"
              className="h-6 w-10 px-1 text-center text-ui-xs"
            />
            <span className="whitespace-nowrap">
              / {pageCount > 0 ? pageCount : "\u2013"}
            </span>
          </div>
          <TooltipWrapper
            label="Next page"
            side="top"
            sideOffset={undefined}
            align={undefined}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={!documentReady || pageNumber >= pageCount}
              onClick={() => goToPage(pageNumber + 1)}
              aria-label="Next page"
            >
              <ChevronRight className="size-4" />
            </Button>
          </TooltipWrapper>
          <div className="mx-0.5 h-4 w-px bg-border" aria-hidden="true" />
          <TooltipWrapper
            label="Zoom out"
            side="top"
            sideOffset={undefined}
            align={undefined}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={!documentReady}
              onClick={() => zoomBy(1 / ZOOM_STEP)}
              aria-label="Zoom out"
            >
              <Minus className="size-4" />
            </Button>
          </TooltipWrapper>
          <span
            className="min-w-9 whitespace-nowrap text-center text-ui-xs tabular-nums text-muted-foreground"
            aria-label="Zoom level"
          >
            {scalePercent === null ? "\u2013" : `${scalePercent}%`}
          </span>
          <TooltipWrapper
            label="Zoom in"
            side="top"
            sideOffset={undefined}
            align={undefined}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={!documentReady}
              onClick={() => zoomBy(ZOOM_STEP)}
              aria-label="Zoom in"
            >
              <Plus className="size-4" />
            </Button>
          </TooltipWrapper>
          <TooltipWrapper
            label="Fit to width"
            side="top"
            sideOffset={undefined}
            align={undefined}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={!documentReady}
              onClick={handleFitWidth}
              aria-label="Fit to width"
            >
              <Scan className="size-4" />
            </Button>
          </TooltipWrapper>
          <TooltipWrapper
            label="Rotate 90°"
            side="top"
            sideOffset={undefined}
            align={undefined}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={!documentReady}
              onClick={handleRotate}
              aria-label="Rotate"
            >
              <RotateCw className="size-4" />
            </Button>
          </TooltipWrapper>
          <div className="mx-0.5 h-4 w-px bg-border" aria-hidden="true" />
          <TooltipWrapper
            label="Search document"
            side="top"
            sideOffset={undefined}
            align={undefined}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={!documentReady}
              aria-pressed={searchOpen}
              onClick={() => {
                if (searchOpen) {
                  closeSearch();
                } else {
                  setSearchOpen(true);
                }
              }}
              aria-label="Search document"
            >
              <Search className="size-4" />
            </Button>
          </TooltipWrapper>
          {props.toolbarActions}
        </div>
      </div>
      {searchOpen ? (
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-canvas-border/70 px-2">
          <Input
            ref={searchInputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && query !== "") {
                dispatchFind("again", event.shiftKey);
              }
              if (event.key === "Escape") closeSearch();
            }}
            placeholder="Find in document"
            aria-label="Find in document"
            className="h-6 min-w-0 flex-1 px-2 text-ui-xs"
          />
          <span
            className="whitespace-nowrap text-ui-xs text-muted-foreground"
            aria-live="polite"
          >
            {matchCountLabel}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={query === ""}
            onClick={() => dispatchFind("again", true)}
            aria-label="Previous match"
          >
            <ChevronUp className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={query === ""}
            onClick={() => dispatchFind("again", false)}
            aria-label="Next match"
          >
            <ChevronDown className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={closeSearch}
            aria-label="Close search"
          >
            <X className="size-4" />
          </Button>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        {outlineOpen && hasOutline ? (
          <div className="w-1/3 max-w-64 shrink-0 bg-canvas">
            <PdfOutlinePanel
              items={outline}
              onNavigate={handleOutlineNavigate}
            />
          </div>
        ) : null}
        <div
          className="relative min-h-0 min-w-0 flex-1 bg-canvas"
          onWheel={handleWheel}
        >
          {/* PDFViewer requires an absolutely-positioned scroll container with
              a `pdfViewer`-classed child it owns wholesale. Pages keep their
              own white paper background in dark mode by design (Q5). */}
          <div
            ref={containerRef}
            className="absolute inset-0 overflow-auto"
            data-testid="pdf-preview-container"
          >
            <div className="pdfViewer" />
          </div>
          {documentReady ? null : (
            <div className="absolute inset-0 flex items-center justify-center">
              <AgentSpinningDots
                className={undefined}
                testId={undefined}
                variant={undefined}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
