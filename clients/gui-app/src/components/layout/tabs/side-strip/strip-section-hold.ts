import { useEffect, useMemo, useState } from "react";
import {
  tabRefKey,
  type SplitSide,
  type StripItem,
} from "@/stores/tabs/layout";
import {
  groupEntriesBySection,
  moreUrgentSection,
  type StripSection,
  type StripSectionEntry,
  type StripSectionGroup,
  type StripTabEntry,
} from "./strip-sections";

/** A row the person is on, and the section it is drawn in right now. */
export interface StripSectionHold {
  readonly itemId: string;
  readonly section: StripSection;
}

const FRAME_SELECTOR = "[data-strip-item-id][data-strip-lane]";

/** The Activity-view row frame holding `target`, as a hold. */
function holdOf(target: EventTarget | null): StripSectionHold | null {
  if (!(target instanceof Element)) return null;
  const frame = target.closest(FRAME_SELECTOR);
  const itemId = frame?.getAttribute("data-strip-item-id");
  const lane = frame?.getAttribute("data-strip-lane");
  if (itemId === undefined || itemId === null) return null;
  switch (lane) {
    case "needs-you":
    case "to-review":
    case "working":
    case "idle":
      return { itemId, section: lane };
    default:
      return null;
  }
}

function sameHold(
  a: StripSectionHold | null,
  b: StripSectionHold | null,
): boolean {
  return a?.itemId === b?.itemId && a?.section === b?.section;
}

/**
 * The rows the person is on: the one under the pointer and the one holding
 * keyboard focus, each with the section it is drawn in. Read from the
 * scroller's events, so the rows themselves carry nothing. Mouse focus does not
 * count: a clicked row keeps focus without the person still being on it.
 */
export function useStripSectionHolds(
  scroller: HTMLElement | null,
): ReadonlyArray<StripSectionHold> {
  const [pointer, setPointer] = useState<StripSectionHold | null>(null);
  const [focus, setFocus] = useState<StripSectionHold | null>(null);
  useEffect(() => {
    if (scroller === null) return;
    const hold =
      (next: StripSectionHold | null) =>
      (held: StripSectionHold | null): StripSectionHold | null =>
        sameHold(held, next) ? held : next;
    const onPointerOver = (event: PointerEvent): void => {
      setPointer(hold(holdOf(event.target)));
    };
    const onPointerLeave = (): void => {
      setPointer(hold(null));
    };
    const onFocusIn = (event: FocusEvent): void => {
      const { target } = event;
      setFocus(
        hold(
          target instanceof Element && target.matches(":focus-visible")
            ? holdOf(target)
            : null,
        ),
      );
    };
    const onFocusOut = (event: FocusEvent): void => {
      // Focus moving between one row's own controls is still that row.
      const leaving = holdOf(event.target);
      if (
        leaving !== null &&
        holdOf(event.relatedTarget)?.itemId === leaving.itemId
      ) {
        return;
      }
      setFocus(hold(null));
    };
    scroller.addEventListener("pointerover", onPointerOver);
    scroller.addEventListener("pointerleave", onPointerLeave);
    scroller.addEventListener("focusin", onFocusIn);
    scroller.addEventListener("focusout", onFocusOut);
    return () => {
      scroller.removeEventListener("pointerover", onPointerOver);
      scroller.removeEventListener("pointerleave", onPointerLeave);
      scroller.removeEventListener("focusin", onFocusIn);
      scroller.removeEventListener("focusout", onFocusOut);
    };
  }, [scroller]);
  return useMemo(
    () =>
      [pointer, focus].filter(
        (held): held is StripSectionHold => held !== null,
      ),
    [pointer, focus],
  );
}

/**
 * Whether the pointer is inside the list, as far as the page can tell. A
 * window that lost focus or a page that was hidden gets no `pointerleave`, so
 * either one ends it too; the next `pointerover` starts it again. Pointer
 * events of every type count, and a touch pointer leaves when it lifts.
 */
export function useStripPointerInside(scroller: HTMLElement | null): boolean {
  const [inside, setInside] = useState(false);
  useEffect(() => {
    if (scroller === null) return;
    const enter = (): void => {
      setInside(true);
    };
    const leave = (): void => {
      setInside(false);
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === "hidden") setInside(false);
    };
    scroller.addEventListener("pointerover", enter);
    scroller.addEventListener("pointerleave", leave);
    window.addEventListener("blur", leave);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      scroller.removeEventListener("pointerover", enter);
      scroller.removeEventListener("pointerleave", leave);
      window.removeEventListener("blur", leave);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      // Another scroller starts with no pointer seen inside it.
      setInside(false);
    };
  }, [scroller]);
  return inside;
}

