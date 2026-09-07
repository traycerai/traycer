import { useLayoutEffect, useSyncExternalStore, type RefObject } from "react";
import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";

/**
 * Shared 25 Hz `setInterval` clock for status animations; CSS animations churn Oilpan (~2.5 MB/s per indicator).
 * Logical `elapsedMs` (ticks x tick length), frozen while hidden; does not tick under reduced motion.
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
 * Subscribes a writer to the shared clock at `cadenceMs` (snapped to a multiple of the tick); returns the unsubscribe.
 * The interval exists only while at least one writer is subscribed, the document is visible and reduced motion is off; a writer subscribed under reduced motion is simply never ticked until the preference turns off.
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
 * Drives one element from the shared clock.
 * `write` runs once synchronously (pre-paint, so the first frame is already in place) and then on every tick while mounted; `clear` removes what `write` set, and runs when the subscription ends - unmount, a `write` identity change, or reduced motion turning.
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
    // The element last written: `ref` is re-read per tick (not in the cleanup, where React may already have detached it) so a swapped host element is picked up and the one that was animated is the one cleared.
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
