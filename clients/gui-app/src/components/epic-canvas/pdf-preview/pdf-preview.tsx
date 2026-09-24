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
  type MouseEvent,
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
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { appLogger } from "@/lib/logger";
import { useOpenLink } from "@/lib/links/open-link";
import { usePinchZoom } from "@/hooks/ui/use-pinch-zoom";
import type { DocumentViewerProps } from "@/components/epic-canvas/document-preview/lazy-document-viewer";
import { DocumentSearchBar } from "@/components/epic-canvas/document-preview/document-search-bar";
import { DocumentPreviewToolbar } from "@/components/epic-canvas/document-preview/document-preview-toolbar";
import { pdfDataFileUrls } from "./pdf-asset-urls";
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
/**
 * How long after the last finger move pdf.js waits before re-rendering the
 * pages at the new scale. Until then it scales the existing bitmaps with
 * CSS, which is what keeps a pinch smooth on a long document - the value
 * pdf.js's own viewer uses for its touch pinch.
 */
const PINCH_REDRAW_DELAY_MS = 400;
/** pdf.js rounds a scale to two decimals, so a smaller change would be a no-op anyway. */
const PINCH_SCALE_EPSILON = 0.005;

function clampScale(scale: number): number {
  return Math.min(Math.max(scale, MIN_SCALE), MAX_SCALE);
}

/** `"page-width"` while the automatic fit is in force, `null` once the user has zoomed by hand. */
type ScaleMode = "page-width" | null;

/** The shared document-viewer contract - see `lazy-document-viewer.tsx`. */
export type PdfPreviewProps = DocumentViewerProps;

type ViewerBinding = {
  readonly viewer: PDFViewer;
  readonly eventBus: EventBus;
  readonly linkService: PDFLinkService;
  readonly document: PDFDocumentProxy;
};

export default function PdfPreview(props: PdfPreviewProps): ReactNode {
  return <PdfDocument key={props.url} {...props} />;
}

