import {
  useCallback,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type Ref,
} from "react";
import { cn } from "@/lib/utils";

export interface WireframeIframeProps {
  readonly htmlContent: string;
  readonly title: string;
  readonly className: string;
  /**
   * When `fill`, the iframe stretches to the container - used for the
   * fullscreen dialog. When `auto`, the iframe grows to the measured
   * document height (clamped) - used for inline preview.
   */
  readonly mode: "auto" | "fill";
  readonly ref?: Ref<HTMLIFrameElement>;
}

const MIN_HEIGHT_PX = 240;
// Conservative ceiling - pathological HTML (infinite scroll demos, giant
// backgrounds) otherwise pushes the tile past viewport and hijacks scroll.
const MAX_HEIGHT_MULTIPLIER = 3;
// A direct drag expresses stronger intent than automatic document sizing, so
// it gets one additional viewport of headroom. Existing manual heights are not
// reduced when the parent viewport later shrinks.
const MANUAL_MAX_HEIGHT_MULTIPLIER = 4;
const KEYBOARD_RESIZE_STEP_PX = 16;
const POINTER_DRAG_THRESHOLD_PX = 4;
// A swallowed reporter must not suppress ordinary ResizeObserver reports
// indefinitely. After this window, unsolicited current-generation reports are
// accepted again; a matching reply clears the wait immediately.
const MEASURE_REQUEST_TIMEOUT_MS = 1_000;
const HEIGHT_MESSAGE_MARKER = "traycer:wireframe:height:v1";
const MEASURE_REQUEST_MARKER = "traycer:wireframe:measure-request:v1";
const INITIAL_DOCTYPE_PATTERN = /^\s*<!doctype(?:\s+[^>]*)?>/i;
function buildHeightMeasurementScript(documentGeneration: number): string {
  return `
<script>
(() => {
  const documentGeneration = ${documentGeneration};
  const reportHeight = (requestId) => {
    const body = document.body;
    const bodyRect = body?.getBoundingClientRect();
    const bodyStyle = body === null ? null : window.getComputedStyle(body);
    const bodyMarginHeight =
      Number.parseFloat(bodyStyle?.marginTop ?? "0") +
      Number.parseFloat(bodyStyle?.marginBottom ?? "0");
    const bodyHeight =
      Math.max(body?.offsetHeight ?? 0, bodyRect?.height ?? 0) + bodyMarginHeight;
    const documentElement = document.documentElement;
    const viewportHeight = documentElement.clientHeight;
    const documentHeight =
      documentElement.scrollHeight > viewportHeight
        ? documentElement.scrollHeight
        : 0;
    window.parent.postMessage(
      {
        marker: "${HEIGHT_MESSAGE_MARKER}",
        height: Math.max(bodyHeight, documentHeight),
        documentGeneration,
        requestId,
      },
      "*",
    );
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (typeof data !== "object" || data === null) return;
    if (data.marker !== "${MEASURE_REQUEST_MARKER}") return;
    if (data.documentGeneration !== documentGeneration) return;
    if (typeof data.requestId !== "number" || !Number.isFinite(data.requestId)) return;
    reportHeight(data.requestId);
  });

  const observeDocument = () => {
    const observer = new ResizeObserver(() => reportHeight(null));
    if (document.body !== null) observer.observe(document.body);
    observer.observe(document.documentElement);
    reportHeight(null);
  };

  if (document.readyState === "complete") {
    observeDocument();
  } else {
    window.addEventListener("load", observeDocument, { once: true });
  }
})();
</script>`;
}

function buildAutoDocument(
  htmlContent: string,
  documentGeneration: number,
): string {
  const reporter = buildHeightMeasurementScript(documentGeneration);
  const doctype = INITIAL_DOCTYPE_PATTERN.exec(htmlContent)?.[0] ?? "";
  return `${doctype}${reporter}${htmlContent.slice(doctype.length)}`;
}

interface ActiveResizeDrag {
  readonly pointerId: number;
  readonly startClientY: number;
  readonly startHeight: number;
  readonly startManualHeight: number | null;
  readonly crossedThreshold: boolean;
}

interface AwaitingMeasurement {
  readonly documentGeneration: number;
  readonly requestId: number;
}

