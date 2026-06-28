/**
 * Canvas (de)serialization for the current N-ary shape.
 *
 * One persisted shape flows through here (via `parseEpicCanvasState`, the
 * single parse entry point for BOTH the zustand persist path and the desktop
 * per-window projection path):
 *
 * **N-ary shape**: `{kind:"pane", tabInstanceIds}` leaves under
 * `{kind:"group", direction, children}` containers, with `activePaneId`,
 * `tilesByInstanceId`, and `sizesByGroupId` at the state level.
 *
 * Parsing is total (never throws): any salvageable subtree is preserved.
 * Per-tab drop rules: an unparsable tab is dropped without evicting its
 * siblings; a pane whose every tab failed is collapsed into its sibling.
 */
import { v4 as uuidv4 } from "uuid";
import type { DesktopJsonValue } from "@/lib/windows/types";
import type { EpicCanvasState, EpicCanvasTileRef } from "./types";
import type {
  SizesByGroupId,
  SplitDirection,
  TileGroup,
  TileLayoutNode,
  TilePane,
} from "./tile-tree";
import { normalizeSizes } from "./tile-tree";
import { createEmptyCanvas, reconcileCanvasInvariants } from "./canvas-state";
import { parseTileRef, serializeTileRef } from "./tile-schema";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface ParseContext {
  /** Tile payloads by instanceId, seeded from the state-level `tilesByInstanceId`. */
  readonly tiles: Record<string, EpicCanvasTileRef>;
  /** Group sizes, seeded from the state-level `sizesByGroupId`. */
  readonly sizes: Record<string, ReadonlyArray<number>>;
}

// ---------------------------------------------------------------------------
// Current N-ary nodes
// ---------------------------------------------------------------------------

function parsePane(
  value: Record<string, unknown>,
  ctx: ParseContext,
): TilePane | null {
  if (typeof value.id !== "string") return null;
  const raw = value.tabInstanceIds;
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const tabInstanceIds = raw.flatMap((entry) => {
    if (typeof entry !== "string") return [];
    if (seen.has(entry)) return [];
    if (!Object.hasOwn(ctx.tiles, entry)) return [];
    seen.add(entry);
    return [entry];
  });
  // A pane that listed tabs but resolved none is unrecoverable; an
  // explicitly-empty pane (drop zone) stays valid.
  if (raw.length > 0 && tabInstanceIds.length === 0) return null;
  const activeTabId =
    typeof value.activeTabId === "string" && seen.has(value.activeTabId)
      ? value.activeTabId
      : firstTabId(tabInstanceIds);
  const previewTabId =
    typeof value.previewTabId === "string" && seen.has(value.previewTabId)
      ? value.previewTabId
      : null;
  const activationHistory = parsePaneActivationHistory(
    value.activationHistory,
    seen,
    activeTabId,
  );
  return {
    kind: "pane",
    id: value.id,
    tabInstanceIds,
    activeTabId,
    previewTabId,
    activationHistory,
  };
}

function firstTabId(tabInstanceIds: ReadonlyArray<string>): string | null {
  if (tabInstanceIds.length === 0) return null;
  return tabInstanceIds[0];
}

function seedActivationHistory(
  activeTabId: string | null,
): ReadonlyArray<string> {
  return activeTabId === null ? [] : [activeTabId];
}

function parsePaneActivationHistory(
  value: unknown,
  liveTabIds: ReadonlySet<string>,
  activeTabId: string | null,
): ReadonlyArray<string> {
  if (!Array.isArray(value)) return seedActivationHistory(activeTabId);
  const parsed = parseActivationHistory(value, liveTabIds);
  if (parsed.length > 0 || value.length === 0) return parsed;
  return seedActivationHistory(activeTabId);
}

function parseActivationHistory(
  value: ReadonlyArray<unknown>,
  liveTabIds: ReadonlySet<string>,
): ReadonlyArray<string> {
  const seen = new Set<string>();
  return value.flatMap((entry) => {
    if (typeof entry !== "string") return [];
    if (!liveTabIds.has(entry)) return [];
    if (seen.has(entry)) return [];
    seen.add(entry);
    return [entry];
  });
}

