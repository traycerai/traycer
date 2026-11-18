import { useCallback, useSyncExternalStore } from "react";
import { useTileBodyVisible } from "@/components/epic-canvas/hooks/use-tile-body-visible";
import {
  isDocumentVisible,
  subscribeDocumentVisibility,
} from "@/lib/dom/document-visibility";

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

/**
 * One subscribed writer. `element` is the node it animates; `null` means the
 * writer is not tied to a node and always ticks. `onScreen` is the shared
 * IntersectionObserver's last answer for that node, `true` until the first one
 * arrives so a writer already on screen never waits a frame.
 */
interface WriterRegistration {
  readonly cadenceMs: number;
  readonly element: Element | null;
  onScreen: boolean;
}

const writers = new Map<StatusAnimationWriter, WriterRegistration>();
const writersByElement = new Map<Element, Set<StatusAnimationWriter>>();
let intersectionObserver: IntersectionObserver | null = null;
/** Writers whose element is on screen (or untracked): the interval runs only while this is > 0. */
let onScreenWriters = 0;
const reducedMotionSubscribers = new Set<() => void>();
let intervalHandle: number | null = null;
let elapsedMs = 0;
let listenersAttached = false;
let stopVisibility: (() => void) | null = null;
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
  return !isDocumentVisible();
}

function tick(): void {
  elapsedMs += STATUS_ANIMATION_TICK_MS;
  for (const [writer, registration] of writers) {
    if (!registration.onScreen) continue;
    if (elapsedMs % registration.cadenceMs !== 0) continue;
    writer(elapsedMs);
  }
}

function sharedIntersectionObserver(): IntersectionObserver | null {
  if (intersectionObserver !== null) return intersectionObserver;
  if (typeof IntersectionObserver !== "function") return null;
  intersectionObserver = new IntersectionObserver(handleIntersections);
  return intersectionObserver;
}

/**
 * Off screen means what the eye cannot see, decided off the main thread's
 * critical path: the IntersectionObserver reports a node scrolled out of its
 * scroller, clipped away, or outside the viewport, with no layout read in the
 * tick. Concealed keep-alive tab bodies are gated earlier, in the hooks
 * (`useTileBodyVisible`), because `visibility:hidden` still intersects.
 */
function handleIntersections(entries: IntersectionObserverEntry[]): void {
  for (const entry of entries) {
    const subscribed = writersByElement.get(entry.target);
    if (subscribed === undefined) continue;
    for (const writer of Array.from(subscribed)) {
      const registration = writers.get(writer);
      if (registration === undefined) continue;
      setWriterOnScreen(writer, registration, entry.isIntersecting);
    }
  }
}

function observeWriter(
  writer: StatusAnimationWriter,
  element: Element | null,
): void {
  const observer = element === null ? null : sharedIntersectionObserver();
  if (element === null || observer === null) return;
  const subscribed = writersByElement.get(element);
  if (subscribed !== undefined) {
    subscribed.add(writer);
    return;
  }
  writersByElement.set(element, new Set([writer]));
  observer.observe(element);
}

function unobserveWriter(
  writer: StatusAnimationWriter,
  element: Element | null,
): void {
  if (element === null) return;
  const subscribed = writersByElement.get(element);
  if (subscribed === undefined) return;
  subscribed.delete(writer);
  if (subscribed.size > 0) return;
  writersByElement.delete(element);
  intersectionObserver?.unobserve(element);
}

/**
 * A writer coming back on screen is written at once at the SHARED logical
 * time, so it resumes in phase with every other indicator instead of showing
 * the frame it was left at; the interval starts with the first on-screen
 * writer and stops with the last.
 */
function setWriterOnScreen(
  writer: StatusAnimationWriter,
  registration: WriterRegistration,
  onScreen: boolean,
): void {
  if (registration.onScreen === onScreen) return;
  registration.onScreen = onScreen;
  if (!onScreen) {
    onScreenWriters -= 1;
    if (onScreenWriters === 0) stop();
    return;
  }
  onScreenWriters += 1;
  writer(elapsedMs);
  start();
}

/** Snaps a requested cadence to a positive multiple of the tick. */
function normalizeCadence(cadenceMs: number): number {
  const ticks = Math.max(1, Math.round(cadenceMs / STATUS_ANIMATION_TICK_MS));
  return ticks * STATUS_ANIMATION_TICK_MS;
}

