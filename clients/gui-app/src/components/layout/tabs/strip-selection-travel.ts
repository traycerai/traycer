import { useReducedMotion } from "motion/react";
import { useLayoutEffect, useRef, type RefObject } from "react";
import { create } from "zustand";
import { useEpicDndStore } from "@/components/epic-canvas/dnd/dnd-store";
import { cssEscape } from "@/lib/dom/css-escape";
import {
  flattenStripItemRefs,
  tabRefKey,
  type StripItem,
} from "@/stores/tabs/layout";
import {
  subscribeClosingTabs,
  takeReopenGlow,
} from "@/stores/tabs/strip-motion";
import { playJoinGlow, stopJoinGlow } from "./join-glow";

/**
 * The selected tab's sheet slides from the tab you left to the tab you chose.
 *
 * At rest each tab draws its own joined box (`TabChromeBackground`, or the
 * split group's box), and a box that belongs to one tab cannot move to
 * another. So for the length of one slide a single traveller box
 * (`StripSelectionTraveller`) stands in: the destination hides its own box,
 * the traveller carries the sheet join (so the bridge down to the task
 * follows it), and on landing the two swap in one commit at the same rect.
 * The traveller sits under every tab in paint order, so labels it passes stay
 * readable.
 *
 * It only runs where the join exists (from md), with motion allowed, outside a
 * drag, and when both ends are fully in view: the strip reveals a clipped
 * destination instantly by design, and a slide from a clipped source would
 * run the bridge out past the strip's edge.
 */

/** The strip's drag-overlay spring, so everything moving on it settles alike. */
const STIFFNESS = 420;
const DAMPING = 34;
const MASS = 0.7;
const MAX_STEP_S = 1 / 240;
const MAX_FRAME_S = 0.064;
/** The joined box sits 2px inside its 36px frame (`TAB_BOX_CLASS`). */
const BOX_INSET_PX = 2;
/** The sheet join only exists from md (`@variant md` in `index.css`). */
const JOIN_MEDIA_QUERY = "(min-width: 48rem)";
const SETTLED_PX = 0.5;
const SETTLED_VELOCITY = 8;

interface TravelState {
  /** The strip item whose own selected box is hidden while the traveller flies to it. */
  readonly concealedItemId: string | null;
}

const useStripTravelStore = create<TravelState>()(() => ({
  concealedItemId: null,
}));

export function useConcealedForTravel(stripItemId: string | null): boolean {
  return useStripTravelStore(
    (state) => stripItemId !== null && state.concealedItemId === stripItemId,
  );
}

export function useSelectionTravelling(): boolean {
  return useStripTravelStore((state) => state.concealedItemId !== null);
}

interface BoxRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface SpringAxis {
  position: number;
  velocity: number;
}

interface Flight {
  itemId: string;
  readonly left: SpringAxis;
  readonly width: SpringAxis;
  glow: boolean;
  lastTarget: BoxRect | null;
  lastTime: number;
  frame: number;
}

function stepSpring(axis: SpringAxis, target: number, seconds: number): void {
  let remaining = seconds;
  while (remaining > 0) {
    const step = Math.min(remaining, MAX_STEP_S);
    const force =
      -STIFFNESS * (axis.position - target) - DAMPING * axis.velocity;
    axis.velocity += (force / MASS) * step;
    axis.position += axis.velocity * step;
    remaining -= step;
  }
}

function frameOf(scroller: HTMLElement, itemId: string): HTMLElement | null {
  return scroller.querySelector<HTMLElement>(
    `:scope > [data-strip-item-id="${cssEscape(itemId)}"]`,
  );
}

/** The item's joined box, in the scroller's content coordinates. */
function boxOf(scroller: HTMLElement, frame: HTMLElement): BoxRect {
  const box = frame.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  return {
    left: box.left - view.left + scroller.scrollLeft + BOX_INSET_PX,
    top: box.top - view.top + scroller.scrollTop + BOX_INSET_PX,
    width: Math.max(0, box.width - BOX_INSET_PX * 2),
    height: Math.max(0, box.height - BOX_INSET_PX * 2),
  };
}

function joinIsDrawn(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia(JOIN_MEDIA_QUERY).matches
  );
}

function isWhollyInView(scroller: HTMLElement, box: BoxRect): boolean {
  return (
    box.left >= scroller.scrollLeft - SETTLED_PX &&
    box.left + box.width <=
      scroller.scrollLeft + scroller.clientWidth + SETTLED_PX
  );
}

/**
 * The layout editor's session tab is a coloured mode marker that never joins
 * the sheet, so no join may slide into or out of it. An item that is gone (a
 * closed tab) was an ordinary tab.
 */
