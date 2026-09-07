/** Schema + factory for the `comm-graph` tile (the per-epic communication graph). */
import { v4 as uuidv4 } from "uuid";
import type { DesktopJsonValue } from "@/lib/windows/types";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { TILE_KIND_COMM_GRAPH } from "../tile-kinds";
import type { CommGraphTileRef, CommGraphTileViewState } from "../types";
import type { TileSchema } from "./index";
import { readTileInstanceId } from "./instance-id";

export const COMM_GRAPH_TILE_NAME = "Agent office";

/** Neutral starting viewport; the canvas fits the graph on first layout. */
export const DEFAULT_COMM_GRAPH_VIEW: CommGraphTileViewState = {
  x: 0,
  y: 0,
  zoom: 1,
  mode: "office",
};

/**
 * Whether this tile has never been framed by the user, so the renderer should derive its own first
 * viewport. `mode` is deliberately NOT compared: it is a rendering choice, not a framing.
 */
export function isDefaultCommGraphView(view: CommGraphTileViewState): boolean {
  return (
    view.x === DEFAULT_COMM_GRAPH_VIEW.x &&
    view.y === DEFAULT_COMM_GRAPH_VIEW.y &&
    view.zoom === DEFAULT_COMM_GRAPH_VIEW.zoom
  );
}

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

/** What a PERSISTED tile falls back to when its view is unreadable. */
const PERSISTED_COMM_GRAPH_VIEW: CommGraphTileViewState = {
  ...DEFAULT_COMM_GRAPH_VIEW,
  mode: "graph",
};

/** Anything that is not the literal `"office"` reads as the node graph. */
function readCommGraphViewMode(value: unknown): CommGraphTileViewState["mode"] {
  return value === "office" ? "office" : "graph";
}

export function parseCommGraphTileViewState(
  value: unknown,
): CommGraphTileViewState {
  if (!isRecord(value)) return PERSISTED_COMM_GRAPH_VIEW;
  const zoom = readFiniteNumber(value.zoom, PERSISTED_COMM_GRAPH_VIEW.zoom);
  return {
    x: readFiniteNumber(value.x, PERSISTED_COMM_GRAPH_VIEW.x),
    y: readFiniteNumber(value.y, PERSISTED_COMM_GRAPH_VIEW.y),
    // A persisted zoom of 0 (or negative) would render an invisible canvas the user cannot recover
    // from, so it degrades to the default rather than failing the whole tile.
    zoom: zoom > 0 ? zoom : PERSISTED_COMM_GRAPH_VIEW.zoom,
    mode: readCommGraphViewMode(value.mode),
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
    // Rename previously saved tiles on load: match on tile kind, not on the
    // persisted name, so a comm-graph tile saved under the old "Communication
    // graph" copy picks up the current name unconditionally.
    name: COMM_GRAPH_TILE_NAME,
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
    view: {
      x: ref.view.x,
      y: ref.view.y,
      zoom: ref.view.zoom,
      mode: ref.view.mode,
    },
  };
}

export const commGraphTileSchema: TileSchema<CommGraphTileRef> = {
  parse: parseCommGraphTileRef,
  serialize: serializeCommGraphTileRef,
  isRecordBacked: false,
};
