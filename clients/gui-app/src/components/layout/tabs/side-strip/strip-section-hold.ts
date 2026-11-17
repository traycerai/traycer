import { useEffect, useMemo, useState } from "react";
import type { SplitSideName } from "@/stores/tabs/layout";
import {
  groupEntriesBySection,
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

/** The current item, and which half of it when it is a split pair. */
export interface StripOpening {
  readonly itemId: string;
  readonly focusedSide: SplitSideName | null;
}

interface OpenedHoldState {
  readonly sections: ReadonlyArray<StripSectionGroup>;
  readonly opening: StripOpening | null;
  readonly hold: StripSectionHold | null;
}

function sameOpening(a: StripOpening | null, b: StripOpening | null): boolean {
  return a?.itemId === b?.itemId && a?.focusedSide === b?.focusedSide;
}

function openedHoldOf(
  prev: OpenedHoldState | null,
  sections: ReadonlyArray<StripSectionGroup>,
  opening: StripOpening | null,
  holds: ReadonlyArray<StripSectionHold>,
): StripSectionHold | null {
  if (opening === null) return null;
  const { itemId } = opening;
  const now = sectionOfItem(sections, itemId);
  if (now !== "to-review" && now !== "idle") return null;
  if (prev !== null && sameOpening(prev.opening, opening)) return prev.hold;
  // Opened in this render: where the row was drawn when the person opened it,
  // which a read landing in the same render has not changed yet. Opening a
  // pair's other half is an opening too, and the pair's row is one row.
  const opened =
    holds.find((held) => held.itemId === itemId)?.section ??
    (prev?.hold?.itemId === itemId ? prev.hold.section : null) ??
    (prev === null ? null : sectionOfItem(prev.sections, itemId)) ??
    now;
  return opened === "to-review" ? { itemId, section: "to-review" } : null;
}

/**
 * The current task's row, held in To review when the person opened it from
 * there. Opening a task reads it, which would send its row down to Idle, out
 * from where the person just clicked and often out of view. It stays until
 * they open another task, or until this one starts working or needs them,
 * which is a move its own state makes.
 */
export function useOpenedSectionHold(
  sections: ReadonlyArray<StripSectionGroup>,
  opening: StripOpening | null,
  holds: ReadonlyArray<StripSectionHold>,
): StripSectionHold | null {
  const [state, setState] = useState<OpenedHoldState>(() => ({
    sections,
    opening,
    hold: openedHoldOf(null, sections, opening, holds),
  }));
  if (state.sections !== sections || !sameOpening(state.opening, opening)) {
    setState({
      sections,
      opening,
      hold: openedHoldOf(state, sections, opening, holds),
    });
  }
  return state.hold;
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