function parseGroup(
  value: Record<string, unknown>,
  ctx: ParseContext,
): TileLayoutNode | null {
  if (!Array.isArray(value.children)) return null;
  const children = value.children.flatMap((child) => {
    const node = parseCurrentTileNode(child, ctx);
    return node === null ? [] : [node];
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  const direction: SplitDirection =
    value.direction === "horizontal" || value.direction === "vertical"
      ? value.direction
      : "horizontal";
  const id = typeof value.id === "string" ? value.id : uuidv4();
  const group: TileGroup = { kind: "group", id, direction, children };
  return group;
}

/** Parse a current-schema N-ary node (`pane` or `group`). */
function parseCurrentTileNode(
  value: unknown,
  ctx: ParseContext,
): TileLayoutNode | null {
  if (!isRecord(value)) return null;
  if (value.kind === "pane") return parsePane(value, ctx);
  if (value.kind === "group") return parseGroup(value, ctx);
  return null;
}

// ---------------------------------------------------------------------------
// State level
// ---------------------------------------------------------------------------

function parsePersistedTiles(
  value: unknown,
): Record<string, EpicCanvasTileRef> {
  const out: Record<string, EpicCanvasTileRef> = {};
  if (!isRecord(value)) return out;
  for (const [instanceId, raw] of Object.entries(value)) {
    const ref = parseTileRef(raw);
    if (ref === null) continue;
    if (ref.instanceId !== instanceId) continue;
    out[instanceId] = ref;
  }
  return out;
}

function parsePersistedSizes(
  value: unknown,
): Record<string, ReadonlyArray<number>> {
  const out: Record<string, ReadonlyArray<number>> = {};
  if (!isRecord(value)) return out;
  for (const [groupId, raw] of Object.entries(value)) {
    if (!Array.isArray(raw) || raw.length === 0) continue;
    if (
      !raw.every(
        (entry) =>
          typeof entry === "number" && Number.isFinite(entry) && entry > 0,
      )
    ) {
      continue;
    }
    out[groupId] = normalizeSizes(raw, raw.length);
  }
  return out;
}

/**
 * Parse a persisted canvas (current N-ary shape) into `EpicCanvasState`.
 * Returns `null` only for non-object input; any salvageable subtree is
 * preserved and the result always satisfies the tiles/tree/sizes invariants
 * (via {@link reconcileCanvasInvariants}).
 */
export function parseEpicCanvasState(value: unknown): EpicCanvasState | null {
  if (!isRecord(value)) return null;
  const ctx: ParseContext = {
    tiles: parsePersistedTiles(value.tilesByInstanceId),
    sizes: parsePersistedSizes(value.sizesByGroupId),
  };
  const root =
    value.root === null ? null : parseCurrentTileNode(value.root, ctx);
  if (root === null) return createEmptyCanvas();
  const activePaneId =
    typeof value.activePaneId === "string" ? value.activePaneId : null;
  return reconcileCanvasInvariants({
    root,
    activePaneId,
    tilesByInstanceId: ctx.tiles,
    sizesByGroupId: ctx.sizes,
  });
}

export function parseCanvasByTabId(
  value: Readonly<Record<string, DesktopJsonValue>>,
): Readonly<Record<string, EpicCanvasState>> {
  const out: Record<string, EpicCanvasState> = {};
  for (const [tabId, canvas] of Object.entries(value)) {
    const parsed = parseEpicCanvasState(canvas);
    if (parsed !== null) out[tabId] = parsed;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Serialization (always writes the current N-ary shape)
// ---------------------------------------------------------------------------

export function serializeTileNode(node: TileLayoutNode): DesktopJsonValue {
  if (node.kind === "pane") {
    return {
      kind: "pane",
      id: node.id,
      tabInstanceIds: node.tabInstanceIds,
      activeTabId: node.activeTabId,
      previewTabId: node.previewTabId,
      activationHistory: node.activationHistory,
    };
  }
  return {
    kind: "group",
    id: node.id,
    direction: node.direction,
    children: node.children.map(serializeTileNode),
  };
}

export function serializeEpicCanvasState(
  canvas: EpicCanvasState,
): DesktopJsonValue {
  return {
    root: canvas.root === null ? null : serializeTileNode(canvas.root),
    activePaneId: canvas.activePaneId,
    tilesByInstanceId: Object.fromEntries(
      Object.entries(canvas.tilesByInstanceId).flatMap(([instanceId, ref]) =>
        ref === undefined ? [] : [[instanceId, serializeTileRef(ref)]],
      ),
    ),
    sizesByGroupId: serializeSizes(canvas.sizesByGroupId),
  };
}

function serializeSizes(sizes: SizesByGroupId): DesktopJsonValue {
  return Object.fromEntries(
    Object.entries(sizes).flatMap(([groupId, fractions]) =>
      fractions === undefined ? [] : [[groupId, [...fractions]]],
    ),
  );
}

export function serializeCanvasByTabId(
  value: Readonly<Record<string, EpicCanvasState>>,
): Readonly<Record<string, DesktopJsonValue>> {
  const out: Record<string, DesktopJsonValue> = {};
  for (const [tabId, canvas] of Object.entries(value)) {
    out[tabId] = serializeEpicCanvasState(canvas);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Structural equality (desktop echo suppression)
// ---------------------------------------------------------------------------

/**
 * Structural equality of two canvas states, compared through the canonical
 * serializer so the definition of "same canvas" stays in one place. Used by
 * the desktop projection apply to keep the EXISTING state reference when the
 * sync round-trip echoes our own write back as freshly-parsed objects -
 * without this, every echo would hand new identities to every pane and
 * cascade re-renders through the tiled canvas.
 */
export function epicCanvasStatesEqual(
  a: EpicCanvasState,
  b: EpicCanvasState,
): boolean {
  if (a === b) return true;
  return desktopJsonEqual(
    serializeEpicCanvasState(a),
    serializeEpicCanvasState(b),
  );
}

function isJsonRecord(
  value: DesktopJsonValue,
): value is { readonly [key: string]: DesktopJsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonArray(
  value: DesktopJsonValue,
): value is ReadonlyArray<DesktopJsonValue> {
  return Array.isArray(value);
}

function desktopJsonEqual(a: DesktopJsonValue, b: DesktopJsonValue): boolean {
  if (a === b) return true;
  if (isJsonArray(a) || isJsonArray(b)) {
    if (!isJsonArray(a) || !isJsonArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((entry, index) => desktopJsonEqual(entry, b[index]));
  }
  if (!isJsonRecord(a) || !isJsonRecord(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => {
    if (!Object.hasOwn(b, key)) return false;
    const aValue = a[key];
    const bValue = b[key];
    return desktopJsonEqual(aValue, bValue);
  });
}
