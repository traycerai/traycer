/**
 * Schema for the PR full-view tile. Pure ref (`isRecordBacked: false`) - the
 * heavy PR fact lives on the host and is fetched live over
 * `pr.subscribeDetail`; only the GitHub base coordinates persist here.
 */
import type { DesktopJsonValue } from "@/lib/windows/types";
import { prDetailTileId } from "@/lib/pr/pr-detail-tile";
import { TILE_KIND_PR_DETAIL } from "../tile-kinds";
import type { PrDetailTileRef } from "../types";
import type { TileSchema } from "./index";
import { readTileInstanceId } from "./instance-id";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsePrDetailTileRef(value: unknown): PrDetailTileRef | null {
  if (!isRecord(value)) return null;
  if (
    value.type !== TILE_KIND_PR_DETAIL ||
    typeof value.name !== "string" ||
    typeof value.hostId !== "string" ||
    typeof value.githubHost !== "string" ||
    typeof value.owner !== "string" ||
    typeof value.repo !== "string" ||
    typeof value.prNumber !== "number"
  ) {
    return null;
  }
  const githubHost = value.githubHost;
  const owner = value.owner;
  const repo = value.repo;
  const prNumber = value.prNumber;
  return {
    id: prDetailTileId({
      hostId: value.hostId,
      githubHost,
      owner,
      repo,
      prNumber,
    }),
    instanceId: readTileInstanceId(value.instanceId),
    type: TILE_KIND_PR_DETAIL,
    name: value.name,
    hostId: value.hostId,
    githubHost,
    owner,
    repo,
    prNumber,
  };
}

function serializePrDetailTileRef(ref: PrDetailTileRef): DesktopJsonValue {
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
  };
}

export const prDetailTileSchema: TileSchema<PrDetailTileRef> = {
  parse: parsePrDetailTileRef,
  serialize: serializePrDetailTileRef,
  isRecordBacked: false,
};
