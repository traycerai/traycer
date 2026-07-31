import { v4 as uuidv4 } from "uuid";
import { TILE_KIND_PR_DETAIL } from "@/stores/epics/canvas/tile-kinds";
import type { PrDetailTileRef } from "@/stores/epics/canvas/types";

/**
 * Deterministic tile id derived from the host + PR base coordinates - mirrors
 * `gitDiffTileId`. Two "Open full view" clicks for the same PR resolve to the
 * same id, so canvas dedup is plain id equality (no separate identity check).
 */
export function prDetailTileId(args: {
  readonly hostId: string;
  readonly githubHost: string;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
}): string {
  return [
    TILE_KIND_PR_DETAIL,
    encodeURIComponent(args.hostId),
    encodeURIComponent(args.githubHost),
    encodeURIComponent(args.owner),
    encodeURIComponent(args.repo),
    String(args.prNumber),
  ].join(":");
}

export function makePrDetailTile(args: {
  readonly hostId: string;
  readonly githubHost: string;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly name: string;
}): PrDetailTileRef {
  return {
    id: prDetailTileId(args),
    instanceId: uuidv4(),
    type: TILE_KIND_PR_DETAIL,
    name: args.name,
    hostId: args.hostId,
    githubHost: args.githubHost,
    owner: args.owner,
    repo: args.repo,
    prNumber: args.prNumber,
  };
}
