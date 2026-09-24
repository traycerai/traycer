/**
 * Word (`.docx`) viewer for the asset-stream surfaces, built on docx-preview
 * (the renderer VS Code's and Obsidian's document viewers converged on): it
 * unpacks the OOXML package client-side and lays the document out as paged
 * HTML - real DOM, so selection and copy are the browser's own.
 *
 * The rendering lives in a SHADOW ROOT. docx-preview emits its own
 * stylesheet (paragraph, table, numbering and page rules) and sizes pages
 * with explicit widths and margins, exactly the kind of DOM that Tailwind's
 * preflight (`box-sizing: border-box`, list-style resets, heading resets)
 * silently reshapes - the pdf.js layer-offset bug was the same collision.
 * The shadow boundary keeps the app's global styles out of the document and
 * the document's generated styles out of the app, with nothing to patch on
 * either side. Embedded fonts are the one casualty (`ignoreFonts` below).
 *
 * Loaded exclusively through `docx-preview-lazy.tsx`: docx-preview + JSZip
 * stay out of the main bundle and load on the first Word file opened.
 */
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { renderAsync } from "docx-preview";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { appLogger } from "@/lib/logger";
import { isFindEngineSupported } from "@/lib/find-engine/find-engine";
import type { DocumentViewerProps } from "@/components/epic-canvas/document-preview/lazy-document-viewer";
import { DocumentSearchBar } from "@/components/epic-canvas/document-preview/document-search-bar";
import { DocumentPreviewToolbar } from "@/components/epic-canvas/document-preview/document-preview-toolbar";
import { DocxFindEngine } from "./docx-find";
import { registerTileSelectionRoot } from "@/lib/commands/tile-select-all";
import { currentPageAmong, scrollTopForPage } from "./docx-page-position";
import { useOpenLink } from "@/lib/links/open-link";

const ZOOM_STEP = 1.1;
const MIN_SCALE = 0.25;
const MAX_SCALE = 5;

/** `"page-width"` while the automatic fit is in force, `null` once the user has zoomed by hand. */
type ScaleMode = "page-width" | null;

/** Gutter around the pages, in CSS px - what fit-to-width leaves on each side. */
const PAGE_GUTTER_PX = 16;

/**
 * Overrides applied INSIDE the shadow root, after docx-preview's own rules:
 * the wrapper's gray page-backdrop becomes the tile's canvas. The scroll
 * container owns the fixed gutter; only the pages are zoomed. The wrapper
 * grows with its pages so zooming never clips their left edge.
 */
const VIEWER_STYLE = `
.docx-wrapper {
  background: transparent;
  padding: 0;
  width: max-content;
  box-sizing: border-box;
}
.docx-wrapper > section.docx {
  margin-bottom: ${PAGE_GUTTER_PX}px;
}
`;

/**
 * Where the viewer departs from docx-preview's defaults (paged layout in a
 * `.docx-wrapper`, headers, footers and notes rendered, tracked changes and
 * comments hidden). Pages break where Word last paginated
 * (`ignoreLastRenderedPageBreak: false`) so a Word-saved file reads as its
 * pages rather than one tall sheet. Embedded fonts are skipped: an
 * `@font-face` declared inside a shadow root does not register in Chromium,
 * so the faces would never load anyway - the document's font NAMES still
 * apply and resolve against installed fonts. `renderAltChunks` (embedded
 * HTML fragments) is turned off: it is the one path that would hand the
 * document's own markup to the DOM verbatim. Images are inlined as data
 * URLs, which the CSP already allows and which need no blob revocation.
 */
const RENDER_OPTIONS = {
  ignoreFonts: true,
  ignoreLastRenderedPageBreak: false,
  renderAltChunks: false,
  useBase64URL: true,
} as const;

interface RenderedDocument {
  /** docx-preview's `.docx-wrapper`, the element zoom is applied to. */
  readonly wrapper: HTMLElement;
  /** The page sections in document order - what page navigation walks. */
  readonly pages: readonly HTMLElement[];
  /** The widest page's width at 100%, for fit-to-width. */
  readonly naturalPageWidth: number;
  readonly find: DocxFindEngine;
}

export default function DocxPreview(props: DocumentViewerProps): ReactNode {
  return <DocxDocument key={props.url} {...props} />;
}

