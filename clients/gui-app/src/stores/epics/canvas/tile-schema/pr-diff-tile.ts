/**
 * Schema for the PR diff tile. Pure ref (`isRecordBacked: false`) - the patch
 * itself is read live from the local checkout over `pr.getLocalDiff`, and the
 * range it covers is re-derived from `pr.subscribeDetail`, so only the GitHub
 * base coordinates and the collapse state persist here.
 */
import type { DesktopJsonValue } from "@/lib/windows/types";
import { prDiffTileId } from "@/lib/pr/pr-diff-tile";
import { TILE_KIND_PR_DIFF } from "../tile-kinds";
import type { PrDiffTileRef } from "../types";
import type { TileSchema } from "./index";
import { readTileInstanceId } from "./instance-id";
import { isPersistedPrNumber } from "./pr-number";
import {
  parsePrDiffTileViewState,
  serializePrDiffTileViewState,
} from "./diff-tile-view";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsePrDiffTileRef(value: unknown): PrDiffTileRef | null {
  if (!isRecord(value)) return null;
  if (
    value.type !== TILE_KIND_PR_DIFF ||
    typeof value.name !== "string" ||
    typeof value.hostId !== "string" ||
    typeof value.githubHost !== "string" ||
    typeof value.owner !== "string" ||
    typeof value.repo !== "string" ||
    !isPersistedPrNumber(value.prNumber)
  ) {
    return null;
  }
  const view = parsePrDiffTileViewState(value.view);
  if (view === null) return null;
  const githubHost = value.githubHost;
  const owner = value.owner;
  const repo = value.repo;
  const prNumber = value.prNumber;
  return {
    id: prDiffTileId({
      hostId: value.hostId,
      githubHost,
      owner,
      repo,
      prNumber,
    }),
    instanceId: readTileInstanceId(value.instanceId),
    type: TILE_KIND_PR_DIFF,
    name: value.name,
    hostId: value.hostId,
    githubHost,
    owner,
    repo,
    prNumber,
    view,
  };
}

function serializePrDiffTileRef(ref: PrDiffTileRef): DesktopJsonValue {
  return {
    id: ref.id,
    instanceId: ref.instanceId,
    type: ref.type,
    name: ref.name,
    hostId: ref.hostId,
    githubHost: ref.githubHost,
    owner: ref.owner,
    repo: ref.repo,
    prNumber: ref.prNumber,
    view: serializePrDiffTileViewState(ref.view),
  };
}

export const prDiffTileSchema: TileSchema<PrDiffTileRef> = {
  parse: parsePrDiffTileRef,
  serialize: serializePrDiffTileRef,
  isRecordBacked: false,
};