function joinsSheet(item: StripItem | undefined): boolean {
  return item?.kind !== "tab" || item.ref.kind !== "sample-workspace";
}

function settledOn(flight: Flight, target: BoxRect): boolean {
  const { lastTarget } = flight;
  return (
    lastTarget !== null &&
    Math.abs(lastTarget.left - target.left) < SETTLED_PX &&
    Math.abs(lastTarget.width - target.width) < SETTLED_PX &&
    Math.abs(flight.left.position - target.left) < SETTLED_PX &&
    Math.abs(flight.width.position - target.width) < SETTLED_PX &&
    Math.abs(flight.left.velocity) < SETTLED_VELOCITY &&
    Math.abs(flight.width.velocity) < SETTLED_VELOCITY
  );
}

function placeTraveller(
  traveller: HTMLElement,
  left: number,
  width: number,
  box: BoxRect,
): void {
  traveller.style.left = `${left}px`;
  traveller.style.width = `${Math.max(0, width)}px`;
  traveller.style.top = `${box.top}px`;
  traveller.style.height = `${box.height}px`;
}

/** The selected box as a close found it, just before the tab went. */
interface ClosedBox {
  readonly itemId: string;
  readonly box: BoxRect;
  readonly at: number;
}

/** A close lands within the same task; anything older is another change. */
const CLOSED_BOX_TTL_MS = 1000;

/**
 * Where the slide starts: the tab you left or, when that tab is gone, the box
 * a close captured for exactly that tab. A tab that vanished any other way (a
 * draft becoming a task, a split pairing) has no source, so the selection
 * jumps, as every change without a gesture does.
 */
function sourceBox(
  scroller: HTMLElement,
  previous: string | null,
  closed: ClosedBox | null,
): BoxRect | null {
  if (previous === null) return null;
  const frame = frameOf(scroller, previous);
  if (frame !== null) return boxOf(scroller, frame);
  return closed !== null &&
    closed.itemId === previous &&
    performance.now() - closed.at < CLOSED_BOX_TTL_MS
    ? closed.box
    : null;
}

/** The traveller's box right now, while it is in flight. */
function flightBox(flight: Flight, height: BoxRect): BoxRect {
  return {
    left: flight.left.position,
    width: flight.width.position,
    top: height.top,
    height: height.height,
  };
}

function land(flight: Flight | null, owesGlow: boolean): void {
  if (flight !== null) cancelAnimationFrame(flight.frame);
  useStripTravelStore.setState({ concealedItemId: null });
  if (owesGlow) playJoinGlow();
}

interface TravelRoute {
  readonly itemId: string;
  /** `null` when a flight is already under way and simply turns. */
  readonly from: BoxRect | null;
  readonly to: BoxRect;
}

/** Where the selection should slide, or `null` when it should simply jump. */
function planTravel(input: {
  readonly scroller: HTMLElement;
  readonly items: ReadonlyArray<StripItem>;
  readonly previous: string | null;
  readonly activeItemId: string | null;
  readonly flight: Flight | null;
  readonly closed: ClosedBox | null;
  readonly reduceMotion: boolean;
}): TravelRoute | null {
  const { scroller, items, previous, activeItemId, flight } = input;
  if (
    previous === null ||
    activeItemId === null ||
    input.reduceMotion ||
    !joinIsDrawn() ||
    useEpicDndStore.getState().activeHeaderTab !== null ||
    !joinsSheet(items.find((item) => item.id === previous)) ||
    !joinsSheet(items.find((item) => item.id === activeItemId))
  )
    return null;
  const destinationFrame = frameOf(scroller, activeItemId);
  if (destinationFrame === null) return null;
  const to = boxOf(scroller, destinationFrame);
  if (!isWhollyInView(scroller, to)) return null;
  // A turn starts wherever the traveller is now, which a quick run of
  // switches on a scrolled strip can have left out of view.
  const from =
    flight === null
      ? sourceBox(scroller, previous, input.closed)
      : flightBox(flight, to);
  if (from === null || !isWhollyInView(scroller, from)) return null;
  return { itemId: activeItemId, from: flight === null ? from : null, to };
}