/**
 * The section the holds draw an item in, or `null` when none holds it. The
 * last hold wins, as it does in `holdInPlace`, so pass them in the order it
 * takes them: keyboard focus over the pointer, either over a waiting row.
 */
function heldSectionOf(
  holds: ReadonlyArray<StripSectionHold>,
  itemId: string,
): StripSection | null {
  return holds.filter((held) => held.itemId === itemId).at(-1)?.section ?? null;
}

function sectionOfItem(
  sections: ReadonlyArray<StripSectionGroup>,
  itemId: string,
): StripSection | null {
  return (
    sections.find((group) =>
      group.entries.some(
        (entry) => entry.kind === "tabs" && entry.itemId === itemId,
      ),
    )?.section ?? null
  );
}

/**
 * The current item and the tab on screen in it, a pair's focused member. The
 * tab is what was opened: swapping a pair's sides opens nothing, and neither
 * does closing its other member, though that gives the row a new item id.
 */
interface StripOpening {
  readonly itemId: string;
  readonly focusedTab: string | null;
}

function focusedSideOf(item: StripItem): SplitSide {
  return item.kind === "split" ? item[item.focusedSide] : item;
}

function openingOf(
  layoutItems: ReadonlyArray<StripItem>,
  activeItemId: string | null,
): StripOpening | null {
  if (activeItemId === null) return null;
  const item = layoutItems.find((entry) => entry.id === activeItemId);
  const focused = item === undefined ? null : focusedSideOf(item);
  return {
    itemId: activeItemId,
    focusedTab: focused?.kind === "tab" ? tabRefKey(focused.ref) : null,
  };
}

interface CurrentHoldState {
  readonly sections: ReadonlyArray<StripSectionGroup>;
  readonly opening: StripOpening | null;
  readonly hold: StripSectionHold | null;
}

/** Whether the same tab is on screen; by item where no tab is known. */
function sameOpened(a: StripOpening | null, b: StripOpening): boolean {
  if (a === null) return false;
  return a.focusedTab === null && b.focusedTab === null
    ? a.itemId === b.itemId
    : a.focusedTab === b.focusedTab;
}

/**
 * Where an item's row was drawn when the person opened it in this render,
 * which a change landing in the same render has not moved yet. Opening a
 * pair's other member is an opening too, and the pair's row is one row.
 * `null` for an item with no row before this render.
 */
function drawnWhenOpened(
  prev: CurrentHoldState,
  itemId: string,
  holds: ReadonlyArray<StripSectionHold>,
): StripSection | null {
  return (
    heldSectionOf(holds, itemId) ??
    (prev.hold?.itemId === itemId ? prev.hold.section : null) ??
    sectionOfItem(prev.sections, itemId)
  );
}

function currentHoldOf(
  prev: CurrentHoldState,
  sections: ReadonlyArray<StripSectionGroup>,
  opening: StripOpening | null,
  holds: ReadonlyArray<StripSectionHold>,
): StripSectionHold | null {
  if (opening === null) return null;
  const { itemId } = opening;
  const now = sectionOfItem(sections, itemId);
  if (now === null) return null;
  const floor = sameOpened(prev.opening, opening)
    ? prev.hold?.section
    : drawnWhenOpened(prev, itemId, holds);
  const section = moreUrgentSection(floor ?? now, now);
  return prev.hold?.itemId === itemId && prev.hold.section === section
    ? prev.hold
    : { itemId, section };
}

/**
 * The current task's row, held in the most urgent section it has been drawn
 * in since it became the current one: it rises with its state and never
 * sinks. Opening a task reads it, and answering it ends its wait, either of
 * which would send its row down the list, out from where the person clicked
 * and often out of view. It stays until they open another task. A task that
 * is current when the list mounts is held from the section it mounts in.
 */
export function useCurrentSectionHold(
  sections: ReadonlyArray<StripSectionGroup>,
  layoutItems: ReadonlyArray<StripItem>,
  activeItemId: string | null,
  holds: ReadonlyArray<StripSectionHold>,
): StripSectionHold | null {
  const opening = openingOf(layoutItems, activeItemId);
  const [state, setState] = useState<CurrentHoldState>(() => {
    const section =
      opening === null ? null : sectionOfItem(sections, opening.itemId);
    return {
      sections,
      opening,
      hold:
        opening === null || section === null
          ? null
          : { itemId: opening.itemId, section },
    };
  });
  if (
    state.sections !== sections ||
    state.opening?.itemId !== opening?.itemId ||
    state.opening?.focusedTab !== opening?.focusedTab
  ) {
    setState({
      sections,
      opening,
      hold: currentHoldOf(state, sections, opening, holds),
    });
  }
  return state.hold;
}