/** One document owns its controls, DOM and renderer resources. */
function PdfDocument(props: PdfPreviewProps): ReactNode {
  const openLink = useOpenLink();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const bindingRef = useRef<ViewerBinding | null>(null);
  const [documentReady, setDocumentReady] = useState(false);
  const [pageCount, setPageCount] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
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
  // back to 100%). Held twice on purpose: the ref is what the observer
  // callback reads, the state is what presses the toolbar's fit button.
  const scaleModeRef = useRef<ScaleMode>("page-width");
  const [scaleMode, setScaleModeState] = useState<ScaleMode>("page-width");
  const setScaleMode = useCallback((mode: ScaleMode): void => {
    scaleModeRef.current = mode;
    setScaleModeState(mode);
  }, []);

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

    const open = async (): Promise<void> => {
      // `connect-src blob:` is already in the CSP (the lightbox depends on
      // it), and handing pdf.js raw bytes keeps its worker off the network
      // path entirely.
      const response = await fetch(props.url);
      const bytes = await response.arrayBuffer();
      if (isCancelled()) return;

      // Bytes come from us; the data files come from the bundle. Both halves
      // are needed - without the second, CID fonts and scanned images fail
      // silently (see `pdf-asset-urls.ts`).
      loadingTask = getDocument({ data: bytes, ...pdfDataFileUrls() });
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

      // Bind the controls BEFORE anything else is awaited: `pagesinit`
      // (which enables the toolbar) fires on its own schedule after
      // `setDocument`, and an outline fetch that lost that race left every
      // handler no-op'ing against a null binding - a page or search typed in
      // that window was silently dropped.
      binding = { viewer, eventBus, linkService, document: pdfDocument };
      bindingRef.current = binding;

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

      // pdf.js types promise an array, but a document without an outline
      // resolves `null` at runtime. Cancellation past this point is the
      // cleanup's business - `binding` is set, so it destroys the document.
      const outlineItems: readonly PdfOutlineEntry[] | null = await pdfDocument
        .getOutline()
        .catch((): null => null);
      if (isCancelled()) return;
      setOutline(outlineItems ?? []);
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

  const zoomBy = useCallback(
    (factor: number) => {
      const binding = bindingRef.current;
      if (binding === null) return;
      setScaleMode(null);
      binding.viewer.currentScale = clampScale(
        binding.viewer.currentScale * factor,
      );
    },
    [setScaleMode],
  );

  // Touch pinch, the way pdf.js's own viewer does it: every finger move asks
  // the viewer for the scale that keeps the zoom one to one with the fingers,
  // anchored where they meet, and the drawing delay has it stretch the page
  // bitmaps with CSS at once while the real re-render waits for the fingers
  // to rest. The readout follows through the viewer's own `scalechanging`.
  const pinchStartScaleRef = useRef<number | null>(null);
  usePinchZoom(containerRef, {
    onPinchStart: () => {
      const binding = bindingRef.current;
      if (binding === null) return;
      pinchStartScaleRef.current = binding.viewer.currentScale;
      setScaleMode(null);
    },
    onPinchMove: (update) => {
      const binding = bindingRef.current;
      const container = containerRef.current;
      const startScale = pinchStartScaleRef.current;
      if (binding === null || container === null || startScale === null) {
        return;
      }
      // Two fingers drag the document the way one does.
      container.scrollLeft -= update.focalDeltaX;
      container.scrollTop -= update.focalDeltaY;
      const target = clampScale(startScale * update.ratio);
      const current = binding.viewer.currentScale;
      if (Math.abs(target - current) < PINCH_SCALE_EPSILON) return;
      // pdf.js reads `origin` against the container's own offset position,
      // so the focal is expressed relative to the container's offset parent.
      const rect = container.getBoundingClientRect();
      binding.viewer.updateScale({
        scaleFactor: target / current,
        origin: [
          update.focal.clientX - rect.left + container.offsetLeft,
          update.focal.clientY - rect.top + container.offsetTop,
        ],
        drawingDelay: PINCH_REDRAW_DELAY_MS,
      });
    },
    onPinchEnd: () => {
      pinchStartScaleRef.current = null;
    },
  });

  const handleFitWidth = useCallback(() => {
    const binding = bindingRef.current;
    if (binding === null) return;
    setScaleMode("page-width");
    binding.viewer.currentScaleValue = "page-width";
  }, [setScaleMode]);

  const handleActualSize = useCallback(() => {
    const binding = bindingRef.current;
    if (binding === null) return;
    setScaleMode(null);
    binding.viewer.currentScale = 1;
  }, [setScaleMode]);

  const handleRotate = useCallback(() => {
    const binding = bindingRef.current;
    if (binding === null) return;
    binding.viewer.pagesRotation = (binding.viewer.pagesRotation + 90) % 360;
  }, []);

  const handleOutlineNavigate = useCallback(
    (entry: PdfOutlineEntry, event: MouseEvent<HTMLButtonElement>) => {
      const binding = bindingRef.current;
      if (binding === null) return;
      if (entry.dest !== null) {
        void binding.linkService.goToDestination(entry.dest);
        return;
      }
      if (entry.url !== null) {
        // A link inside a rendered document, so it answers to the same
        // "Open links" setting as the other document surfaces - and to the
        // modifiers that override it per click, which is why the row hands
        // the event up rather than swallowing it. `window.open` is a no-op in
        // the Electron renderer and would bypass the setting outright.
        void openLink(entry.url, "markdown", event);
      }
    },
    [openLink],
  );

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

  const stepMatch = useCallback(
    (previous: boolean) => dispatchFind("again", previous),
    [dispatchFind],
  );

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

  // Desktop zoom affordance beyond the buttons (touch has the pinch above).
  // A NATIVE non-passive listener, because React registers `wheel` passively - its
  // preventDefault is a no-op there, letting the browser's own ctrl+wheel
  // page zoom run alongside the viewer's.
  const wheelZoneRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const zone = wheelZoneRef.current;
    if (zone === null) return;
    const handleWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
    };
    zone.addEventListener("wheel", handleWheel, { passive: false });
    return () => zone.removeEventListener("wheel", handleWheel);
  }, [zoomBy]);

  const hasOutline = outline.length > 0;
  const handleZoomIn = useCallback(() => zoomBy(ZOOM_STEP), [zoomBy]);
  const handleZoomOut = useCallback(() => zoomBy(1 / ZOOM_STEP), [zoomBy]);
  const toggleOutline = useCallback(
    () => setOutlineOpen((value) => !value),
    [],
  );
  const toggleSearch = useCallback(() => {
    if (searchOpen) {
      closeSearch();
    } else {
      setSearchOpen(true);
    }
  }, [closeSearch, searchOpen]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <DocumentPreviewToolbar
        ariaLabel="PDF preview controls"
        fileName={props.fileName}
        compact={props.compact}
        toolbarActions={props.toolbarActions}
        documentReady={documentReady}
        pageNumber={pageNumber}
        pageCount={pageCount}
        onGoToPage={goToPage}
        zoom={{
          ready: documentReady,
          scalePercent,
          canZoomIn: scalePercent === null || scalePercent < MAX_SCALE * 100,
          canZoomOut: scalePercent === null || scalePercent > MIN_SCALE * 100,
          onZoomIn: handleZoomIn,
          onZoomOut: handleZoomOut,
          fitKind: "width",
          fitActive: scaleMode === "page-width",
          onFit: handleFitWidth,
          actualSizeActive: scalePercent === 100,
          onActualSize: handleActualSize,
        }}
        onRotate={handleRotate}
        outline={
          hasOutline ? { open: outlineOpen, onToggle: toggleOutline } : null
        }
        searchSupported
        searchOpen={searchOpen}
        onToggleSearch={toggleSearch}
      />
      {searchOpen ? (
        <DocumentSearchBar
          inputRef={searchInputRef}
          query={query}
          onQueryChange={setQuery}
          onStep={stepMatch}
          onClose={closeSearch}
          matchCountLabel={matchCountLabel}
        />
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
          ref={wheelZoneRef}
          className="relative min-h-0 min-w-0 flex-1 bg-canvas"
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