/** One document owns its controls, DOM and renderer resources. */
function DocxDocument(props: DocumentViewerProps): ReactNode {
  const openLink = useOpenLink();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const renderedRef = useRef<RenderedDocument | null>(null);
  const [documentReady, setDocumentReady] = useState(false);
  const [pageCount, setPageCount] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  // Mirrors `pageNumber` for the scroll listener, which is bound once per
  // document and must not be re-bound on every page change.
  const pageNumberRef = useRef(1);
  const [scalePercent, setScalePercent] = useState<number | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchState, setMatchState] = useState<{
    readonly current: number;
    readonly total: number;
  } | null>(null);
  // Old WebKit lacks the Highlight API the search paints with - the same
  // check the find-in-page bar hides itself on.
  const searchSupported = isFindEngineSupported();

  // Which automatic scale mode is in force: `"page-width"` until the user
  // zooms manually, then `null`. A resize observer re-applies the mode so
  // fit-to-width survives tile resizes. Held twice on purpose: the ref is
  // what the observer callback reads, the state is what presses the
  // toolbar's fit button.
  const scaleModeRef = useRef<ScaleMode>("page-width");
  const [scaleMode, setScaleModeState] = useState<ScaleMode>("page-width");
  const setScaleMode = useCallback((mode: ScaleMode): void => {
    scaleModeRef.current = mode;
    setScaleModeState(mode);
  }, []);
  const scaleRef = useRef(1);

  const onRenderFailureRef = useRef(props.onRenderFailure);
  useEffect(() => {
    onRenderFailureRef.current = props.onRenderFailure;
  });

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  const applyScale = useCallback((scale: number) => {
    const rendered = renderedRef.current;
    if (rendered === null) return;
    const clamped = Math.min(Math.max(scale, MIN_SCALE), MAX_SCALE);
    scaleRef.current = clamped;
    // `zoom` (not `transform`) so the layout size scales with the pages and
    // the scroll container measures the zoomed document.
    rendered.wrapper.style.zoom = String(clamped);
    setScalePercent(Math.round(clamped * 100));
  }, []);

  const applyFitWidth = useCallback(() => {
    const rendered = renderedRef.current;
    const container = scrollContainerRef.current;
    if (rendered === null || container === null) return;
    const available = container.clientWidth - PAGE_GUTTER_PX * 2;
    if (available <= 0 || rendered.naturalPageWidth <= 0) return;
    applyScale(available / rendered.naturalPageWidth);
  }, [applyScale]);

  const handleLinkClick = useEffectEvent((event: MouseEvent): void => {
    if (event.defaultPrevented || event.button > 1) return;
    if (!(event.target instanceof Element)) return;
    const anchor = event.target.closest("a[href]");
    if (anchor === null) return;
    event.preventDefault();
    const href = anchor.getAttribute("href")?.trim() ?? "";
    if (href.startsWith("#")) {
      // Browser fragment navigation cannot find bookmarks in a shadow tree.
      hostRef.current?.shadowRoot
        ?.getElementById(href.slice(1))
        ?.scrollIntoView({ block: "start", inline: "nearest" });
    } else if (href !== "") {
      void openLink(href, "markdown", event);
    }
  });

  useEffect(() => {
    const host = hostRef.current;
    const container = scrollContainerRef.current;
    if (host === null || container === null) return;
    let cancelled = false;
    const isCancelled = (): boolean => cancelled;
    let resizeObserver: ResizeObserver | null = null;
    let stopTrackingPage: (() => void) | null = null;

    // Strict Mode can re-run setup on the same host. Reuse its shadow root
    // while giving each render its own content container.
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    shadow.replaceChildren();
    const body = document.createElement("div");
    shadow.append(body);
    body.addEventListener("click", handleLinkClick);
    body.addEventListener("auxclick", handleLinkClick);
    const unregisterSelection = registerTileSelectionRoot(container, body);

    const open = async (): Promise<void> => {
      const response = await fetch(props.url);
      const blob = await response.blob();
      if (isCancelled()) return;

      // Body and style container are one element: the generated stylesheet
      // must live inside the shadow tree to reach the document at all.
      await renderAsync(blob, body, body, RENDER_OPTIONS);
      if (isCancelled()) return;

      const wrapper = body.querySelector<HTMLElement>(".docx-wrapper");
      if (wrapper === null) {
        throw new Error("docx-preview rendered no document wrapper");
      }
      const style = document.createElement("style");
      style.textContent = VIEWER_STYLE;
      shadow.append(style);

      const pages = [...wrapper.querySelectorAll<HTMLElement>("section.docx")];
      let naturalPageWidth = 0;
      for (const page of pages) {
        naturalPageWidth = Math.max(naturalPageWidth, page.offsetWidth);
      }
      renderedRef.current = {
        wrapper,
        pages,
        naturalPageWidth,
        find: new DocxFindEngine(wrapper),
      };
      setPageCount(pages.length);
      applyFitWidth();

      // The page counter follows the scroll position, one measurement per
      // frame - a scroll fires far more often than the page changes.
      let frame: number | null = null;
      const trackCurrentPage = (): void => {
        if (frame !== null) return;
        frame = requestAnimationFrame(() => {
          frame = null;
          const page = currentPageAmong(
            pages.length,
            (index) => pages[index].getBoundingClientRect(),
            container.getBoundingClientRect(),
            pageNumberRef.current,
          );
          if (page === pageNumberRef.current) return;
          pageNumberRef.current = page;
          setPageNumber(page);
        });
      };
      container.addEventListener("scroll", trackCurrentPage, {
        passive: true,
      });
      stopTrackingPage = () => {
        container.removeEventListener("scroll", trackCurrentPage);
        if (frame !== null) cancelAnimationFrame(frame);
      };

      // Keep the automatic fit in force across container resizes (tile
      // resize, first layout after a zero-width mount). Re-applying the same
      // computed scale is a no-op, so this never fights a manual zoom (which
      // clears the mode).
      resizeObserver = new ResizeObserver(() => {
        if (scaleModeRef.current !== null) applyFitWidth();
      });
      resizeObserver.observe(container);
      setDocumentReady(true);
    };

    open().catch((error: unknown) => {
      if (isCancelled()) return;
      appLogger.warn("docx-preview: document failed to open", {
        error: error instanceof Error ? error.message : String(error),
      });
      onRenderFailureRef.current();
    });

    return () => {
      cancelled = true;
      body.removeEventListener("click", handleLinkClick);
      body.removeEventListener("auxclick", handleLinkClick);
      unregisterSelection();
      resizeObserver?.disconnect();
      stopTrackingPage?.();
      renderedRef.current?.find.dispose();
      renderedRef.current = null;
    };
  }, [props.url, applyFitWidth]);

  const goToPage = useCallback((target: number) => {
    const rendered = renderedRef.current;
    const container = scrollContainerRef.current;
    if (rendered === null || container === null) return;
    if (rendered.pages.length === 0) return;
    const clamped = Math.min(Math.max(target, 1), rendered.pages.length);
    const page = rendered.pages[clamped - 1];
    // Set directly rather than waiting for the scroll listener: a page too
    // short to reach the top of the container never becomes the most visible
    // one by scrolling alone, and the listener keeps a fully visible current
    // page in place. Bounding rects are zoomed already; the gutter is not.
    pageNumberRef.current = clamped;
    setPageNumber(clamped);
    container.scrollTop = scrollTopForPage(
      page.getBoundingClientRect(),
      container.getBoundingClientRect(),
      container.scrollTop,
      PAGE_GUTTER_PX,
    );
  }, []);

  const zoomBy = useCallback(
    (factor: number) => {
      setScaleMode(null);
      applyScale(scaleRef.current * factor);
    },
    [applyScale, setScaleMode],
  );

  const handleFitWidth = useCallback(() => {
    setScaleMode("page-width");
    applyFitWidth();
  }, [applyFitWidth, setScaleMode]);

  const handleActualSize = useCallback(() => {
    setScaleMode(null);
    applyScale(1);
  }, [applyScale, setScaleMode]);

  // Live search, debounced, the way every findbar behaves; an emptied query
  // clears the highlights. Enter stays "next match" via `stepMatch`.
  useEffect(() => {
    if (!searchOpen) return;
    const timer = setTimeout(() => {
      const rendered = renderedRef.current;
      if (rendered === null) return;
      rendered.find.search(query);
      setMatchState(rendered.find.result() ?? { current: 0, total: 0 });
      rendered.find.scrollActiveIntoView();
    }, 250);
    return () => clearTimeout(timer);
  }, [query, searchOpen]);

  const stepMatch = useCallback((previous: boolean) => {
    const rendered = renderedRef.current;
    if (rendered === null) return;
    if (previous) {
      rendered.find.previous();
    } else {
      rendered.find.next();
    }
    setMatchState(rendered.find.result() ?? { current: 0, total: 0 });
    rendered.find.scrollActiveIntoView();
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery("");
    setMatchState(null);
    renderedRef.current?.find.search("");
  }, []);

  const toggleSearch = useCallback(() => {
    if (searchOpen) {
      closeSearch();
    } else {
      setSearchOpen(true);
    }
  }, [closeSearch, searchOpen]);

  // Desktop zoom affordance beyond the buttons. A NATIVE non-passive
  // listener, because React registers `wheel` passively - its preventDefault
  // is a no-op there, letting the browser's own ctrl+wheel page zoom run
  // alongside the viewer's.
  useEffect(() => {
    const zone = scrollContainerRef.current;
    if (zone === null) return;
    const handleWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
    };
    zone.addEventListener("wheel", handleWheel, { passive: false });
    return () => zone.removeEventListener("wheel", handleWheel);
  }, [zoomBy]);

  const handleZoomIn = useCallback(() => zoomBy(ZOOM_STEP), [zoomBy]);
  const handleZoomOut = useCallback(() => zoomBy(1 / ZOOM_STEP), [zoomBy]);

  const matchCountLabel = (() => {
    if (matchState === null) return "";
    if (matchState.total > 0) {
      return `${matchState.current} / ${matchState.total}`;
    }
    return query === "" ? "" : "0 results";
  })();

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <DocumentPreviewToolbar
        ariaLabel="Word document preview controls"
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
        onRotate={null}
        outline={null}
        searchSupported={searchSupported}
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
      <div className="relative min-h-0 flex-1 bg-canvas">
        <div
          ref={scrollContainerRef}
          // Ctrl/Cmd+A selects the document, not the whole window.
          data-selection-root=""
          className="absolute inset-0 overflow-auto p-4"
          data-testid="docx-preview-container"
        >
          {/* Document styles stay inside this shadow host. */}
          <div ref={hostRef} data-testid="docx-preview-host" />
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
  );
}