function start(): void {
  if (
    intervalHandle !== null ||
    onScreenWriters === 0 ||
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
  stopVisibility = subscribeDocumentVisibility(handleVisibilityChange);
  reducedMotionList = queryReducedMotion();
  reducedMotionList?.addEventListener("change", handleReducedMotionChange);
}

function detachListeners(): void {
  if (!listenersAttached) return;
  listenersAttached = false;
  stopVisibility?.();
  stopVisibility = null;
  reducedMotionList?.removeEventListener("change", handleReducedMotionChange);
  reducedMotionList = null;
}

/** The clock's current logical elapsed time, for a first frame drawn before the next tick. */
export function statusAnimationElapsedMs(): number {
  return elapsedMs;
}

/**
 * Subscribes a writer to the shared clock at `cadenceMs` (snapped to a
 * multiple of the tick); returns the unsubscribe. `element` is the node the
 * writer animates: the writer is ticked only while that node is on screen
 * (`null` for a writer tied to no node, which always ticks). A writer whose
 * node is replaced resubscribes with the new one. The interval exists only
 * while at least one subscribed writer is on screen, the document is visible
 * and reduced motion is off; a writer subscribed under reduced motion is
 * simply never ticked until the preference turns off.
 */
export function subscribeStatusAnimation(
  writer: StatusAnimationWriter,
  cadenceMs: number,
  element: Element | null,
): () => void {
  const previous = writers.get(writer);
  if (previous !== undefined) removeWriter(writer, previous);
  const registration: WriterRegistration = {
    cadenceMs: normalizeCadence(cadenceMs),
    element,
    onScreen: true,
  };
  writers.set(writer, registration);
  onScreenWriters += 1;
  observeWriter(writer, element);
  attachListenersOnce();
  start();
  return () => {
    if (writers.get(writer) === registration)
      removeWriter(writer, registration);
  };
}

function removeWriter(
  writer: StatusAnimationWriter,
  registration: WriterRegistration,
): void {
  writers.delete(writer);
  unobserveWriter(writer, registration.element);
  if (registration.onScreen) onScreenWriters -= 1;
  if (onScreenWriters === 0) stop();
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
 * Drives one element from the shared clock; returns the callback ref to put on
 * that element. On attach `write` runs once synchronously (in the commit, so
 * the first frame is already in place before paint) and then on every tick
 * while the element is on screen; `clear` removes what `write` set, and runs
 * when the subscription ends - detach, a host element swapped by a
 * polymorphic `as` (React detaches the old node and attaches the new one), a
 * `write` identity change, or reduced motion turning on - so the stylesheet's
 * static rules take over. Keep `write` and `clear` referentially stable
 * (`useCallback`): the ref changes, and so resubscribes, when either does.
 * Under reduced motion neither runs and nothing subscribes.
 *
 * The target may be an HTML or an SVG element - both carry the inline `style`
 * a writer writes, and a glyph animated in place (a chip's lucide icon) is an
 * `<svg>`, not a wrapper around one. `cadenceMs` is one of the
 * `STATUS_ANIMATION_*_CADENCE_MS` constants.
 *
 * Only an indicator someone can see is ticked. A body that cannot paint
 * unsubscribes: a hidden keep-alive pane (`TopLevelTabHost` keeps inactive
 * tabs under `display:none`) and an unselected tab body kept mounted under
 * `visibility:hidden` (retained chats, every terminal tab), both read through
 * `useTileBodyVisible` (`true` outside a pane or tab) - the same gate the
 * stream flush coordinator's hidden tier follows. An element that is mounted
 * and shown but scrolled out or outside the viewport stays subscribed and is
 * simply not ticked until the clock's IntersectionObserver sees it again.
 */
export function useStatusAnimation<T extends HTMLElement | SVGElement>(
  write: (element: T, elapsedMs: number) => void,
  clear: (element: T) => void,
  cadenceMs: number,
): (element: T | null) => (() => void) | undefined {
  const reducedMotion = useReducedMotion();
  const bodyVisible = useTileBodyVisible();
  return useCallback(
    (element: T | null) => {
      if (element === null || reducedMotion || !bodyVisible) return undefined;
      write(element, elapsedMs);
      const unsubscribe = subscribeStatusAnimation(
        (elapsed) => {
          write(element, elapsed);
        },
        cadenceMs,
        element,
      );
      return () => {
        unsubscribe();
        clear(element);
      };
    },
    [write, clear, cadenceMs, reducedMotion, bodyVisible],
  );
}

/** Test seam: drops every writer and listener, stops the interval and rewinds the clock. */
export function resetStatusAnimationClockForTests(): void {
  writers.clear();
  writersByElement.clear();
  intersectionObserver?.disconnect();
  intersectionObserver = null;
  onScreenWriters = 0;
  reducedMotionSubscribers.clear();
  stop();
  detachListeners();
  elapsedMs = 0;
}
