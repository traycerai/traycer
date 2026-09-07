/**
 * Canvas-store-wide immutable tile identity: once an `instanceId` is observed, its `{tile kind,
 * content id, epic id, host id}` tuple must never change.
 */
import { appLogger, type AppLogFields } from "@/lib/logger";
import type { EpicCanvasState, EpicCanvasTileRef } from "./types";

export interface TileIdentityTuple {
  readonly tileKind: EpicCanvasTileRef["type"];
  readonly contentId: string;
  readonly epicId: string;
  readonly hostId: string;
}

export interface TileIdentityViolation {
  readonly instanceId: string;
  readonly previous: TileIdentityTuple;
  readonly incoming: TileIdentityTuple;
}

/** Resolves the epicId a tab's tiles currently inherit, or `null` for an unknown tab. */
export type EpicIdForTabId = (tabId: string) => string | null;

/** A candidate `canvasByTabId` to validate, plus where it came from (for diagnostics). */
export interface TileIdentityIngress {
  readonly canvasByTabId: Readonly<Record<string, EpicCanvasState | undefined>>;
  readonly epicIdForTabId: EpicIdForTabId;
  readonly ingressContext: string;
}

function tileIdentityTuple(
  node: EpicCanvasTileRef,
  epicId: string,
): TileIdentityTuple {
  return {
    tileKind: node.type,
    contentId: node.id,
    epicId,
    hostId: node.hostId,
  };
}

function tileIdentityTuplesEqual(
  a: TileIdentityTuple,
  b: TileIdentityTuple,
): boolean {
  return (
    a.tileKind === b.tileKind &&
    a.contentId === b.contentId &&
    a.epicId === b.epicId &&
    a.hostId === b.hostId
  );
}

/** Plain-literal projection - `AppLogFields` needs a string index signature, which a named interface value does not structurally satisfy. */
function tileIdentityTupleLogFields(tuple: TileIdentityTuple): AppLogFields {
  return {
    tileKind: tuple.tileKind,
    contentId: tuple.contentId,
    epicId: tuple.epicId,
    hostId: tuple.hostId,
  };
}

/** Canvas-wide `instanceId -> tuple` snapshot, scanning every tab's tiles. */
export function collectTileIdentityRegistry(
  canvasByTabId: Readonly<Record<string, EpicCanvasState | undefined>>,
  epicIdForTabId: EpicIdForTabId,
): ReadonlyMap<string, TileIdentityTuple> {
  const out = new Map<string, TileIdentityTuple>();
  for (const [tabId, canvas] of Object.entries(canvasByTabId)) {
    if (canvas === undefined) continue;
    const epicId = epicIdForTabId(tabId);
    if (epicId === null) continue;
    for (const [instanceId, node] of Object.entries(canvas.tilesByInstanceId)) {
      if (node === undefined) continue;
      out.set(instanceId, tileIdentityTuple(node, epicId));
    }
  }
  return out;
}

/**
 * Scans a CANDIDATE `canvasByTabId` (canvas-wide) for the first `instanceId` whose tuple conflicts
 * with either (a) another tab in the same candidate snapshot, or (b) `previous`, the last
 */
export function findTileIdentityViolation(
  previous: ReadonlyMap<string, TileIdentityTuple>,
  canvasByTabId: Readonly<Record<string, EpicCanvasState | undefined>>,
  epicIdForTabId: EpicIdForTabId,
): TileIdentityViolation | null {
  const seenInCandidate = new Map<string, TileIdentityTuple>();
  for (const [tabId, canvas] of Object.entries(canvasByTabId)) {
    if (canvas === undefined) continue;
    const epicId = epicIdForTabId(tabId);
    if (epicId === null) continue;
    for (const [instanceId, node] of Object.entries(canvas.tilesByInstanceId)) {
      if (node === undefined) continue;
      const incoming = tileIdentityTuple(node, epicId);
      const withinCandidate = seenInCandidate.get(instanceId);
      if (
        withinCandidate !== undefined &&
        !tileIdentityTuplesEqual(withinCandidate, incoming)
      ) {
        return { instanceId, previous: withinCandidate, incoming };
      }
      seenInCandidate.set(instanceId, incoming);
      const prior = previous.get(instanceId);
      if (prior !== undefined && !tileIdentityTuplesEqual(prior, incoming)) {
        return { instanceId, previous: prior, incoming };
      }
    }
  }
  return null;
}

/** Enforces the invariant at one ingress. Always emits a diagnostic on violation. */
export function enforceTileIdentityInvariant(
  previous: ReadonlyMap<string, TileIdentityTuple>,
  ingress: TileIdentityIngress,
  throwOnViolation: boolean,
): boolean {
  const { canvasByTabId, epicIdForTabId, ingressContext } = ingress;
  const violation = findTileIdentityViolation(
    previous,
    canvasByTabId,
    epicIdForTabId,
  );
  if (violation === null) return true;
  appLogger.error(
    "canvas tile identity invariant violated",
    {
      ingressContext,
      instanceId: violation.instanceId,
      previous: tileIdentityTupleLogFields(violation.previous),
      incoming: tileIdentityTupleLogFields(violation.incoming),
    },
    new Error("canvas tile identity invariant violated"),
  );
  if (throwOnViolation) {
    throw new Error(
      `Canvas tile identity invariant violated in ${ingressContext} for instanceId ` +
        `${violation.instanceId}: previous=${JSON.stringify(violation.previous)} ` +
        `incoming=${JSON.stringify(violation.incoming)}`,
    );
  }
  return false;
}