/** Starts the traveller at the route's source and springs it home. */
function fly(input: {
  readonly scroller: HTMLElement;
  readonly traveller: HTMLElement;
  readonly route: TravelRoute;
  readonly glow: boolean;
  readonly onLanded: () => void;
}): Flight | null {
  const { scroller, traveller, route, onLanded } = input;
  if (route.from === null) return null;
  const flight: Flight = {
    itemId: route.itemId,
    left: { position: route.from.left, velocity: 0 },
    width: { position: route.from.width, velocity: 0 },
    glow: input.glow,
    lastTarget: null,
    lastTime: performance.now(),
    frame: 0,
  };
  placeTraveller(traveller, route.from.left, route.from.width, route.to);
  const tick = (now: number) => {
    const frame = frameOf(scroller, flight.itemId);
    // A drag owns the strip's geometry, and its overlay carries the join.
    if (frame === null || useEpicDndStore.getState().activeHeaderTab !== null) {
      onLanded();
      land(flight, false);
      return;
    }
    // Re-measured every frame: a reopened slot is still opening, and the
    // traveller lands on it as it grows.
    const target = boxOf(scroller, frame);
    const seconds = Math.min(MAX_FRAME_S, (now - flight.lastTime) / 1000);
    flight.lastTime = now;
    stepSpring(flight.left, target.left, seconds);
    stepSpring(flight.width, target.width, seconds);
    placeTraveller(
      traveller,
      flight.left.position,
      flight.width.position,
      target,
    );
    const settled = settledOn(flight, target);
    flight.lastTarget = target;
    if (settled) {
      onLanded();
      land(flight, flight.glow);
      return;
    }
    flight.frame = requestAnimationFrame(tick);
  };
  flight.frame = requestAnimationFrame(tick);
  return flight;
}

/**
 * Must be called after `useStripScroller`: its reveal runs in an earlier
 * layout effect of the same commit, so the destination measured here is
 * already scrolled into view.
 */
export function useSelectionTravel(input: {
  readonly scrollerRef: RefObject<HTMLDivElement | null>;
  readonly travellerRef: RefObject<HTMLSpanElement | null>;
  readonly activeItemId: string | null;
  readonly layoutItems: ReadonlyArray<StripItem>;
}): void {
  const { scrollerRef, travellerRef, activeItemId, layoutItems } = input;
  const reduceMotion = useReducedMotion() === true;
  const previousActiveRef = useRef(activeItemId);
  // A closed tab has no frame left to measure, and it is exactly where a
  // slide to its successor starts; the close captures it while the strip still
  // paints the tab.
  const closedBoxRef = useRef<ClosedBox | null>(null);
  const flightRef = useRef<Flight | null>(null);
  const layoutItemsRef = useRef(layoutItems);

  useLayoutEffect(() => {
    layoutItemsRef.current = layoutItems;
  });

  useLayoutEffect(
    () =>
      subscribeClosingTabs(() => {
        const scroller = scrollerRef.current;
        const active = previousActiveRef.current;
        if (scroller === null || active === null) return;
        const frame = frameOf(scroller, active);
        if (frame === null) return;
        const box = boxOf(scroller, frame);
        const flight = flightRef.current;
        closedBoxRef.current = {
          itemId: active,
          box: flight === null ? box : flightBox(flight, box),
          at: performance.now(),
        };
      }),
    [scrollerRef],
  );

  useLayoutEffect(() => {
    const previous = previousActiveRef.current;
    previousActiveRef.current = activeItemId;
    const scroller = scrollerRef.current;
    const traveller = travellerRef.current;
    if (previous === activeItemId || scroller === null || traveller === null)
      return;
    // The glow belongs to the tab a reopen selected, not to the next one.
    stopJoinGlow();
    const items = layoutItemsRef.current;
    const destination = items.find((item) => item.id === activeItemId);
    const owesGlow =
      destination !== undefined &&
      takeReopenGlow(flattenStripItemRefs(destination).map(tabRefKey)) &&
      !reduceMotion;
    const flight = flightRef.current;
    const route = planTravel({
      scroller,
      items,
      previous,
      activeItemId,
      flight,
      closed: closedBoxRef.current,
      reduceMotion,
    });
    if (route === null) {
      flightRef.current = null;
      land(flight, owesGlow);
      return;
    }
    useStripTravelStore.setState({ concealedItemId: route.itemId });
    if (flight !== null) {
      // Retarget mid-flight, keeping the momentum the eye is following.
      flight.itemId = route.itemId;
      flight.glow = owesGlow;
      flight.lastTarget = null;
      return;
    }
    flightRef.current = fly({
      scroller,
      traveller,
      route,
      glow: owesGlow,
      onLanded: () => {
        flightRef.current = null;
      },
    });
  }, [activeItemId, reduceMotion, scrollerRef, travellerRef]);

  useLayoutEffect(
    () => () => {
      land(flightRef.current, false);
      flightRef.current = null;
    },
    [],
  );
}
