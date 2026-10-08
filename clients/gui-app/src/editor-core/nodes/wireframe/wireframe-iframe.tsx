import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type Ref,
} from "react";
import { SandboxFrame } from "@/components/sandbox/sandbox-frame";
import { cn } from "@/lib/utils";
import type { SandboxSize } from "@/lib/sandbox/bridge-host";
import type { SandboxPermission } from "@/lib/sandbox/sandbox-url";

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
const NO_PERMISSIONS: readonly SandboxPermission[] = [];

interface ActiveResizeDrag {
  readonly pointerId: number;
  readonly startClientY: number;
  readonly startHeight: number;
  readonly startManualHeight: number | null;
  readonly crossedThreshold: boolean;
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

function ignoreSandboxEvent(): void {}

/**
 * A wireframe preview in the shared sandbox frame (D12): the same opaque,
 * own-origin loader agent pages and MCP Apps use, always https-only because
 * artifact text is peer-editable. Wireframes keep their light srcdoc look
 * (`sandboxTheme`) and get the theme variables and link handling for free.
 *
 * The frame's bootstrap reports the document height on every resize, so the
 * auto-sized preview just follows the latest report. A new document is a new
 * frame (`SandboxFrame` remounts on content), so no stale report can arrive.
 */
export function WireframeIframe(props: WireframeIframeProps) {
  const { htmlContent, title, className, mode, ref: forwardedRef } = props;
  const innerRef = useRef<HTMLIFrameElement | null>(null);
  const lastAutoMeasurementRef = useRef<number | null>(null);
  const pendingAutoMeasurementRef = useRef<number | null>(null);
  const manualHeightRef = useRef<number | null>(null);
  const activeResizeDragRef = useRef<ActiveResizeDrag | null>(null);
  const [autoHeightState, setAutoHeightState] = useState(() => ({
    htmlContent,
    height: MIN_HEIGHT_PX,
  }));
  const [manualHeight, setManualHeight] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [viewportHeight, setViewportHeight] = useState(() =>
    typeof window === "undefined" ? MIN_HEIGHT_PX : window.innerHeight,
  );

  if (autoHeightState.htmlContent !== htmlContent) {
    setAutoHeightState({ htmlContent, height: MIN_HEIGHT_PX });
  }
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

  useLayoutEffect(() => {
    lastAutoMeasurementRef.current = null;
    pendingAutoMeasurementRef.current = null;
  }, [htmlContent]);

  useLayoutEffect(() => {
    if (mode !== "auto") return;
    const onResize = (): void => {
      setViewportHeight(window.innerHeight);
      const measurement = lastAutoMeasurementRef.current;
      if (measurement === null) return;
      if (
        manualHeightRef.current !== null ||
        activeResizeDragRef.current !== null
      ) {
        return;
      }
      setAutoHeightState({
        htmlContent,
        height: clampAutoHeight(measurement, window.innerHeight),
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [htmlContent, mode]);

  const handleSize = (size: SandboxSize): void => {
    if (mode !== "auto" || size.height === null) return;
    if (activeResizeDragRef.current !== null) {
      pendingAutoMeasurementRef.current = size.height;
      return;
    }
    lastAutoMeasurementRef.current = size.height;
    if (manualHeightRef.current !== null) return;
    setAutoHeightState({
      htmlContent,
      height: clampAutoHeight(size.height, window.innerHeight),
    });
  };

  const applyLatestAutoMeasurement = (): void => {
    const pendingMeasurement = pendingAutoMeasurementRef.current;
    if (pendingMeasurement !== null) {
      lastAutoMeasurementRef.current = pendingMeasurement;
      pendingAutoMeasurementRef.current = null;
    }

    const measurement = lastAutoMeasurementRef.current;
    const clamped =
      measurement === null
        ? MIN_HEIGHT_PX
        : clampAutoHeight(measurement, window.innerHeight);
    setAutoHeightState({ htmlContent, height: clamped });
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
    applyLatestAutoMeasurement();
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
      <SandboxFrame
        ref={setRef}
        html={htmlContent}
        kind="wireframe"
        title={title}
        networkPolicy="https-only"
        appCsp={null}
        permissions={NO_PERMISSIONS}
        appRequests={null}
        className={cn("tc-node-wireframe__iframe", className)}
        height={mode === "auto" ? effectiveHeight : null}
        onSize={handleSize}
        onStatus={ignoreSandboxEvent}
        onRequestTeardown={ignoreSandboxEvent}
        displayMode="inline"
        onBridge={null}
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
