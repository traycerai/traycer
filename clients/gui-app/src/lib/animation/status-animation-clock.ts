import { useLayoutEffect, useSyncExternalStore, type RefObject } from "react";
import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";

/**
 * One shared 25 Hz clock for every long-lived status animation: the run
 * indicator's shimmer and dots, live pulses, braille spinners.
 *
 * Why these are not CSS animations. Blink samples every running CSS / WAAPI
 * animation on the main thread once per display frame and marks its element
 * for style recalc - whether or not the animation is composited, and `steps()`
 * timing does not change that. Each recalc against this app's stylesheet
 * allocates a few KB of Blink (Oilpan) garbage, so a single always-on run
 * indicator at 120 Hz measured ~2.5 MB/s of C++ heap churn, four running
 * chats ~10 MB/s. Oilpan only collects every ~300 MB, keeps the freed pages
 * pooled, and V8's memory reducer never runs while the allocation rate stays
 * that high - the renderer ratcheted to 1.5 GB and stayed there.
 *
 * Writing inline styles from one `setInterval` keeps the visuals, costs a
 * fraction of the recalcs, batches every indicator on screen into ONE
 * style/layout/paint pass per tick instead of one per indicator, and stops
 * while the document is hidden.
 *
 * The interval ticks at 25 Hz and each writer picks its cadence as a multiple
 * of that. A sweeping highlight band is motion the eye tracks continuously,
 * and at 12.5 Hz it visibly steps (~7% of a title per frame); its writes
 * measured in the noise, so it runs every tick. A 1 s ping ring or a 1.4 s
 * dot bounce reads fine at 12.5 Hz, and the rings were the one writer with a
 * measurable cost, so they take every second tick.
 *
 * Reduced motion is honoured live: the clock does not tick while
 * `prefers-reduced-motion` matches, and `useStatusAnimation` clears its
 * element's inline styles the moment the preference turns on, so the
 * stylesheet's static reduced-motion rules stand; when it turns off again the
 * animations resume.
 *
 * `elapsedMs` is a logical clock (ticks x tick length), not wall time: it
 * freezes while hidden - like a CSS animation would - and is deterministic
 * under fake timers.
 */
export const STATUS_ANIMATION_TICK_MS = 40;

/** Every tick (25 Hz): motion the eye follows, like a sweeping highlight band. */
export const STATUS_ANIMATION_SMOOTH_CADENCE_MS = STATUS_ANIMATION_TICK_MS;

/** Every second tick (12.5 Hz): slow pulses - ping rings, bouncing dots. */
export const STATUS_ANIMATION_PULSE_CADENCE_MS = STATUS_ANIMATION_TICK_MS * 2;

export type StatusAnimationWriter = (elapsedMs: number) => void;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** Writer -> cadence in ms (a positive multiple of the tick). */
const writers = new Map<StatusAnimationWriter, number>();
const reducedMotionSubscribers = new Set<() => void>();
let intervalHandle: number | null = null;
let elapsedMs = 0;
let listenersAttached = false;
let reducedMotionList: MediaQueryList | null = null;

function queryReducedMotion(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return null;
  return window.matchMedia(REDUCED_MOTION_QUERY);
}

export function prefersReducedMotion(): boolean {
  const list = reducedMotionList ?? queryReducedMotion();
  return list?.matches ?? false;
}

function documentHidden(): boolean {
  return (
    typeof document !== "undefined" && document.visibilityState === "hidden"
  );
}

function tick(): void {
  elapsedMs += STATUS_ANIMATION_TICK_MS;
  for (const [writer, cadenceMs] of writers) {
    if (elapsedMs % cadenceMs !== 0) continue;
    writer(elapsedMs);
  }
}

/** Snaps a requested cadence to a positive multiple of the tick. */
function normalizeCadence(cadenceMs: number): number {
  const ticks = Math.max(1, Math.round(cadenceMs / STATUS_ANIMATION_TICK_MS));
  return ticks * STATUS_ANIMATION_TICK_MS;
}

function start(): void {
  if (
    intervalHandle !== null ||
    writers.size === 0 ||
    documentHidden() ||
    prefersReducedMotion()
  )
    return;
  intervalHandle = window.setInterval(tick, STATUS_ANIMATION_TICK_MS);
}

function stop(): void {
  if (intervalHandle === null) return;
  window.clearInterval(intervalHandle);
  intervalHandle = null;
}

