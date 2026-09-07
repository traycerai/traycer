import { animate, type MotionValue, type Transition } from "motion/react";
import { appLogger } from "@/lib/logger";
import { HEADER_STRIP_SCROLL_TEST_ID } from "./header-strip-geometry";

/** Nothing keyed on the transform can see it: the transform trace shows an ordinary decay to zero either way. */

/** `targetX` and `transition` are re-published by the item on every layout pass so the re-base can restart the
 * spring toward the current target. */
interface HeaderStripItemEntry {
  readonly value: MotionValue<number>;
  node: HTMLElement | null;
  targetX: number;
  transition: Transition;
  lastBaselineLeft: number | null;
}

/** The mutable bookkeeping lives here rather than on an object the component owns. */
const entries = new Map<MotionValue<number>, HeaderStripItemEntry>();

export function registerHeaderStripItem(
  value: MotionValue<number>,
): () => void {
  // The node and target are published by the item's own effect, which runs
  // immediately after this one and again on every later render.
  entries.set(value, {
    value,
    node: null,
    targetX: value.get(),
    transition: { duration: 0 },
    lastBaselineLeft: null,
  });
  return () => {
    entries.delete(value);
  };
}

/** Called on every render, because both can change: React can recreate the element, and `jump` cancels the
 * animation in flight so the re-base has to restart one toward the current target. */
export function syncHeaderStripItem(input: {
  readonly value: MotionValue<number>;
  readonly node: HTMLElement | null;
  readonly targetX: number;
  readonly transition: Transition;
}): void {
  const entry = entries.get(input.value);
  if (entry === undefined) return;
  entry.node = input.node;
  entry.targetX = input.targetX;
  entry.transition = input.transition;
}

/** The correction is armed by the commit rather than run on every render: a baseline can move for reasons that
 * are not a drop (a tab closes, the window resizes) and those keep their existing behaviour. */
let armed = false;

export function armHeaderStripCommitHandoff(): void {
  armed = true;
}

export function isHeaderStripCommitHandoffArmed(): boolean {
  return armed;
}

export function disarmHeaderStripCommitHandoff(): void {
  armed = false;
}

/** The transform that leaves rendered position unchanged across a baseline move. */
export function handoffTransformFor(input: {
  readonly previousBaselineLeft: number;
  readonly nextBaselineLeft: number;
  readonly appliedTransformX: number;
}): number {
  return (
    input.previousBaselineLeft +
    input.appliedTransformX -
    input.nextBaselineLeft
  );
}

/** A strip item that is in the DOM but not in the registry cannot be re-based, and the first version of this
 * mechanism let that pass in silence. */
export interface HeaderStripHandoffReport {
  readonly rebased: readonly string[];
  readonly moved: readonly string[];
  readonly uncorrected: readonly string[];
}

/** Walking the DOM rather than the registry is deliberate - it is the only way to notice an item that is on
 * screen and not registered. */
export function runHeaderStripCommitHandoff(): HeaderStripHandoffReport {
  const byNode = new Map<HTMLElement, HeaderStripItemEntry>();
  for (const entry of entries.values()) {
    if (entry.node !== null) byNode.set(entry.node, entry);
  }
  const rebased: string[] = [];
  const moved: string[] = [];
  const uncorrected: string[] = [];
  const nodes = document.querySelectorAll(
    `[data-testid="${HEADER_STRIP_SCROLL_TEST_ID}"] [data-strip-item-id]`,
  );
  for (const node of nodes) {
    if (!(node instanceof HTMLElement)) continue;
    const id = node.getAttribute("data-strip-item-id");
    if (id === null) continue;
    const entry = byNode.get(node);
    if (entry === undefined) {
      // On screen, not participating. Never skip this quietly - that silence is
      // exactly what hid the split group.
      if (armed) uncorrected.push(id);
      continue;
    }
    const previousBaselineLeft = entry.lastBaselineLeft;
    const nextBaselineLeft = node.offsetLeft;
    entry.lastBaselineLeft = nextBaselineLeft;
    if (previousBaselineLeft === null) {
      // No snapshot to preserve a position against. Harmless on a first layout
      // pass; at a commit it means an item joined late and is reported.
      if (armed) uncorrected.push(id);
      continue;
    }
    if (previousBaselineLeft === nextBaselineLeft) continue;
    moved.push(id);
    if (!armed) continue;
    entry.value.jump(
      handoffTransformFor({
        previousBaselineLeft,
        nextBaselineLeft,
        appliedTransformX: entry.value.get(),
      }),
    );
    // `jump` cancels the in-flight animation, so the settle has to be restarted
    // explicitly or the item parks at the re-based value.
    animate(entry.value, entry.targetX, entry.transition);
    rebased.push(id);
  }
  if (armed && uncorrected.length > 0) {
    appLogger.warn(
      "[header-strip] commit reached items that cannot be re-based",
      { uncorrected },
    );
  }
  disarmHeaderStripCommitHandoff();
  return { rebased, moved, uncorrected };
}