interface HeightMessage {
  readonly documentGeneration: number;
  readonly height: number;
  readonly requestId: number | null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseHeightMessage(data: unknown): HeightMessage | null {
  if (typeof data !== "object" || data === null) return null;
  if (!("marker" in data) || data.marker !== HEIGHT_MESSAGE_MARKER) return null;
  if (!("height" in data) || !isFiniteNumber(data.height)) return null;
  if (!("documentGeneration" in data)) return null;
  if (!isFiniteNumber(data.documentGeneration)) return null;
  if (!("requestId" in data)) return null;
  if (data.requestId !== null && !isFiniteNumber(data.requestId)) return null;
  return {
    documentGeneration: data.documentGeneration,
    height: data.height,
    requestId: data.requestId,
  };
}

function clampAutoHeight(height: number, viewportHeight: number): number {
  return Math.max(
    MIN_HEIGHT_PX,
    Math.min(viewportHeight * MAX_HEIGHT_MULTIPLIER, height),
  );
}

function manualMaxHeight(
  viewportHeight: number,
  currentHeight: number,
): number {
  return Math.max(
    MIN_HEIGHT_PX,
    viewportHeight * MANUAL_MAX_HEIGHT_MULTIPLIER,
    currentHeight,
  );
}

function clampManualHeight(height: number, maxHeight: number): number {
  return Math.max(MIN_HEIGHT_PX, Math.min(maxHeight, height));
}

/**
 * Sandboxed preview iframe. `allow-scripts` enables artifact-authored
 * interactions and the appended height reporter. Deliberately omitting
 * `allow-same-origin` gives the document an opaque origin, so its scripts
 * cannot access the parent DOM, storage, or cookies. The remaining sandbox
 * restrictions also block top-level navigation, form submission, and popups.
 *
 * The opaque origin makes `contentDocument` inaccessible from the parent.
 * Auto-sized previews therefore inject a trusted script before artifact
 * markup (but after an initial doctype) and receive its ResizeObserver
 * measurements via postMessage. Putting the reporter first prevents malformed
 * trailing raw-text/comment contexts from swallowing it. Document generations
 * reject reports queued by an earlier srcdoc, while request IDs correlate
 * explicit reset/load measurements with their replies.
 */
export function WireframeIframe(props: WireframeIframeProps) {
  const { htmlContent, title, className, mode, ref: forwardedRef } = props;
  const innerRef = useRef<HTMLIFrameElement | null>(null);
  const lastAutoMeasurementRef = useRef<number | null>(null);
  const pendingAutoMeasurementRef = useRef<number | null>(null);
  const manualHeightRef = useRef<number | null>(null);
  const activeResizeDragRef = useRef<ActiveResizeDrag | null>(null);
  const awaitingMeasurementRef = useRef<AwaitingMeasurement | null>(null);
  const measurementRequestTimeoutRef = useRef<number | null>(null);
  const measurementRequestWindowRef = useRef<Window | null>(null);
  const nextMeasurementRequestIdRef = useRef(0);
  const [autoHeightState, setAutoHeightState] = useState(() => ({
    documentGeneration: 1,
    htmlContent,
    height: MIN_HEIGHT_PX,
  }));
  const [manualHeight, setManualHeight] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [viewportHeight, setViewportHeight] = useState(() =>
    typeof window === "undefined" ? MIN_HEIGHT_PX : window.innerHeight,
  );

  if (autoHeightState.htmlContent !== htmlContent) {
    setAutoHeightState({
      documentGeneration: autoHeightState.documentGeneration + 1,
      htmlContent,
      height: MIN_HEIGHT_PX,
    });
  }
  const documentGeneration = autoHeightState.documentGeneration;
  const autoHeight =
    autoHeightState.htmlContent === htmlContent
      ? autoHeightState.height
      : MIN_HEIGHT_PX;

  const setRef = (node: HTMLIFrameElement | null): void => {
    innerRef.current = node;
    if (typeof forwardedRef === "function") {
      forwardedRef(node);
    } else if (forwardedRef !== null && forwardedRef !== undefined) {
      forwardedRef.current = node;
    }
  };

  const clearMeasurementWait = useCallback((): void => {
    const timeoutId = measurementRequestTimeoutRef.current;
    const requestWindow = measurementRequestWindowRef.current;
    if (timeoutId !== null && requestWindow !== null) {
      requestWindow.clearTimeout(timeoutId);
    }
    measurementRequestTimeoutRef.current = null;
    measurementRequestWindowRef.current = null;
    awaitingMeasurementRef.current = null;
  }, []);

  const requestIframeMeasurement = useCallback(
    (iframe: HTMLIFrameElement, generation: number): void => {
      const win = iframe.ownerDocument.defaultView;
      if (win === null) return;
      clearMeasurementWait();

      const requestId = nextMeasurementRequestIdRef.current + 1;
      nextMeasurementRequestIdRef.current = requestId;
      const awaitingMeasurement = {
        documentGeneration: generation,
        requestId,
      };
      awaitingMeasurementRef.current = awaitingMeasurement;
      measurementRequestWindowRef.current = win;
      measurementRequestTimeoutRef.current = win.setTimeout(() => {
        const awaiting = awaitingMeasurementRef.current;
        if (awaiting === null) return;
        if (awaiting.documentGeneration !== generation) return;
        if (awaiting.requestId !== requestId) return;
        awaitingMeasurementRef.current = null;
        measurementRequestTimeoutRef.current = null;
        measurementRequestWindowRef.current = null;
      }, MEASURE_REQUEST_TIMEOUT_MS);
      iframe.contentWindow?.postMessage(
        {
          marker: MEASURE_REQUEST_MARKER,
          documentGeneration: generation,
          requestId,
        },
        "*",
      );
    },
    [clearMeasurementWait],
  );
  const requestMeasurementFromEffect = useEffectEvent(
    (iframe: HTMLIFrameElement, generation: number): void => {
      requestIframeMeasurement(iframe, generation);
    },
  );

  useLayoutEffect(() => {
    clearMeasurementWait();
    lastAutoMeasurementRef.current = null;
    pendingAutoMeasurementRef.current = null;
  }, [clearMeasurementWait, htmlContent]);

  useLayoutEffect(() => {
    if (mode !== "auto") return;
    const iframe = innerRef.current;
    if (iframe === null) return;
    const win = iframe.ownerDocument.defaultView;
    if (win === null) return;

    const applyAutoHeight = (measurement: number): void => {
      const clamped = clampAutoHeight(measurement, win.innerHeight);
      setAutoHeightState({
        documentGeneration,
        htmlContent,
        height: clamped,
      });
    };

    const onMessage = (event: MessageEvent<unknown>): void => {
      if (event.source !== iframe.contentWindow) return;
      const message = parseHeightMessage(event.data);
      if (message === null) return;
      if (message.documentGeneration !== documentGeneration) return;

      const awaiting = awaitingMeasurementRef.current;
      if (awaiting !== null) {
        if (
          message.requestId !== awaiting.requestId ||
          message.documentGeneration !== awaiting.documentGeneration
        ) {
          return;
        }
        clearMeasurementWait();
      } else if (message.requestId !== null) {
        return;
      }

      if (manualHeightRef.current !== null) return;
      const drag = activeResizeDragRef.current;
      if (drag !== null) {
        if (!drag.crossedThreshold) {
          pendingAutoMeasurementRef.current = message.height;
        }
        return;
      }
      lastAutoMeasurementRef.current = message.height;
      applyAutoHeight(message.height);
    };

    const onResize = (): void => {
      setViewportHeight(win.innerHeight);
      const measurement = lastAutoMeasurementRef.current;
      if (measurement === null) return;
      if (
        manualHeightRef.current !== null ||
        activeResizeDragRef.current !== null
      ) {
        return;
      }
      applyAutoHeight(measurement);
    };

    const onLoad = (): void => {
      if (lastAutoMeasurementRef.current !== null) return;
      requestMeasurementFromEffect(iframe, documentGeneration);
    };

    win.addEventListener("message", onMessage);
    win.addEventListener("resize", onResize);
    iframe.addEventListener("load", onLoad);

    return () => {
      win.removeEventListener("message", onMessage);
      win.removeEventListener("resize", onResize);
      iframe.removeEventListener("load", onLoad);
      clearMeasurementWait();
    };
  }, [clearMeasurementWait, documentGeneration, htmlContent, mode]);

  const applyLatestAutoMeasurement = (): void => {
    const pendingMeasurement = pendingAutoMeasurementRef.current;
    if (pendingMeasurement !== null) {
      lastAutoMeasurementRef.current = pendingMeasurement;
      pendingAutoMeasurementRef.current = null;
    }

    const iframe = innerRef.current;
    const win = iframe?.ownerDocument.defaultView;
    const measurement = lastAutoMeasurementRef.current;
    const clamped =
      win === null || win === undefined || measurement === null
        ? MIN_HEIGHT_PX
        : clampAutoHeight(measurement, win.innerHeight);
    setAutoHeightState({ documentGeneration, htmlContent, height: clamped });
  };

  const finishResizeDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    cancelled: boolean,
  ): void => {
    const drag = activeResizeDragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    activeResizeDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setIsDragging(false);

    if (cancelled) {
      manualHeightRef.current = drag.startManualHeight;
      setManualHeight(drag.startManualHeight);
    }
    if (manualHeightRef.current === null) applyLatestAutoMeasurement();
  };

