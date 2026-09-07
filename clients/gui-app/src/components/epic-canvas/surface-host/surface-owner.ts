/**
 * `surfaceOwnerFor` layers the switch check on top - membership itself is switch-independent by design (see `stable-tile-surface-host-switch.ts`: "membership and the environment registry are always live; only the host's own mount is gated").
 */
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import { STABLE_TILE_SURFACE_HOST_ENABLED } from "@/components/epic-canvas/surface-host/stable-tile-surface-host-switch";

export type TileSurfaceOwner = "hosted" | "inline";

export function isHostedSurfaceEligible(args: {
  readonly node: EpicCanvasTileRef;
  readonly isRemoteDeleted: boolean;
}): boolean {
  if (args.isRemoteDeleted) return false;
  if (args.node.type !== "chat") return false;
  return true;
}

export function surfaceOwnerFor(args: {
  readonly node: EpicCanvasTileRef;
  readonly isRemoteDeleted: boolean;
}): TileSurfaceOwner {
  if (!STABLE_TILE_SURFACE_HOST_ENABLED) return "inline";
  return isHostedSurfaceEligible(args) ? "hosted" : "inline";
}
