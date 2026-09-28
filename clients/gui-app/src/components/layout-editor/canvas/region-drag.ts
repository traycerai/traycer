import {
  LAYOUT_CLUSTER_ATTRIBUTE,
  LAYOUT_MEMBER_ATTRIBUTE,
} from "@/components/layout-editor/canvas/canvas-attributes";
import {
  armLayoutDrag,
  type LayoutDragTarget,
} from "@/components/layout-editor/canvas/drag-engine";
import { writeArrangement } from "@/lib/layout/arrangement-gestures";
import {
  canvasOrderGroupOf,
  moveCanvasOrderMember,
  type CanvasOrderGroupId,
} from "@/lib/layout/layout-arrangement";
import { getLayoutSnapshot } from "@/stores/layout/layout-store";

/**
 * Dragging the real thing (L-24): the canvas half of the reorder.
 *
 * The user picks up the element they are looking at, its siblings reflow
 * around it live, and the arrangement is written once when they let go. What
 * this module owns is the translation between the two vocabularies - an
 * element and its siblings on one side, an order group and its ids on the
 * other - so `drag-engine.ts` never learns what a region is and
 * `layout-arrangement.ts` never learns what an element is.
 */

/**
 * The markers live in `canvas-attributes.ts`, a leaf with no imports, because
 * the surfaces that stamp them are app surfaces and must not pull this module's
 * graph in to read a string (R3-05). Re-exported here so the editor's own
 * callers keep one import.
 */
export { LAYOUT_CLUSTER_ATTRIBUTE, LAYOUT_MEMBER_ATTRIBUTE };

/**
 * Arm a drag on the draggable member under a press.
 *
 * The group comes off the element rather than from the member's id, because
 * the two kinds of member answer that question differently: a region's group
 * is `canvasOrderGroupForRegion`, stamped by `useLayoutRegion`, and a rail
 * divider's is stamped by the rail that draws it. By the time a press lands,
 * both are the same attribute.
 */
export function armCanvasDrag(input: {
  readonly event: PointerEvent;
  readonly node: HTMLElement;
}): void {
  const { event, node } = input;
  const group = canvasOrderGroupOf(
    node.getAttribute("data-layout-group") ?? "",
  );
  if (group === null) return;
  const resolve = (): LayoutDragTarget | null => resolveGroup(node, group);
  armLayoutDrag({
    event,
    resolve,
    onDrop: (fromIndex, toIndex) => {
      const items = resolve()?.items ?? [];
      const from = items.at(fromIndex);
      const to = items.at(toIndex);
      if (from === undefined || to === undefined) return;
      writeArrangement(
        moveCanvasOrderMember({
          arrangement: getLayoutSnapshot().arrangement,
          group,
          fromId: memberId(from),
          toId: memberId(to),
          // The engine counts up the drawn order, so a member that ended at a
          // LATER slot than it started from was dropped past the member now
          // standing there.
          placeAfter: toIndex > fromIndex,
        }),
      );
    },
  });
}

/**
 * The siblings a press can reorder against, and the box they are laid out in.
 *
 * The scope is the PRESSED member's own container - the element the surface
 * marked `data-layout-cluster` - and never an ancestor found by counting
 * members upwards (G3-01). One group is drawn in two containers whenever a
 * dock region is sized to Chip: that region stands in the composer's compact
 * strip while its full-size siblings stay in the dock, with the whole
 * transcript between them. A scope resolved by walking up would then be the
 * tile root, where the axis is inferred across that gap, the clamp is the
 * whole tile and the drawn order is not the stored order.
 *
 * So a gesture reorders what is drawn beside it and nothing else: the members
 * in the other container are simply not part of it, and the drop still places
 * by id, so the region the user had hold of is the one that moves. A container
 * holding a single member yields one item, which `armLayoutDrag` refuses -
 * there is nothing there to reorder against.
 *
 * The container is also the clamp, for every group and not only for the model
 * chip the plan singles out: no member can change which cluster it is in -
 * `normalizeArrangement` puts one back that tries - so pulling any of them
 * out has to give a quarter of the way and spring back rather than promising
 * a drop that would be undone (L-29).
 *
 * Marked rather than computed, because the DOM alone cannot tell a layout
 * container from a wrapper: the composer's toolbars put each item inside a
 * `display: contents` span, so a member's parent is not the box it is laid out
 * in, and only the surface drawing the row knows which element that is.
 */
function resolveGroup(
  node: HTMLElement,
  group: CanvasOrderGroupId,
): LayoutDragTarget | null {
  const scope = node.closest<HTMLElement>(`[${LAYOUT_CLUSTER_ATTRIBUTE}]`);
  if (scope === null) return null;
  const items = [
    ...scope.querySelectorAll<HTMLElement>(`[data-layout-group="${group}"]`),
  ];
  const index = items.indexOf(node);
  if (index < 0) return null;
  return { items, index, clamp: scope };
}

/**
 * A member's id off the element: its own where it has one, otherwise the
 * region's. Only ever used to SELECT from the stored order, never to build
 * one, so an id this build does not know selects nothing rather than narrowing
 * something away (G1-23).
 */
function memberId(node: HTMLElement): string {
  return (
    node.getAttribute(LAYOUT_MEMBER_ATTRIBUTE) ??
    node.getAttribute("data-layout-region") ??
    ""
  );
}
