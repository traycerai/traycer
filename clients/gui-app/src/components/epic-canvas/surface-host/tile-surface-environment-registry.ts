/**
 * Members may be dormant (null) until a slot publishes. Never round-trip a record through null on transfer; only membership deletes.
 * A non-null environment may be a retained source-slot snapshot - do not portal or trust focus from it without a current attachment signal.
 */
import {
  getTileSurfaceMembership,
  subscribeTileSurfaceMembership,
} from "@/components/epic-canvas/surface-host/tile-surface-membership";
import type { TileKindId } from "@/stores/epics/canvas/tile-kinds";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import type { PaneActivationFocusIntent } from "@/components/epic-canvas/pane-activation";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";

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
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  /**
   * Per-slot measure anchor. During a transfer gap this can be a disconnected node - verify attachment before using its geometry. Never host portaled content here.
   */
  readonly geometryAnchorElement: HTMLElement;
  /**
   * Per-top-level portal host. Stays current across canvas-only moves; during a header tear-off gap it is still the source tab's container until the destination publishes.
   */
  readonly panePortalContainer: HTMLElement | null;
  /**
   * During a transfer gap this still answers for the source slot - do not treat a retained true/false as live focus.
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
 * Keyed by the environment's own instanceId. Drop publishes for non-members so a late publish cannot resurrect a removed record.
 */
export function publishTileSurfaceEnvironment(
  environment: ReadyTileSurfaceEnvironment,
): void {
  const { instanceId } = environment.identity;
  if (!getTileSurfaceMembership().has(instanceId)) return;
  environments.set(instanceId, environment);
  notify(instanceId);
}

/**
 * Retract presentation only for this slot's own published anchor; the record stays.
 * A source teardown before the destination publish leaves the record unpresented until that publish - never paint two owners.
 */
export function retractTileSurfacePresentation(
  instanceId: string,
  publishedAnchor: HTMLElement | null,
): void {
  const current = environments.get(instanceId);
  if (current === undefined) return;
  if (current.services.geometryAnchorElement !== publishedAnchor) return;
  if (!current.canvasActivity.tabSelected) return;
  environments.set(instanceId, {
    ...current,
    canvasActivity: { ...current.canvasActivity, tabSelected: false },
  });
  notify(instanceId);
}

/** null for a member with no published environment yet, or a non-member. */
export function getTileSurfaceEnvironment(
  instanceId: string,
): TileSurfaceEnvironment {
  return environments.get(instanceId) ?? null;
}

/**
 * Paint only when top-level visible AND tabSelected. Retained members share the pane rect, so a stale tabSelected stacks on the selected tile.
 */
export function isTileSurfacePresented(
  environment: TileSurfaceEnvironment,
): boolean {
  if (environment === null) return false;
  return (
    environment.presentation.topLevelVisible &&
    environment.canvasActivity.tabSelected
  );
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