const NO_HOLDS: ReadonlyArray<StripSectionHold> = [];

interface ReleasedHoldState {
  readonly sections: ReadonlyArray<StripSectionGroup>;
  readonly current: StripSectionHold | null;
  readonly released: ReadonlyArray<StripSectionHold>;
}

/**
 * The hold of the row where it is drawn: under the pointer or keyboard focus
 * that is the section their hold keeps it in, which its hold as the current
 * row may have risen past.
 */
function drawnHoldOf(
  current: StripSectionHold,
  holds: ReadonlyArray<StripSectionHold>,
): StripSectionHold {
  const drawn = heldSectionOf(holds, current.itemId);
  return drawn === null || drawn === current.section
    ? current
    : { itemId: current.itemId, section: drawn };
}

function releasedHoldsOf(
  prev: ReleasedHoldState,
  now: {
    readonly current: StripSectionHold | null;
    readonly sections: ReadonlyArray<StripSectionGroup>;
    readonly pointerInside: boolean;
    readonly holds: ReadonlyArray<StripSectionHold>;
  },
): ReadonlyArray<StripSectionHold> {
  const { current, sections, pointerInside, holds } = now;
  if (!pointerInside) return NO_HOLDS;
  const left =
    prev.current !== null && prev.current.itemId !== current?.itemId
      ? [drawnHoldOf(prev.current, holds)]
      : [];
  // A row waits even where its own section is the one it is drawn in: a
  // folded section draws it only while it waits, and a wait that ended when
  // the two met would let the row move on under the pointer. It stops only as
  // the current row again, or with its item gone: a pair that lost a member
  // has a new item id.
  const waiting = [...prev.released, ...left].filter(
    (held) =>
      held.itemId !== current?.itemId &&
      sectionOfItem(sections, held.itemId) !== null,
  );
  if (waiting.length === 0) return NO_HOLDS;
  return waiting.length === prev.released.length &&
    waiting.every((held, index) => held === prev.released[index])
    ? prev.released
    : waiting;
}

/**
 * The holds of rows that stopped being the current one while the pointer was
 * inside the list. Letting such a row go to its own section at once would
 * move the rows under the pointer, the one just clicked among them, so it
 * waits where it was drawn, whatever its own section becomes, until the
 * pointer is no longer inside. A change made with the pointer elsewhere lets
 * it go at once.
 */
export function useReleasedSectionHolds(
  current: StripSectionHold | null,
  sections: ReadonlyArray<StripSectionGroup>,
  pointerInside: boolean,
  holds: ReadonlyArray<StripSectionHold>,
): ReadonlyArray<StripSectionHold> {
  const [state, setState] = useState<ReleasedHoldState>({
    sections,
    current,
    released: NO_HOLDS,
  });
  if (
    state.current !== current ||
    (state.sections !== sections && state.released.length > 0) ||
    (!pointerInside && state.released.length > 0)
  ) {
    setState({
      sections,
      current,
      released: releasedHoldsOf(state, {
        current,
        sections,
        pointerInside,
        holds,
      }),
    });
  }
  return state.released;
}

/**
 * The sections with each held row kept in the section it was drawn in, among
 * that section's rows in the strip's order. A held row still says what is true
 * of it, so a task that finished under the pointer reads "Done" where it was,
 * and moves when the pointer leaves. Returns `sections` itself when nothing is
 * out of place.
 */
export function holdInPlace(
  sections: ReadonlyArray<StripSectionGroup>,
  holds: ReadonlyArray<StripSectionHold>,
): ReadonlyArray<StripSectionGroup> {
  const held = new Map(
    holds.map((hold): [string, StripSection] => [hold.itemId, hold.section]),
  );
  const entries = sections.flatMap((group) => group.entries);
  const placed = entries.map((entry): StripSectionEntry => {
    if (entry.kind !== "tabs") return entry;
    const section = held.get(entry.itemId);
    return section === undefined || section === entry.section
      ? entry
      : { ...entry, section };
  });
  if (placed.every((entry, index) => entry === entries[index])) return sections;
  // The groups come back in section order; what the rows inside one keep is
  // the strip's order, the tabs first and the prompts after them.
  return groupEntriesBySection([
    ...placed
      .filter((entry): entry is StripTabEntry => entry.kind === "tabs")
      .sort((a, b) => a.stripIndex - b.stripIndex),
    ...placed.filter((entry) => entry.kind === "prompt"),
  ]);
}
