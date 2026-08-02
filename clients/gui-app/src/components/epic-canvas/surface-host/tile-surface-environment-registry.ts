/**
 * Ticket 21 slice 2: the cold/ready environment registry for hosted tile
 * surfaces.
 *
 * A store-selected chat may be a stable-tile-surface-host member before
 * `EpicSessionGate` opens or a slot has measured/registered it (`useOpenEpicHandle`
 * throws on a null handle, so readiness cannot be assumed at membership time).
 * The registry therefore stores `ReadyTileSurfaceEnvironment | null` per
 * `instanceId`: a member with no published environment yet reads as `null`
 * (dormant) rather than failing.
 *
 * Two invariants the design calls out explicitly:
 *
 * - Retain last valid environment across a structural transfer. There is
 *   deliberately no "unregister"/"retract" write path: the ONLY way an
 *   environment changes is a fresh publish (source slot -> destination slot
 *   overwrites in place, never round-tripping through `null`) or membership
 *   itself removing the record. A transient gap between a source slot going
 *   quiet and a destination slot publishing must not surface as `null`.
 * - Removal only by membership. The registry subscribes to
 *   `subscribeTileSurfaceMembership` and deletes a record (notifying its
 *   subscribers) only when the instance actually leaves membership - close,
 *   deselect (decision #17), or settled MRU eviction. Nothing else clears it.
 *
 * Subscriptions are isolated per instance (`Map<instanceId, Set<listener>>`):
 * publishing or updating pane B's environment must not notify pane A's
 * subscribers.
 *
 * ## The transfer-gap contract (design-review finding 4)
 *
 * "Retained" is a continuity guarantee, not a current-readiness guarantee.
 * During the gap between a source slot going quiet and a destination slot's
 * first publish, `getTileSurfaceEnvironment` keeps returning the SAME object
 * the source slot last published - including its `services` handles, which
 * were only ever proven valid for the source slot:
 *
 * - `services.geometryAnchorElement` may already be a disconnected DOM node
 *   (the source slot unmounted it) - it is per-slot, unlike the shared
 *   per-top-level-surface `panePortalContainer` below.
 * - `services.panePortalContainer` is `SurfacePresentationBoundary`'s
 *   container, shared by every pane of the source top-level tab, so it stays
 *   attached across any canvas-only structural move; it goes stale only
 *   across a header tear-off, where it is still the SOURCE tab's container
 *   until the destination publish replaces it.
 * - `services.isPaneFocusedNow` is still the source pane's own focus probe;
 *   calling it during the gap answers "was the OLD pane focused", not
 *   "is the tile focused now".
 *
 * This registry does not - and, without an additional attachment/ownership
 * signal from the slot/geometry layer, cannot - distinguish a genuinely
 * current environment from a retained continuity snapshot. Any consumer that
 * takes a placement-sensitive action (portal-mounting into
 * `panePortalContainer`, routing a focus request through `isPaneFocusedNow`)
 * MUST NOT do so purely because `getTileSurfaceEnvironment` returned
 * non-null. Slice 3+ is responsible for either (a) proving current
 * attachment via a separate slot/geometry signal before acting, or (b)
 * gating placement-sensitive actions until the destination slot's own
 * publish lands. This module intentionally does not add that gating itself -
 * doing so here would require the very unregister/retract path the no-null
 * design rejects.
 */
import {
  getTileSurfaceMembership,
  subscribeTileSurfaceMembership,
} from "@/components/epic-canvas/surface-host/tile-surface-membership";
import type { TileKindId } from "@/stores/epics/canvas/tile-kinds";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import type { PaneActivationFocusIntent } from "@/components/epic-canvas/pane-activation";

export interface TileSurfaceIdentity {
  readonly instanceId: string;
  readonly tileKind: TileKindId;
  readonly contentId: string;
  readonly epicId: string;
  readonly hostId: string;
}

export interface TileSurfacePlacement {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly paneId: string;
  readonly hostId: string;
}

export interface TileSurfacePresentation {
  readonly topLevelVisible: boolean;
  readonly topLevelFocused: boolean;
}

export interface TileSurfaceCanvasActivity {
  readonly tabSelected: boolean;
  readonly canvasPaneActive: boolean;
}

export interface TileSurfacePaneActivation {
  readonly focusIntent: PaneActivationFocusIntent;
}

