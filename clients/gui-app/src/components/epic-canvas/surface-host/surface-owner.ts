/**
 * Ticket 21 slice 4: the single centralized discriminator deciding whether a
 * pane's active tab renders through `StableTileSurfaceHost` (a `TileSurfaceSlot`
 * geometry anchor, real body painted elsewhere) or inline (`ActiveTabBody`'s
 * existing `EpicNodeTile` path), per the design's "chat-first migration with
 * one temporary ownership discriminator."
 *
 * Chat-only for this slice: pinned terminals and non-chat LRU surfaces stay
 * inline until a later, separately justified cut. A remote-deleted chat also
 * stays inline - `ActiveTabBody` already renders `DeletedArtifactBody` for it,
 * and hosting a chat that's about to disappear would need the hosted body to
 * duplicate that deletion detection for no behavioral gain.
 *
 * `isHostedSurfaceEligible` is the shared candidate rule extracted so
 * `tile-surface-membership.ts`'s canvas-wide membership derivation and this
 * module's render-routing decision are structurally incapable of disagreeing
 * (design-review slice-4 finding 2: they used to drift on remote-deletion,
 * producing two simultaneous owners for the same instance). `surfaceOwnerFor`
 * layers the switch check on top - membership itself is switch-independent
 * by design (see `stable-tile-surface-host-switch.ts`: "membership and the
 * environment registry are always live; only the host's own mount is gated").
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
