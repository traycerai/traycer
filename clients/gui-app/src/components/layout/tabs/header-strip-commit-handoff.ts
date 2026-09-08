import { animate, type MotionValue, type Transition } from "motion/react";
import { appLogger } from "@/lib/logger";
import { HEADER_STRIP_SCROLL_TEST_ID } from "./header-strip-geometry";

/**
 * Rendered-position continuity across the drop commit.
 *
 * THE DEFECT THIS EXISTS FOR. A header tab's rendered position is two terms:
 * its layout slot plus the displacement transform the drag model springs. At
 * the commit those terms change on the SAME frame and in OPPOSITE directions -
 * the DOM reorder moves the slot instantly, while the spring keeps decaying the
 * transform it was already running. The offset is expressed against a baseline
 * that just moved, so the composite lands somewhere neither term intended:
 *
 *   before   slot 613.75 + transform -400.45  =  rendered  213.30  (settled)
 *   commit   slot 213.30 + transform -351.50  =  rendered -138.20  (off-strip)
 *
 * A 351px jump in one frame, then a spring back. Nothing keyed on the TRANSFORM
 * can see it: the transform trace shows an ordinary decay to zero either way.
 * Only rendered position - the quantity the eye tracks - separates the two.
 *
 * THE RULE. At the commit, every item whose baseline moved jumps its transform
 * to whatever preserves its rendered position, then springs to its target. One
 * rule covers both gestures:
 *
 *   commit  the slot moves, so the jump absorbs the move and the tab does not
 *           visibly travel - it was already where it belongs.
 *   cancel  the slot does NOT move, so there is nothing to re-base and the
 *           spring-back is untouched.
 *
 * WHY THIS IS A REGISTRY AND NOT A PER-ITEM EFFECT. It was a per-item effect
 * first, and that reached exactly ONE tab per commit: `TabItem` is memoized, so
 * an item whose props did not change never re-rendered, never ran its effect,
 * and never re-based - while its baseline moved anyway. Whether an item is
 * corrected has to depend on whether its BASELINE MOVED, never on whether React
 * happened to re-render it. So the pass is driven from the strip container's
 * layout boundary, which runs after every child's, and it walks every
 * registered item rather than relying on each to correct itself.
 *
 * That is also why nothing here tests opacity or drag direction. The hidden
 * dragged tab is corrected on the same terms as a visible neighbour; a
 * direction is just a sign; unequal widths are just different deltas. A branch
 * on any of those would be a check whose outcome differs across cases that are
 * the same case.
 *
 * Baselines are measured with `offsetLeft`, never `getBoundingClientRect()`.
 * `offsetLeft` excludes transforms by definition, so it reads the slot without
 * having to subtract the very transform being corrected, and it is immune to a
 * scroll landing on the same frame.
 */

/**
 * One strip item's participation in the pass.
 *
 * `targetX` and `transition` are re-published by the item on every layout pass
 * so the re-base can restart the spring toward the CURRENT target: `jump`
 * cancels the animation in flight, so a jump without a restart would park the
 * item at the re-based value instead of settling it.
 */
interface HeaderStripItemEntry {
  readonly value: MotionValue<number>;
  node: HTMLElement | null;
  targetX: number;
  transition: Transition;
  lastBaselineLeft: number | null;
}

/**
 * Keyed by the item's MotionValue, which is stable for the life of the item -
 * NOT by its DOM node, which is not. Keying by node captured once at mount left
 * a recreated element stranded under a detached key, where `offsetLeft` reads 0
 * forever and the item is silently exempt from every commit.
 *
 * The mutable bookkeeping lives here rather than on an object the component
 * owns: a component cannot hold a mutable handle without either reading a ref
 * during render or mutating state, both of which the hook rules forbid.
 */
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

/**
 * Re-publish an item's element and settle target.
 *
 * Called on EVERY render, because both can change: React can recreate the
 * element, and `jump` cancels the animation in flight so the re-base has to
 * restart one toward the CURRENT target.
 */
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

/**
 * Whether a strip commit is mid-flight.
 *
 * The correction is armed by the commit rather than run on every render: a
 * baseline can move for reasons that are not a drop (a tab closes, the window
 * resizes) and those keep their existing behaviour.
 */
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

/**
 * The transform that leaves rendered position unchanged across a baseline move.
 *
 * `previousBaselineLeft + appliedTransformX` is where the item is rendered right
 * now; subtracting the new baseline gives the transform that reproduces that
 * exact position from the new slot.
 */
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

/**
 * What one commit pass did, and - more importantly - what it could not do.
 *
 * `uncorrected` is the audit. A strip item that is in the DOM but not in the
 * registry cannot be re-based, and the first version of this mechanism let that
 * pass in silence: `SplitTabItem` renders its own frame and had not been
 * migrated, so a split group - the widest item in the strip - was exempt from
 * every commit in every direction while the tabs around it were corrected.
 * Reporting it is what turns that from an invisible visual defect into a
 * failing assertion.
 */
export interface HeaderStripHandoffReport {
  readonly rebased: readonly string[];
  readonly moved: readonly string[];
  readonly uncorrected: readonly string[];
}

/**
 * Re-base every item whose baseline moved, then release the arm.
 *
 * Driven from the strip container's layout effect on EVERY strip layout pass:
 * baselines have to be recorded even when nothing is armed, or the first commit
 * after a quiet render would compare against a stale slot. Walking the DOM
 * rather than the registry is deliberate - it is the only way to notice an item
 * that is on screen and NOT registered.
 */
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
