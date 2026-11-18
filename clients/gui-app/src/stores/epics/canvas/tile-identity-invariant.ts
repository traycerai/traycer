/**
 * Canvas-store-wide immutable tile identity: once an `instanceId` is
 * observed, its `{tile kind, content id, epic id, host id}` tuple must never
 * change. `epicId` is not stored on most tile refs - it is derived from
 * whichever tab currently owns the tile (`tabsById[tabId].epicId`), so every
 * check here takes a canvas-wide `canvasByTabId` snapshot plus an epicId
 * resolver rather than a single tile in isolation. A repoint under an
 * unchanged `instanceId` is the exact hazard `ChatMessages` cannot survive -
 * it freezes `(instanceId, epicId, chatId)` once per mount.
 *
 * This module is strict, full stop - no ingress may commit an epicId change
 * under a retained `instanceId`. The one sanctioned resolution
 * (`store.ts`'s `resolveTabEpicIdentity`) does not pass through here at all:
 * it is the sole caller of the module-private raw setter, so provenance is
 * enforced by module privacy rather than a parameter this module has to
 * understand.
 *
 * Pure detection lives here; the dev/test-throws-vs-production-fails-closed
 * policy is applied by `enforceTileIdentityInvariant`, and committing (or
 * rejecting) a candidate state is the caller's job - this module never
 * touches the store.
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

/**
 * Canvas-wide `instanceId -> tuple` snapshot, scanning every tab's tiles.
 * Callers pass an ALREADY-VALIDATED `canvasByTabId` (the store's committed
 * state) to build the `previous` baseline a candidate is checked against -
 * `findTileIdentityViolation` is what validates a candidate before it is
 * ever folded into that baseline.
 */
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
 * Scans a CANDIDATE `canvasByTabId` (canvas-wide) for the first `instanceId`
 * whose tuple conflicts with either (a) another tab in the same candidate
 * snapshot, or (b) `previous`, the last known-valid registry. An
 * `instanceId` absent from `previous` (a fresh mint) or absent from the
 * candidate (a close) is never a violation; a RETAINED `instanceId` with a
 * CHANGED tuple is always a violation.
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

/**
 * Enforces the invariant at one ingress. Always emits a diagnostic on
 * violation. `throwOnViolation` is the dev/test-vs-production policy switch -
 * production callers pass `import.meta.env.DEV`; tests drive it directly
 * rather than stubbing Vite's static env. Returns whether the candidate
 * `canvasByTabId` may be committed: a `false` result means the caller must
 * retain its last valid state (drop the candidate patch entirely) - this
 * function never commits or mutates anything itself.
 */
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
