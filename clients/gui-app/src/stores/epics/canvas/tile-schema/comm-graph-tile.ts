/**
 * Schema + factory for the `comm-graph` tile (the per-epic communication
 * graph).
 *
 * Follows the `git-diff` precedent: non-record-backed, and `parse` RECOMPUTES
 * the tile `id` from the persisted payload (`commGraphTileId(epicId)`) instead
 * of trusting the stored value, so dedup is self-healing with no migration
 * step. The identity is the EPIC - one graph per epic - which is also why the
 * ref carries no host binding: the tile fans one subscription out per host the
 * epic's agents live on, so `hostId` is the inert placeholder the blank tile
 * uses and the tile body never reads a per-tab host.
 */
import { v4 as uuidv4 } from "uuid";
import type { DesktopJsonValue } from "@/lib/windows/types";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { TILE_KIND_COMM_GRAPH } from "../tile-kinds";
import type { CommGraphTileRef, CommGraphTileViewState } from "../types";
import type { TileSchema } from "./index";
import { readTileInstanceId } from "./instance-id";

export const COMM_GRAPH_TILE_NAME = "Communication graph";

/** Neutral starting viewport; the canvas fits the graph on first layout. */
export const DEFAULT_COMM_GRAPH_VIEW: CommGraphTileViewState = {
  x: 0,
  y: 0,
  zoom: 1,
};

export function commGraphTileId(epicId: string): string {
  return `comm-graph:${epicId}`;
}

export function makeCommGraphTileRef(epicId: string): CommGraphTileRef {
  return {
    id: commGraphTileId(epicId),
    instanceId: uuidv4(),
    type: TILE_KIND_COMM_GRAPH,
    name: COMM_GRAPH_TILE_NAME,
    hostId: UNKNOWN_HOST_PLACEHOLDER,
    epicId,
    view: DEFAULT_COMM_GRAPH_VIEW,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function parseCommGraphTileViewState(
  value: unknown,
): CommGraphTileViewState {
  if (!isRecord(value)) return DEFAULT_COMM_GRAPH_VIEW;
  const zoom = readFiniteNumber(value.zoom, DEFAULT_COMM_GRAPH_VIEW.zoom);
  return {
    x: readFiniteNumber(value.x, DEFAULT_COMM_GRAPH_VIEW.x),
    y: readFiniteNumber(value.y, DEFAULT_COMM_GRAPH_VIEW.y),
    // A persisted zoom of 0 (or negative) would render an invisible canvas the
    // user cannot recover from, so it degrades to the default rather than
    // failing the whole tile.
    zoom: zoom > 0 ? zoom : DEFAULT_COMM_GRAPH_VIEW.zoom,
  };
}

function parseCommGraphTileRef(value: unknown): CommGraphTileRef | null {
  if (!isRecord(value)) return null;
  if (value.type !== TILE_KIND_COMM_GRAPH) return null;
  if (typeof value.epicId !== "string" || value.epicId.length === 0) {
    return null;
  }
  return {
    id: commGraphTileId(value.epicId),
    instanceId: readTileInstanceId(value.instanceId),
    type: TILE_KIND_COMM_GRAPH,
    name: typeof value.name === "string" ? value.name : COMM_GRAPH_TILE_NAME,
    hostId:
      typeof value.hostId === "string" && value.hostId.length > 0
        ? value.hostId
        : UNKNOWN_HOST_PLACEHOLDER,
    epicId: value.epicId,
    view: parseCommGraphTileViewState(value.view),
  };
}

function serializeCommGraphTileRef(ref: CommGraphTileRef): DesktopJsonValue {
  return {
    id: ref.id,
    instanceId: ref.instanceId,
    type: ref.type,
    name: ref.name,
    hostId: ref.hostId,
    epicId: ref.epicId,
    view: { x: ref.view.x, y: ref.view.y, zoom: ref.view.zoom },
  };
}

export const commGraphTileSchema: TileSchema<CommGraphTileRef> = {
  parse: parseCommGraphTileRef,
  serialize: serializeCommGraphTileRef,
  isRecordBacked: false,
};
