import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";

export interface NotificationCenterGeometryLock {
  readonly width: number;
  readonly height: number;
}

export interface NotificationCenterGeometryInput {
  readonly open: boolean;
  /** Whether the host summary is still unknown at the moment the shell is
   * measured - gates the cold-open height floor. Captured once per open via
   * a ref; a summary that lands later in the same session does not retract
   * the floor already applied. */
  readonly isColdOpen: boolean;
}

export interface NotificationCenterGeometryResult {
  readonly shellRef: RefObject<HTMLDivElement | null>;
  readonly style: CSSProperties;
}

/** Radix Popper renders its floating wrapper at this exact inline transform
 * until `isPositioned` flips true (see `@radix-ui/react-popper`'s Content):
 * off-screen during the measuring phase, restored to the real computed
 * `floatingStyles.transform` once placed. `onPlaced` mirrors this same
 * signal but its type is deliberately omitted from Popover's public
 * `Content` props (`Omit<PopperContentProps, 'onPlaced'>`), so this module
 * watches the wrapper's own `style` mutations instead of fighting that
 * type - both approaches gate on the identical internal state. */
const POPPER_NOT_PLACED_TRANSFORM = "translate(0, -200%)";
const POPPER_WRAPPER_SELECTOR = "[data-radix-popper-content-wrapper]";

function isPopperWrapperPlaced(wrapper: HTMLElement): boolean {
  return wrapper.style.transform !== POPPER_NOT_PLACED_TRANSFORM;
}

export const NOTIFICATION_CENTER_WIDTH_CAP_REM = 34;
export const NOTIFICATION_CENTER_HEIGHT_CAP_REM = 38;
export const NOTIFICATION_CENTER_COLD_OPEN_FLOOR_REM = 28;
const WIDTH_CAP_VIEWPORT_FRACTION = 0.9;
const HEIGHT_CAP_VIEWPORT_FRACTION = 0.7;
const DEFAULT_ROOT_FONT_SIZE_PX = 16;

export interface NotificationCenterGeometryCaps {
  readonly widthCapPx: number;
  readonly heightCapPx: number;
}

/** Pure viewport-driven cap computation - `min(90vw, 34rem, radix-available-
 * width)` for width and `min(70dvh, 38rem, radix-available-height)` for
 * height. Exported so tests can exercise the cap/floor arithmetic without a
 * real browser layout. */
export function computeNotificationCenterGeometryCaps(input: {
  readonly viewportWidthPx: number;
  readonly viewportHeightPx: number;
  readonly radixAvailableWidthPx: number;
  readonly radixAvailableHeightPx: number;
  readonly rootFontSizePx: number;
}): NotificationCenterGeometryCaps {
  return {
    widthCapPx: Math.min(
      input.viewportWidthPx * WIDTH_CAP_VIEWPORT_FRACTION,
      input.rootFontSizePx * NOTIFICATION_CENTER_WIDTH_CAP_REM,
      input.radixAvailableWidthPx,
    ),
    heightCapPx: Math.min(
      input.viewportHeightPx * HEIGHT_CAP_VIEWPORT_FRACTION,
      input.rootFontSizePx * NOTIFICATION_CENTER_HEIGHT_CAP_REM,
      input.radixAvailableHeightPx,
    ),
  };
}

/** The one-time open-session measurement: natural (CSS-capped) size clamped
 * to the viewport caps, then raised to the cold-open floor when the host
 * summary hasn't landed yet - the floor itself never exceeds the cap. */
export function computeInitialNotificationCenterGeometryLock(input: {
  readonly measuredWidthPx: number;
  readonly measuredHeightPx: number;
  readonly caps: NotificationCenterGeometryCaps;
  readonly isColdOpen: boolean;
  readonly rootFontSizePx: number;
}): NotificationCenterGeometryLock {
  let height = Math.min(input.measuredHeightPx, input.caps.heightCapPx);
  if (input.isColdOpen) {
    const floor = Math.min(
      input.rootFontSizePx * NOTIFICATION_CENTER_COLD_OPEN_FLOOR_REM,
      input.caps.heightCapPx,
    );
    height = Math.max(height, floor);
  }
  const width = Math.min(input.measuredWidthPx, input.caps.widthCapPx);
  return { width: Math.round(width), height: Math.round(height) };
}

/** Viewport-shrink re-clamp: only ever reduces the locked dimensions,
 * never grows them - the caller only invokes this while already open, and
 * a resize back up must wait for the next open. */
export function computeShrunkNotificationCenterGeometryLock(
  prev: NotificationCenterGeometryLock,
  caps: NotificationCenterGeometryCaps,
): NotificationCenterGeometryLock {
  const width = Math.min(prev.width, Math.round(caps.widthCapPx));
  const height = Math.min(prev.height, Math.round(caps.heightCapPx));
  if (width === prev.width && height === prev.height) return prev;
  return { width, height };
}

function readRootFontSizePx(): number {
  const parsed = parseFloat(
    window.getComputedStyle(document.documentElement).fontSize,
  );
  return Number.isFinite(parsed) ? parsed : DEFAULT_ROOT_FONT_SIZE_PX;
}

