/**
 * Ticket 21 slice 3: the one shared resolver design-review finding 4 asks
 * for, mapping pane/instance ownership across the hosted DOM identity
 * (`hosted-tile-dom.ts`) instead of physical pane ancestry.
 *
 * Models the two lookup shapes the four broken call sites need once slice 4
 * wires them in:
 *
 * - forward, instanceId -> element (command-to-composer focus, route focus:
 *   "find `[data-group-id]`, then query its selected-tab descendant" becomes
 *   `findHostedTileElement` then the caller's own descendant query);
 * - reverse, event target -> owning instance/pane (chat keyboard scrolling's
 *   "walk to `[data-group-id]`", deferred pane-activation's
 *   `paneRoot.contains(target)` becomes `resolveHostedTileOwnership` /
 *   `isTargetInsideHostedTile`).
 */
import {
  HOSTED_TILE_INSTANCE_ID_ATTRIBUTE,
  HOSTED_TILE_PANE_ID_ATTRIBUTE,
  HOSTED_TILE_RECORD_SELECTOR,
  HOSTED_TILE_VIEW_TAB_ID_ATTRIBUTE,
  type HostedTileOwnership,
} from "@/components/epic-canvas/surface-host/hosted-tile-dom";

/**
 * Direct instanceId -> record element lookup, scoped to `root` (the plane,
 * or any ancestor of it) so a caller never accidentally resolves a record
 * belonging to an unrelated host in a test fixture with multiple planes.
 */
export function findHostedTileElement(
  root: ParentNode,
  instanceId: string,
): HTMLElement | null {
  return root.querySelector<HTMLElement>(
    `[${HOSTED_TILE_INSTANCE_ID_ATTRIBUTE}="${cssEscapeAttributeValue(instanceId)}"]`,
  );
}

/**
 * Walks up from `target` to the nearest hosted-record ancestor and returns
 * its identity, or `null` if `target` is not inside any hosted record.
 * Mirrors the existing `[data-group-id]`-closest idiom for physical panes,
 * applied to the hosted plane's own identity attributes instead.
 */
export function resolveHostedTileOwnership(
  target: Element | null,
): HostedTileOwnership | null {
  if (target === null) return null;
  const record = target.closest<HTMLElement>(HOSTED_TILE_RECORD_SELECTOR);
  if (record === null) return null;
  const instanceId = record.getAttribute(HOSTED_TILE_INSTANCE_ID_ATTRIBUTE);
  const paneId = record.getAttribute(HOSTED_TILE_PANE_ID_ATTRIBUTE);
  const viewTabId = record.getAttribute(HOSTED_TILE_VIEW_TAB_ID_ATTRIBUTE);
  if (instanceId === null || paneId === null || viewTabId === null) {
    return null;
  }
  return { instanceId, paneId, viewTabId };
}

/**
 * Convenience wrapper for the deferred-activation containment shape
 * (`paneRoot.contains(target)`, generalized to a hosted record): true only
 * when `target` is inside the SPECIFIC instance's record, not merely inside
 * some hosted record.
 */
export function isTargetInsideHostedTile(
  instanceId: string,
  target: EventTarget | null,
): boolean {
  if (!(target instanceof Element)) return false;
  const ownership = resolveHostedTileOwnership(target);
  return ownership !== null && ownership.instanceId === instanceId;
}

/**
 * `CSS.escape` is not implemented in every target runtime this app ships
 * against; instanceIds are opaque store-generated ids, never user-authored
 * text, so escaping only the two characters that would break a `querySelector`
 * attribute-value string (`"` and `\`) is sufficient and avoids a polyfill.
 */
function cssEscapeAttributeValue(value: string): string {
  return value.replace(/[\\"]/g, (char) => `\\${char}`);
}