export interface TileSurfaceServices {
  readonly openEpicHandle: OpenEpicStoreHandle;
  /**
   * The publishing slot's OWN plain placeholder element - the geometry
   * coordinator's `ResizeObserver`-observed anchor, positioned/sized exactly
   * where the hosted record should paint. During a transfer gap (see the
   * module doc's "transfer-gap contract") this can be a disconnected node
   * left behind by a since-unmounted source slot - verify current attachment
   * before relying on its geometry. Distinct from `panePortalContainer`
   * below (design-review slice-4 finding 5): this element exists purely to
   * be measured, never to host portaled content.
   */
  readonly geometryAnchorElement: HTMLElement;
  /**
   * The REAL `PanePortalContainerContext` value ambient at the publishing
   * slot's location - `SurfacePresentationBoundary`'s per-top-level-surface
   * portal host, the same node every other pane-local kept-mounted portal
   * (comment composer, artifact-link editor, mention/hover popovers) renders
   * into. That boundary wraps one entire top-level surface (every pane of
   * one Epic tab shares it), so this stays current across any canvas-only
   * structural move; it only changes across a header tear-off, and during
   * that gap it is still the SOURCE tab's container until the destination
   * publish replaces it - the same retained-until-replaced caveat as every
   * other service here.
   */
  readonly panePortalContainer: HTMLElement | null;
  /**
   * The publishing slot's own focus probe. During a transfer gap this still
   * answers for the source slot, not the tile's current pane - do not treat
   * a retained `true`/`false` as the tile's live focus state.
   */
  readonly isPaneFocusedNow: () => boolean;
}

export interface ReadyTileSurfaceEnvironment {
  readonly identity: TileSurfaceIdentity;
  readonly placement: TileSurfacePlacement;
  readonly presentation: TileSurfacePresentation;
  readonly canvasActivity: TileSurfaceCanvasActivity;
  readonly paneActivation: TileSurfacePaneActivation;
  readonly services: TileSurfaceServices;
}

export type TileSurfaceEnvironment = ReadyTileSurfaceEnvironment | null;

export type TileSurfaceEnvironmentListener = () => void;

const environments = new Map<string, ReadyTileSurfaceEnvironment>();
const listenersByInstance = new Map<
  string,
  Set<TileSurfaceEnvironmentListener>
>();
let previousMembers: ReadonlySet<string> = getTileSurfaceMembership();

function notify(instanceId: string): void {
  const listeners = listenersByInstance.get(instanceId);
  if (listeners === undefined) return;
  listeners.forEach((listener) => listener());
}

/**
 * Publishes (or replaces) the ready environment for
 * `environment.identity.instanceId` - the record is always keyed by the
 * environment's own immutable identity, never an independently passed id
 * that could disagree with it. A publish for an instance that is not
 * currently a member is dropped - membership is the sole authority over
 * which records exist, so a stale/late publish cannot resurrect a record
 * membership has already removed.
 */
export function publishTileSurfaceEnvironment(
  environment: ReadyTileSurfaceEnvironment,
): void {
  const { instanceId } = environment.identity;
  if (!getTileSurfaceMembership().has(instanceId)) return;
  environments.set(instanceId, environment);
  notify(instanceId);
}

/** `null` for a member with no published environment yet, or a non-member. */
export function getTileSurfaceEnvironment(
  instanceId: string,
): TileSurfaceEnvironment {
  return environments.get(instanceId) ?? null;
}

export function subscribeTileSurfaceEnvironment(
  instanceId: string,
  listener: TileSurfaceEnvironmentListener,
): () => void {
  let listeners = listenersByInstance.get(instanceId);
  if (listeners === undefined) {
    listeners = new Set();
    listenersByInstance.set(instanceId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (
      listeners.size === 0 &&
      listenersByInstance.get(instanceId) === listeners
    ) {
      listenersByInstance.delete(instanceId);
    }
  };
}

function reconcileAgainstMembership(): void {
  const members = getTileSurfaceMembership();
  for (const instanceId of previousMembers) {
    if (members.has(instanceId)) continue;
    if (environments.delete(instanceId)) notify(instanceId);
  }
  previousMembers = members;
}

export function resetTileSurfaceEnvironmentRegistryForTesting(): void {
  environments.clear();
  listenersByInstance.clear();
  previousMembers = getTileSurfaceMembership();
}

subscribeTileSurfaceMembership(reconcileAgainstMembership);
