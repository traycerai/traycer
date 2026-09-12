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
import type { OfficeViewId } from "@/lib/comm-graph/office/office-types";
import { OFFICE_VIEW_IDS } from "@/lib/comm-graph/office/office-view-vocabulary";
import { TILE_KIND_COMM_GRAPH } from "../tile-kinds";
import type {
  CommGraphTileCamera,
  CommGraphTileRef,
  CommGraphTileViewState,
  OfficeViewChoice,
} from "../types";
import type { TileSchema } from "./index";
import { readTileInstanceId } from "./instance-id";

export const COMM_GRAPH_TILE_NAME = "Agent office";

/**
 * Neutral starting viewport; the canvas fits the graph on first layout.
 *
 * `mode` defaults to the office floor - it is the readable rendering of the
 * same projection, and the node graph stays one click away.
 */
export const DEFAULT_COMM_GRAPH_VIEW: CommGraphTileViewState = {
  x: 0,
  y: 0,
  zoom: 1,
  mode: "office",
  // NOT a view id. A tile nobody has chosen a view for follows the Settings
  // default, and writing one here would freeze the default at creation time
  // for every tile ever opened.
  officeView: null,
  officeAutoView: null,
  officeCameraView: null,
  // Nobody has framed the office. The tile projects this into the three fields
  // above before building the office canvas, and `null` is what that canvas
  // reads as "fit yourself" - so a fresh tile auto-fits, exactly as before D68
  // gave the office a camera of its own.
  officeCamera: null,
};

/**
 * Whether this tile has never been framed by the user, so the renderer should
 * derive its own first viewport.
 *
 * `mode` is deliberately NOT compared: it is a rendering choice, not a framing.
 * Folding it in would mean a tile that was only ever toggled to the office and
 * back reads as user-framed at the schema default, and would then open at
 * (0, 0) zoom 1 instead of fitting. `officeView` and `officeAutoView` are out
 * for the same reason and a stronger one: picking a view RESETS the camera to
 * this very default, so a tile that reads as user-framed the moment a view is
 * chosen would open every switched-to view at (0, 0) zoom 1 and never fit one
 * again.
 *
 * `officeCamera` is out too, and for a third reason: this asks about the
 * camera the CALLER holds, and both callers hold one of the three fields
 * below. The graph reads them straight; the office reads the projection the
 * tile builds from `officeCamera`, where a `null` office camera has already
 * become this very default. Folding the field in would answer the office's
 * question with the graph's framing.
 *
 * Lives beside the default it compares against, and not in either renderer:
 * both ask the same question of the same schema value.
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

/**
 * What a PERSISTED tile falls back to when its view is unreadable.
 *
 * The mode deliberately differs from {@link DEFAULT_COMM_GRAPH_VIEW}: a tile
 * saved before the office existed rendered the node graph, so reopening it on
 * the floor would change what a person already had open. Only a tile created
 * NOW starts on the floor.
 */
const PERSISTED_COMM_GRAPH_VIEW: CommGraphTileViewState = {
  ...DEFAULT_COMM_GRAPH_VIEW,
  mode: "graph",
};

/**
 * Anything that is not the literal `"office"` reads as the node graph. That
 * covers a tile persisted before the mode existed - which rendered the graph,
 * and must keep rendering it - as well as a value from a future build, which
 * degrades to the rendering that has always existed rather than to a blank
 * canvas.
 */
function readCommGraphViewMode(value: unknown): CommGraphTileViewState["mode"] {
  return value === "office" ? "office" : "graph";
}

/**
 * A persisted view id this build can actually draw, else `null`.
 *
 * The registry is the vocabulary, exactly as it is for the picker and the
 * tile: a value from a build that ships more views than this one degrades
 * rather than naming a view nothing can plan.
 */
function readOfficeViewId(value: unknown): OfficeViewId | null {
  if (typeof value !== "string") return null;
  return OFFICE_VIEW_IDS.find((id) => id === value) ?? null;
}

function readOfficeViewChoice(value: unknown): OfficeViewChoice | null {
  if (value === "auto") return "auto";
  return readOfficeViewId(value);
}

/**
 * Whether a field was a real choice this build cannot honour.
 *
 * An absent field and a persisted `null` are the SAME thing - never chosen -
 * and neither is a degrade: a tile saved before views existed keeps the
 * framing its owner gave it. A value that is present and unreadable is one a
 * newer build wrote, and the camera saved beside it frames a view this one
 * cannot draw.
 */
function degradesFrom(persisted: unknown, read: string | null): boolean {
  return persisted !== undefined && persisted !== null && read === null;
}

/**
 * The office's own camera as persisted, or `null` for anything unusable.
 *
 * Stricter than the three loose fields beside it, which fall back per number:
 * this one is all-or-nothing, because a HALF-read office camera is worse than
 * none. `null` means "nobody framed the office" and auto-fits; a camera with
 * one salvaged coordinate frames somewhere nobody asked for and counts as
 * user-framed while doing it. A zoom of zero or less is refused for the same
 * reason the shared zoom is: it renders a canvas nothing can recover from.
 */
