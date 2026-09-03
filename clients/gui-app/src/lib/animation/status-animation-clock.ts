import { useLayoutEffect, type RefObject } from "react";

/**
 * One shared 12.5 Hz clock for every long-lived status animation: the run
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
 * Writing inline styles from one `setInterval` at 12.5 Hz keeps the visuals,
 * costs a tenth of the recalcs, batches every indicator on screen into ONE
 * style/layout/paint pass per tick instead of one per indicator, and stops
 * while the document is hidden. Under `prefers-reduced-motion` nothing
 * subscribes, so the stylesheet's static reduced-motion rules stand.
 *
 * `elapsedMs` is a logical clock (ticks x tick length), not wall time: it
 * freezes while hidden - like a CSS animation would - and is deterministic
 * under fake timers.
 */
export const STATUS_ANIMATION_TICK_MS = 80;

export type StatusAnimationWriter = (elapsedMs: number) => void;

const writers = new Set<StatusAnimationWriter>();
let intervalHandle: number | null = null;
let elapsedMs = 0;
let visibilityListenerAttached = false;

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function documentHidden(): boolean {
  return (
    typeof document !== "undefined" && document.visibilityState === "hidden"
  );
}

function tick(): void {
  elapsedMs += STATUS_ANIMATION_TICK_MS;
  for (const writer of writers) writer(elapsedMs);
}

function start(): void {
  if (intervalHandle !== null || writers.size === 0 || documentHidden()) return;
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

function attachVisibilityListenerOnce(): void {
  if (visibilityListenerAttached || typeof document === "undefined") return;
  visibilityListenerAttached = true;
  document.addEventListener("visibilitychange", handleVisibilityChange);
}

/** The clock's current logical elapsed time, for a first frame drawn before the next tick. */
export function statusAnimationElapsedMs(): number {
  return elapsedMs;
}

/**
 * Subscribes a writer to the shared clock; returns the unsubscribe. The
 * interval exists only while at least one writer is subscribed and the
 * document is visible. Under reduced motion this is a no-op and the
 * unsubscribe is inert.
 */
export function subscribeStatusAnimation(
  writer: StatusAnimationWriter,
): () => void {
  if (prefersReducedMotion()) return () => {};
  writers.add(writer);
  attachVisibilityListenerOnce();
  start();
  return () => {
    writers.delete(writer);
    if (writers.size === 0) stop();
  };
}

/**
 * Drives one element from the shared clock. `write` runs once synchronously
 * (pre-paint, so the first frame is already in place) and then on every tick
 * while mounted. Keep `write` referentially stable (`useCallback`) - the
 * effect resubscribes when it changes. Under reduced motion `write` never
 * runs, so the element keeps whatever static styles the stylesheet gives it.
 */
export function useStatusAnimation<T extends HTMLElement>(
  ref: RefObject<T | null>,
  write: (element: T, elapsedMs: number) => void,
): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null || prefersReducedMotion()) return;
    write(element, elapsedMs);
    return subscribeStatusAnimation((elapsed) => write(element, elapsed));
  }, [ref, write]);
}

/** Test seam: drops every writer, stops the interval and rewinds the clock. */
export function resetStatusAnimationClockForTests(): void {
  writers.clear();
  stop();
  elapsedMs = 0;
}
