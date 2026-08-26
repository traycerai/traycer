/**
 * Persisted-state sanitization for the epic canvas store: every reader here
 * takes `unknown` from the zustand persist `merge` and rebuilds a valid
 * slice, dropping (never throwing on) malformed entries. Canvas payloads
 * delegate to `parseEpicCanvasState` (`migrate-canvas.ts`); this module owns
 * the store-level shape around them (tabs, order, pointers, artifact trees).
 */
import {
  isEpicNodeKind,
  type EpicNodeRecord,
} from "@/lib/artifacts/node-display";
import type { EpicCanvasState, EpicPipGeometry, EpicViewTab } from "./types";
import { createEmptyCanvas } from "./canvas-state";
import { parseEpicCanvasState } from "./migrate-canvas";

export const EMPTY_TREES: Readonly<
  Record<string, ReadonlyArray<EpicNodeRecord>>
> = {};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface PersistedCanvasStatePatch {
  readonly tabsById: Readonly<Record<string, EpicViewTab | undefined>>;
  readonly canvasByTabId: Readonly<Record<string, EpicCanvasState | undefined>>;
  readonly openTabOrder: ReadonlyArray<string>;
  readonly activeTabId: string | null;
  readonly mostRecentTabIdByEpicId: Readonly<
    Record<string, string | undefined>
  >;
  readonly artifactTreeByEpicId: Readonly<
    Record<string, ReadonlyArray<EpicNodeRecord> | undefined>
  >;
  readonly pipGeometryByEpicId: Readonly<
    Record<string, EpicPipGeometry | undefined>
  >;
}

export function sanitizePersistedCanvasState(
  value: unknown,
): PersistedCanvasStatePatch {
  if (!isRecord(value)) return emptyPersistedCanvasStatePatch();
  const tabsById = readPersistedTabsById(value.tabsById);
  const openTabOrder = readPersistedOpenTabOrder(value.openTabOrder, tabsById);
  return {
    tabsById,
    canvasByTabId: readPersistedCanvasByTabId(
      value.canvasByTabId,
      new Set(Object.keys(tabsById)),
    ),
    openTabOrder,
    activeTabId: readPersistedActiveTabId(value.activeTabId, openTabOrder),
    mostRecentTabIdByEpicId: readPersistedMostRecentTabIdByEpicId(
      value.mostRecentTabIdByEpicId,
      tabsById,
    ),
    artifactTreeByEpicId: readPersistedArtifactTreeByEpicId(
      value.artifactTreeByEpicId,
    ),
    pipGeometryByEpicId: readPersistedPipGeometryByEpicId(
      value.pipGeometryByEpicId,
    ),
  };
}

function emptyPersistedCanvasStatePatch(): PersistedCanvasStatePatch {
  return {
    tabsById: {},
    canvasByTabId: {},
    openTabOrder: [],
    activeTabId: null,
    mostRecentTabIdByEpicId: {},
    artifactTreeByEpicId: EMPTY_TREES,
    pipGeometryByEpicId: {},
  };
}

/**
 * Build `canvasByTabId` from the top-level persisted `canvasByTabId` map. Every
 * valid tab is guaranteed a canvas (empty when none was stored).
 */
function readPersistedCanvasByTabId(
  value: unknown,
  validTabIds: ReadonlySet<string>,
): Readonly<Record<string, EpicCanvasState>> {
  const out: Record<string, EpicCanvasState> = {};
  if (isRecord(value)) {
    for (const [tabId, rawCanvas] of Object.entries(value)) {
      if (!validTabIds.has(tabId)) continue;
      const canvas = parseEpicCanvasState(rawCanvas);
      if (canvas !== null) out[tabId] = canvas;
    }
  }
  for (const tabId of validTabIds) {
    if (!Object.hasOwn(out, tabId)) out[tabId] = createEmptyCanvas();
  }
  return out;
}

function readPersistedTabsById(
  value: unknown,
): Readonly<Record<string, EpicViewTab | undefined>> {
  if (!isRecord(value)) return {};
  const out: Record<string, EpicViewTab> = {};
  for (const [tabId, rawTab] of Object.entries(value)) {
    const tab = parsePersistedEpicViewTab(rawTab);
    if (tab === null || tab.tabId !== tabId) continue;
    out[tab.tabId] = tab;
  }
  return out;
}

function parsePersistedEpicViewTab(value: unknown): EpicViewTab | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.tabId !== "string" ||
    typeof value.epicId !== "string" ||
    typeof value.name !== "string"
  ) {
    return null;
  }
  // The canvas is parsed separately into `canvasByTabId`
  // (see `readPersistedCanvasByTabId`), not stored on the tab record. Any legacy
  // `lastSeenAt` in persisted data is ignored - the field was removed (it was
  // write-only; restore ordering uses `mostRecentTabIdByEpicId`).
  const surfaceMode = parsePersistedSurfaceMode(value.surfaceMode);
  return {
    tabId: value.tabId,
    epicId: value.epicId,
    name: value.name,
    ...(surfaceMode === undefined ? {} : { surfaceMode }),
  };
}