function readOfficeCamera(value: unknown): CommGraphTileCamera | null {
  if (!isRecord(value)) return null;
  const { x, y, zoom } = value;
  if (typeof x !== "number" || !Number.isFinite(x)) return null;
  if (typeof y !== "number" || !Number.isFinite(y)) return null;
  if (typeof zoom !== "number" || !Number.isFinite(zoom)) return null;
  if (zoom <= 0) return null;
  return { x, y, zoom };
}

/** Whether a camera is the one every renderer reads as "fit yourself". */
function isNeutralCamera(camera: CommGraphTileCamera): boolean {
  return (
    camera.x === DEFAULT_COMM_GRAPH_VIEW.x &&
    camera.y === DEFAULT_COMM_GRAPH_VIEW.y &&
    camera.zoom === DEFAULT_COMM_GRAPH_VIEW.zoom
  );
}

export function parseCommGraphTileViewState(
  value: unknown,
): CommGraphTileViewState {
  if (!isRecord(value)) return PERSISTED_COMM_GRAPH_VIEW;
  const zoom = readFiniteNumber(value.zoom, PERSISTED_COMM_GRAPH_VIEW.zoom);
  const officeView = readOfficeViewChoice(value.officeView);
  const officeAutoView = readOfficeViewId(value.officeAutoView);
  const officeCameraView = readOfficeViewId(value.officeCameraView);
  // The camera means "this much of THAT view". Once the view it was saved
  // against has degraded away, the numbers point into a floor plan that is not
  // coming back - and keeping them would reopen the fallback view scrolled off
  // into empty space with no sign of why.
  const stale =
    degradesFrom(value.officeView, officeView) ||
    degradesFrom(value.officeAutoView, officeAutoView) ||
    // The most direct case of the rule above: the camera names the view it
    // frames, and that view is one this build cannot draw.
    degradesFrom(value.officeCameraView, officeCameraView);
  const mode = readCommGraphViewMode(value.mode);
  const camera: CommGraphTileCamera = {
    x: stale
      ? DEFAULT_COMM_GRAPH_VIEW.x
      : readFiniteNumber(value.x, PERSISTED_COMM_GRAPH_VIEW.x),
    y: stale
      ? DEFAULT_COMM_GRAPH_VIEW.y
      : readFiniteNumber(value.y, PERSISTED_COMM_GRAPH_VIEW.y),
    // A persisted zoom of 0 (or negative) would render an invisible canvas the
    // user cannot recover from, so it degrades to the default rather than
    // failing the whole tile.
    zoom: stale || zoom <= 0 ? DEFAULT_COMM_GRAPH_VIEW.zoom : zoom,
  };
  /**
   * D68's MIGRATION: before the split there was one camera, and in `office`
   * mode it was the office's. A record saved then carries sprite pixels in
   * the three shared fields and no `officeCamera` at all, so the numbers are
   * handed to the field that now owns them.
   *
   * ABSENT is the trigger, not falsy: a persisted `null` is a real answer -
   * a build that has this field saying nobody framed the office - and
   * re-migrating it on every load would resurrect a camera the user's own
   * view pick neutralised. `graph` mode is not migrated because there the
   * numbers were always the graph's, and neither is a neutral camera, which
   * says nothing to carry.
   */
  const migrates =
    value.officeCamera === undefined &&
    mode === "office" &&
    !isNeutralCamera(camera);
  const officeCamera = migrates ? camera : readOfficeCamera(value.officeCamera);
  return {
    // The GRAPH's camera now. A migrated record's numbers went to the office
    // just above, and sprite pixels read as flow units would open the graph
    // off-screen the first time somebody switched to it - the same units
    // mismatch D68 exists to end, pointed the other way.
    x: migrates ? DEFAULT_COMM_GRAPH_VIEW.x : camera.x,
    y: migrates ? DEFAULT_COMM_GRAPH_VIEW.y : camera.y,
    zoom: migrates ? DEFAULT_COMM_GRAPH_VIEW.zoom : camera.zoom,
    mode,
    officeView,
    officeAutoView,
    // A degraded camera frames nothing, so it claims nothing either.
    officeCameraView: stale ? null : officeCameraView,
    // Same rule, same reason: a camera about a view this build cannot draw
    // points into empty space whichever field holds it.
    officeCamera: stale ? null : officeCamera,
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
      officeView: ref.view.officeView,
      officeAutoView: ref.view.officeAutoView,
      officeCameraView: ref.view.officeCameraView,
      // Written field by field rather than handed over whole: the stored
      // shape is the wire format, and a spread would carry anything a future
      // `CommGraphTileCamera` gained into persistence unreviewed.
      officeCamera:
        ref.view.officeCamera === null
          ? null
          : {
              x: ref.view.officeCamera.x,
              y: ref.view.officeCamera.y,
              zoom: ref.view.officeCamera.zoom,
            },
    },
  };
}

export const commGraphTileSchema: TileSchema<CommGraphTileRef> = {
  parse: parseCommGraphTileRef,
  serialize: serializeCommGraphTileRef,
  isRecordBacked: false,
};
