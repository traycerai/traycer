import type { CustomizeSettingId } from "@/lib/customize/catalog";
import { useCustomizeStore } from "@/stores/customize/customize-store";

/**
 * The tile ids currently registered for one setting, in visual reading order.
 *
 * Reorder options never need a canonical id catalog of their own: whatever is
 * a hotspot right now (real or ghost) is already in the right order, because
 * the rendering hooks resolve `mergeOrder` before mounting. Reading the DOM
 * position off the live registry is what lets one shared helper drive drag
 * AND the Move commands for every ordered surface (status-bar segments,
 * composer toolbar clusters, dock rows, sidebar tiles).
 */
export function orderedTileIds(
  settingId: CustomizeSettingId,
  sceneId: string,
  axis: "horizontal" | "vertical",
): ReadonlyArray<string> {
  const instances = [...useCustomizeStore.getState().instances.values()].filter(
    (instance) =>
      instance.settingId === settingId && instance.sceneId === sceneId,
  );
  return instances
    .flatMap((instance) => {
      if (instance.tileId === null) return [];
      return [
        {
          tileId: instance.tileId,
          rect: instance.node.getBoundingClientRect(),
        },
      ];
    })
    .sort((left, right) =>
      axis === "horizontal"
        ? left.rect.left - right.rect.left
        : left.rect.top - right.rect.top,
    )
    .map((entry) => entry.tileId);
}

export function moveTileId(
  order: ReadonlyArray<string>,
  tileId: string,
  direction: -1 | 1,
): ReadonlyArray<string> | null {
  const index = order.indexOf(tileId);
  if (index === -1) return null;
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= order.length) return null;
  const next = [...order];
  const temp = next[targetIndex];
  next[targetIndex] = next[index];
  next[index] = temp;
  return next;
}

/** Moves `tileId` to sit immediately before `overTileId` in `order`. */
export function moveTileIdBefore(
  order: ReadonlyArray<string>,
  tileId: string,
  overTileId: string,
): ReadonlyArray<string> | null {
  if (tileId === overTileId || !order.includes(tileId)) return null;
  const withoutActive = order.filter((id) => id !== tileId);
  const overIndex = withoutActive.indexOf(overTileId);
  if (overIndex === -1) return null;
  const next = [...withoutActive];
  next.splice(overIndex, 0, tileId);
  return next;
}
