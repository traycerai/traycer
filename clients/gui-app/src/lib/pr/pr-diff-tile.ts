import { v4 as uuidv4 } from "uuid";
import { createPrDiffTileViewState } from "@/lib/diff/diff-tile-view-state";
import { TILE_KIND_PR_DIFF } from "@/stores/epics/canvas/tile-kinds";
import type { PrDiffTileRef } from "@/stores/epics/canvas/types";

/**
 * Deterministic tile id derived from the host + PR base coordinates - the same
 * construction as {@link prDetailTileId}, under a different kind prefix, so a
 * PR's detail tile and its diff tile are two distinct tiles that each dedupe
 * against themselves. Opening the diff twice reuses one tile; opening the diff
 * never replaces the detail view it was opened from.
 */
export function prDiffTileId(args: {
  readonly hostId: string;
  readonly githubHost: string;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
}): string {
  return [
    TILE_KIND_PR_DIFF,
    encodeURIComponent(args.hostId),
    encodeURIComponent(args.githubHost),
    encodeURIComponent(args.owner),
    encodeURIComponent(args.repo),
    String(args.prNumber),
  ].join(":");
}

/** Tab title for a PR diff tile: `owner/repo#42 · Diff`. */
export function prDiffTileName(args: {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
}): string {
  return `${args.owner}/${args.repo}#${args.prNumber} · Diff`;
}

export function makePrDiffTile(args: {
  readonly hostId: string;
  readonly githubHost: string;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
}): PrDiffTileRef {
  return {
    id: prDiffTileId(args),
    instanceId: uuidv4(),
    type: TILE_KIND_PR_DIFF,
    name: prDiffTileName(args),
    hostId: args.hostId,
    githubHost: args.githubHost,
    owner: args.owner,
    repo: args.repo,
    prNumber: args.prNumber,
    view: createPrDiffTileViewState(),
  };
}