  const handlePointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    if (event.button !== 0 || activeResizeDragRef.current !== null) return;
    const iframe = innerRef.current;
    const win = iframe?.ownerDocument.defaultView;
    if (iframe === null || win === null || win === undefined) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startHeight = manualHeightRef.current ?? autoHeight;
    activeResizeDragRef.current = {
      pointerId: event.pointerId,
      startClientY: event.clientY,
      startHeight,
      startManualHeight: manualHeightRef.current,
      crossedThreshold: false,
    };
    setIsDragging(true);
  };

  const handlePointerMove = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    const drag = activeResizeDragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const delta = event.clientY - drag.startClientY;
    if (!drag.crossedThreshold && Math.abs(delta) < POINTER_DRAG_THRESHOLD_PX) {
      return;
    }
    if (!drag.crossedThreshold) {
      const pendingMeasurement = pendingAutoMeasurementRef.current;
      if (pendingMeasurement !== null) {
        lastAutoMeasurementRef.current = pendingMeasurement;
        pendingAutoMeasurementRef.current = null;
      }
      activeResizeDragRef.current = { ...drag, crossedThreshold: true };
    }
    const iframe = innerRef.current;
    const win = iframe?.ownerDocument.defaultView;
    if (win === null || win === undefined) return;
    const establishedHeight = manualHeightRef.current ?? drag.startHeight;
    const nextHeight = clampManualHeight(
      drag.startHeight + delta,
      manualMaxHeight(win.innerHeight, establishedHeight),
    );
    manualHeightRef.current = nextHeight;
    setManualHeight(nextHeight);
  };

  const handleDoubleClick = (): void => {
    manualHeightRef.current = null;
    setManualHeight(null);
    pendingAutoMeasurementRef.current = null;
    applyLatestAutoMeasurement();
    const iframe = innerRef.current;
    if (iframe !== null) {
      requestIframeMeasurement(iframe, documentGeneration);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const iframe = innerRef.current;
    const win = iframe?.ownerDocument.defaultView;
    if (win === null || win === undefined) return;

    event.preventDefault();
    const currentHeight = manualHeightRef.current ?? autoHeight;
    const direction = event.key === "ArrowDown" ? 1 : -1;
    const nextHeight = clampManualHeight(
      currentHeight + direction * KEYBOARD_RESIZE_STEP_PX,
      manualMaxHeight(win.innerHeight, currentHeight),
    );
    manualHeightRef.current = nextHeight;
    setManualHeight(nextHeight);
  };

  const effectiveHeight = manualHeight ?? autoHeight;
  const accessibleMaxHeight = manualMaxHeight(viewportHeight, effectiveHeight);

  return (
    <>
      <iframe
        ref={setRef}
        title={title}
        // Scripts enable wireframe interactions and height reporting. Omitting
        // allow-same-origin keeps the frame isolated behind an opaque origin.
        sandbox="allow-scripts"
        srcDoc={
          mode === "auto"
            ? buildAutoDocument(htmlContent, documentGeneration)
            : htmlContent
        }
        className={cn("tc-node-wireframe__iframe", className)}
        style={
          mode === "auto"
            ? { height: `${effectiveHeight}px`, width: "100%" }
            : { height: "100%", width: "100%" }
        }
      />
      {mode === "auto" ? (
        <>
          {isDragging ? (
            <div
              aria-hidden="true"
              className="tc-node-wireframe__resize-shield"
              data-testid="wireframe-resize-shield"
            />
          ) : null}
          <div
            role="slider"
            tabIndex={0}
            aria-label="Resize preview"
            aria-orientation="vertical"
            aria-valuemin={MIN_HEIGHT_PX}
            aria-valuemax={Math.round(accessibleMaxHeight)}
            aria-valuenow={Math.round(effectiveHeight)}
            className="tc-node-wireframe__resize-handle"
            data-dragging={isDragging ? "true" : "false"}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={(event) => finishResizeDrag(event, false)}
            onPointerCancel={(event) => finishResizeDrag(event, true)}
            onLostPointerCapture={(event) => finishResizeDrag(event, true)}
            onDoubleClick={handleDoubleClick}
            onKeyDown={handleKeyDown}
          >
            <span
              aria-hidden="true"
              className="tc-node-wireframe__resize-grip"
            />
          </div>
        </>
      ) : null}
    </>
  );
}