function readRadixAvailableWidthPx(el: HTMLElement): number {
  const raw = getComputedStyle(el)
    .getPropertyValue("--radix-popover-content-available-width")
    .trim();
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function readRadixAvailableHeightPx(el: HTMLElement): number {
  const raw = getComputedStyle(el)
    .getPropertyValue("--radix-popover-content-available-height")
    .trim();
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function readCurrentCaps(
  el: HTMLElement | null,
): NotificationCenterGeometryCaps {
  return computeNotificationCenterGeometryCaps({
    viewportWidthPx: window.innerWidth,
    viewportHeightPx: window.innerHeight,
    radixAvailableWidthPx:
      el === null ? Number.POSITIVE_INFINITY : readRadixAvailableWidthPx(el),
    radixAvailableHeightPx:
      el === null ? Number.POSITIVE_INFINITY : readRadixAvailableHeightPx(el),
    rootFontSizePx: readRootFontSizePx(),
  });
}

/**
 * Owns the T04 stable-shell geometry lifecycle: a one-time pre-paint
 * measurement gated on Radix's actual placement (never a bounding-rect
 * viewport heuristic - the Popper measuring-phase sentinel can read as
 * in-viewport under a transformed ancestor), frozen for the open session,
 * and a shrink-only re-clamp on viewport changes. Once locked, no content
 * update re-enters the measurement path - the placement watcher
 * short-circuits on every call after the first successful measurement, and
 * the shrink path only ever narrows the existing lock.
 */
export function useNotificationCenterGeometry(
  input: NotificationCenterGeometryInput,
): NotificationCenterGeometryResult {
  const shellRef = useRef<HTMLDivElement>(null);
  const [lock, setLock] = useState<NotificationCenterGeometryLock | null>(null);
  // Snapshot `input.isColdOpen` the instant `open` flips true, in state
  // rather than a ref (`react-hooks/refs` forbids ref writes during render).
  // The placement effect below only re-subscribes on `open`/this value
  // changing, and this value itself only changes at the open transition, so
  // the effect always closes over the state as of the transition - never a
  // later value the host summary's arrival could push in before placement
  // resolves.
  const [coldOpenAtOpen, setColdOpenAtOpen] = useState(input.isColdOpen);
  // Reset the lock the moment `open` flips to false, without a dedicated
  // effect: React's "adjust state during render" recipe re-runs this
  // component synchronously with the corrected state before committing, so
  // the reset lands in the same render as the `open` transition rather than
  // a follow-up effect pass.
  const [wasOpen, setWasOpen] = useState(input.open);
  if (input.open !== wasOpen) {
    setWasOpen(input.open);
    if (input.open) {
      setColdOpenAtOpen(input.isColdOpen);
    } else if (lock !== null) {
      setLock(null);
    }
  }

  useLayoutEffect(() => {
    if (!input.open) return;
    const shell = shellRef.current;
    if (shell === null) return;
    const wrapper = shell.closest<HTMLElement>(POPPER_WRAPPER_SELECTOR);
    if (wrapper === null) return;

    function nextLock(
      prev: NotificationCenterGeometryLock | null,
    ): NotificationCenterGeometryLock | null {
      if (prev !== null) return prev;
      const el = shellRef.current;
      if (el === null) return prev;
      const rect = el.getBoundingClientRect();
      return computeInitialNotificationCenterGeometryLock({
        measuredWidthPx: rect.width,
        measuredHeightPx: rect.height,
        caps: readCurrentCaps(el),
        isColdOpen: coldOpenAtOpen,
        rootFontSizePx: readRootFontSizePx(),
      });
    }

    function attemptLock(): void {
      if (wrapper === null || !isPopperWrapperPlaced(wrapper)) return;
      setLock(nextLock);
    }

    function handlePlacementMutation(): void {
      if (wrapper === null || !isPopperWrapperPlaced(wrapper)) return;
      // MutationObserver runs as a microtask outside React's commit call
      // stack. Force this later placement update into the same pre-paint
      // window; the synchronous layout-effect attempt above uses plain state
      // because React is already committing there.
      flushSync(() => {
        setLock(nextLock);
      });
    }

    // Covers the case where the wrapper is already placed by the time this
    // effect runs (e.g. a cached floating-ui position on reopen); the
    // observer then covers every subsequent placement.
    attemptLock();
    const observer = new MutationObserver(handlePlacementMutation);
    observer.observe(wrapper, { attributes: true, attributeFilter: ["style"] });
    return () => {
      observer.disconnect();
    };
  }, [input.open, coldOpenAtOpen]);

  useEffect(() => {
    if (!input.open) return;
    function handleResize(): void {
      setLock((prev) => {
        if (prev === null) return prev;
        return computeShrunkNotificationCenterGeometryLock(
          prev,
          readCurrentCaps(shellRef.current),
        );
      });
    }
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, [input.open]);

  const style = useMemo<CSSProperties>(() => {
    if (lock !== null) {
      return { width: lock.width, height: lock.height };
    }
    return {
      maxHeight:
        "min(70dvh, 38rem, var(--radix-popover-content-available-height, 100vh))",
    };
  }, [lock]);

  return { shellRef, style };
}