function handleVisibilityChange(): void {
  if (documentHidden()) stop();
  else start();
}

function handleReducedMotionChange(): void {
  if (prefersReducedMotion()) stop();
  else start();
  for (const notify of reducedMotionSubscribers) notify();
}

function attachListenersOnce(): void {
  if (listenersAttached || typeof document === "undefined") return;
  listenersAttached = true;
  document.addEventListener("visibilitychange", handleVisibilityChange);
  reducedMotionList = queryReducedMotion();
  reducedMotionList?.addEventListener("change", handleReducedMotionChange);
}

function detachListeners(): void {
  if (!listenersAttached) return;
  listenersAttached = false;
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  reducedMotionList?.removeEventListener("change", handleReducedMotionChange);
  reducedMotionList = null;
}

/** The clock's current logical elapsed time, for a first frame drawn before the next tick. */
export function statusAnimationElapsedMs(): number {
  return elapsedMs;
}

/**
 * Subscribes a writer to the shared clock at `cadenceMs` (snapped to a
 * multiple of the tick); returns the unsubscribe. The interval exists only
 * while at least one writer is subscribed, the document is visible and
 * reduced motion is off; a writer subscribed under reduced motion is simply
 * never ticked until the preference turns off.
 */
export function subscribeStatusAnimation(
  writer: StatusAnimationWriter,
  cadenceMs: number,
): () => void {
  writers.set(writer, normalizeCadence(cadenceMs));
  attachListenersOnce();
  start();
  return () => {
    writers.delete(writer);
    if (writers.size === 0) stop();
  };
}

function subscribeReducedMotion(notify: () => void): () => void {
  reducedMotionSubscribers.add(notify);
  attachListenersOnce();
  return () => {
    reducedMotionSubscribers.delete(notify);
  };
}

function serverPrefersReducedMotion(): boolean {
  return false;
}

/** Whether `prefers-reduced-motion: reduce` matches, re-rendering when it changes. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    prefersReducedMotion,
    serverPrefersReducedMotion,
  );
}

/**
 * Drives one element from the shared clock. `write` runs once synchronously
 * (pre-paint, so the first frame is already in place) and then on every tick
 * while mounted; `clear` removes what `write` set, and runs when the
 * subscription ends - unmount, a `write` identity change, or reduced motion
 * turning on - so the stylesheet's static rules take over. Keep both
 * referentially stable (`useCallback`): the effect resubscribes when either
 * changes. Under reduced motion neither runs and nothing subscribes.
 *
 * Each tick re-reads `ref`, so a host element swapped underneath the same
 * component (a polymorphic `as` prop) picks up the animation on the next tick.
 * `cadenceMs` is one of the `STATUS_ANIMATION_*_CADENCE_MS` constants.
 *
 * A pane kept mounted but hidden (`TopLevelTabHost` keeps inactive tabs under
 * `display:none`) cannot paint, so its writers unsubscribe while the pane is
 * hidden (`usePaneVisible`, `true` outside a pane) and resume on the next show
 * - the same gate the stream flush coordinator's hidden tier follows.
 */
export function useStatusAnimation<T extends HTMLElement>(
  ref: RefObject<T | null>,
  write: (element: T, elapsedMs: number) => void,
  clear: (element: T) => void,
  cadenceMs: number,
): void {
  const reducedMotion = useReducedMotion();
  const paneVisible = usePaneVisible();
  useLayoutEffect(() => {
    if (reducedMotion || !paneVisible) return;
    const mounted = ref.current;
    if (mounted === null) return;
    // The element last written: `ref` is re-read per tick (not in the
    // cleanup, where React may already have detached it) so a swapped host
    // element is picked up and the one that was animated is the one cleared.
    let target = mounted;
    write(target, elapsedMs);
    const unsubscribe = subscribeStatusAnimation((elapsed) => {
      target = ref.current ?? target;
      write(target, elapsed);
    }, cadenceMs);
    return () => {
      unsubscribe();
      clear(target);
    };
  }, [ref, write, clear, cadenceMs, reducedMotion, paneVisible]);
}

/** Test seam: drops every writer and listener, stops the interval and rewinds the clock. */
export function resetStatusAnimationClockForTests(): void {
  writers.clear();
  reducedMotionSubscribers.clear();
  stop();
  detachListeners();
  elapsedMs = 0;
}