function parsePersistedSurfaceMode(value: unknown): EpicViewTab["surfaceMode"] {
  if (!isRecord(value)) return undefined;
  if (value.kind === "epic") return { kind: "epic" };
  if (value.kind !== "phase-migration" || typeof value.phaseId !== "string") {
    return undefined;
  }
  return { kind: "phase-migration", phaseId: value.phaseId };
}

function readPersistedOpenTabOrder(
  value: unknown,
  tabsById: Readonly<Record<string, EpicViewTab | undefined>>,
): ReadonlyArray<string> {
  const validIds = new Set(Object.keys(tabsById));
  if (!Array.isArray(value)) return [...validIds];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    if (!validIds.has(entry) || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

function readPersistedActiveTabId(
  value: unknown,
  openTabOrder: ReadonlyArray<string>,
): string | null {
  if (typeof value === "string" && openTabOrder.includes(value)) {
    return value;
  }
  return openTabOrder[0] ?? null;
}

function readPersistedMostRecentTabIdByEpicId(
  value: unknown,
  tabsById: Readonly<Record<string, EpicViewTab | undefined>>,
): Readonly<Record<string, string | undefined>> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [epicId, tabId] of Object.entries(value)) {
    if (typeof tabId !== "string") continue;
    const tab = tabsById[tabId];
    if (tab === undefined || tab.epicId !== epicId) continue;
    out[epicId] = tabId;
  }
  return out;
}

function readPersistedArtifactTreeByEpicId(
  value: unknown,
): Readonly<Record<string, ReadonlyArray<EpicNodeRecord> | undefined>> {
  if (!isRecord(value)) return EMPTY_TREES;
  const out: Record<string, ReadonlyArray<EpicNodeRecord>> = {};
  for (const [epicId, records] of Object.entries(value)) {
    if (!Array.isArray(records)) continue;
    const parsed = records.flatMap((record) => {
      const node = parsePersistedEpicNodeRecord(record);
      return node === null ? [] : [node];
    });
    // Dropping an invalid node would otherwise leave its children pointing at
    // a parentId that no longer exists - a dangling ref a root-walk silently
    // hides. Re-root those orphans so they stay reachable.
    const survivingIds = new Set(parsed.map((node) => node.id));
    out[epicId] = parsed.map((node) =>
      node.parentId !== null && !survivingIds.has(node.parentId)
        ? { ...node, parentId: null }
        : node,
    );
  }
  return out;
}

function parsePersistedEpicNodeRecord(value: unknown): EpicNodeRecord | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !isEpicNodeKind(value.type) ||
    typeof value.hostId !== "string" ||
    (typeof value.parentId !== "string" && value.parentId !== null)
  ) {
    return null;
  }
  return {
    id: value.id,
    parentId: value.parentId,
    name: value.name,
    type: value.type,
    hostId: value.hostId,
  };
}

function readPersistedPipGeometryByEpicId(
  value: unknown,
): Readonly<Record<string, EpicPipGeometry | undefined>> {
  if (!isRecord(value)) return {};
  const out: Record<string, EpicPipGeometry> = {};
  for (const [epicId, raw] of Object.entries(value)) {
    const geometry = parsePersistedPipGeometry(raw);
    if (geometry !== null) out[epicId] = geometry;
  }
  return out;
}

function parsePersistedPipGeometry(value: unknown): EpicPipGeometry | null {
  if (!isRecord(value)) return null;
  const anchored = readFourFiniteNumbers([
    value.anchorX,
    value.anchorY,
    value.previewWidth,
    value.previewHeight,
  ]);
  if (anchored !== null) {
    return {
      anchorX: anchored[0],
      anchorY: anchored[1],
      previewWidth: anchored[2],
      previewHeight: anchored[3],
    };
  }
  const legacy = readFourFiniteNumbers([
    value.x,
    value.y,
    value.width,
    value.height,
  ]);
  if (legacy === null) return null;
  return {
    anchorX: legacy[0] + legacy[2],
    anchorY: legacy[1] + legacy[3],
    previewWidth: legacy[2],
    previewHeight: legacy[3],
  };
}

function readFourFiniteNumbers(
  values: readonly [unknown, unknown, unknown, unknown],
): readonly [number, number, number, number] | null {
  const [first, second, third, fourth] = values;
  if (!isFiniteNumber(first)) return null;
  if (!isFiniteNumber(second)) return null;
  if (!isFiniteNumber(third)) return null;
  if (!isFiniteNumber(fourth)) return null;
  return [first, second, third, fourth];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
