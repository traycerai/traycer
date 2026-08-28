/**
 * Ticket 21 slice 3's "synthetic ready slot/body seam" (design/index.md,
 * slice-3 row): a test-only `ReadyTileSurfaceEnvironment` builder and a
 * mount/unmount-counting body component, used to drive `StableTileSurfaceHost`
 * with REAL membership/registry/store state but a fake body - proving the
 * jsdom-expressible half of the lifecycle contract without claiming a real
 * `ChatTile`/`ChatMessages` integration (that's slice 4+).
 */
import { useEffect, type ReactNode } from "react";
import type {
  ReadyTileSurfaceEnvironment,
  TileSurfaceIdentity,
} from "@/components/epic-canvas/surface-host/tile-surface-environment-registry";
import { TEST_HOST_ID } from "@/stores/epics/canvas/__tests__/canvas-test-fixtures";

/**
 * jsdom reports every unstubbed element's `getBoundingClientRect()` as all
 * zeros. `TileSurfaceRecord` now gates its hosted body on the FIRST usable
 * (positive width/height) rect from `services.geometryAnchorElement` - a
 * default anchor that stays 0x0 forever would make every test that doesn't
 * explicitly override `geometryAnchorElement` see a body that never mounts,
 * which is truthful for a real detached slot but not what most of this
 * fixture's callers are testing. Stamp a real, positive rect on the default
 * anchor so "ready" means ready the way it did before the gate existed;
 * tests exercising the born-hidden/still-zero contract pass their own 0x0
 * anchor via `overrides.services` instead of relying on this default.
 */
function createDefaultGeometryAnchor(): HTMLDivElement {
  const anchor = document.createElement("div");
  anchor.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 200,
    height: 100,
    right: 200,
    bottom: 100,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  return anchor;
}

export function buildSyntheticTileSurfaceEnvironment(
  instanceId: string,
  overrides: Partial<ReadyTileSurfaceEnvironment>,
): ReadyTileSurfaceEnvironment {
  const defaultIdentity: TileSurfaceIdentity = {
    instanceId,
    tileKind: "chat",
    contentId: instanceId,
    epicId: "tab-1",
    hostId: TEST_HOST_ID,
  };
  return {
    placement: {
      epicId: "tab-1",
      viewTabId: "tab-1",
      paneId: "p1",
      hostId: TEST_HOST_ID,
    },
    presentation: { topLevelVisible: true, topLevelFocused: false },
    canvasActivity: { tabSelected: true, canvasPaneActive: false },
    paneActivation: {
      focusIntent: {
        mark: () => undefined,
        shouldYieldAutoFocus: () => false,
      },
    },
    services: {
      openEpicHandle:
        {} as ReadyTileSurfaceEnvironment["services"]["openEpicHandle"],
      geometryAnchorElement: createDefaultGeometryAnchor(),
      panePortalContainer: null,
      isPaneFocusedNow: () => false,
    },
    ...overrides,
    identity: {
      ...defaultIdentity,
      ...overrides.identity,
      instanceId,
    },
  };
}

export interface SyntheticTileSurfaceLifecycleEvent {
  readonly instanceId: string;
  readonly kind: "mount" | "unmount";
}

export interface SyntheticTileSurfaceBodyRenderer {
  readonly renderRecordBody: (
    environment: ReadyTileSurfaceEnvironment,
  ) => ReactNode;
  readonly events: ReadonlyArray<SyntheticTileSurfaceLifecycleEvent>;
  readonly mountCount: (instanceId: string) => number;
  readonly unmountCount: (instanceId: string) => number;
}

/**
 * A fresh renderer per test - `events` is a live array reference the caller
 * can inspect at any point, not a snapshot taken at creation time.
 */
export function createSyntheticTileSurfaceBodyRenderer(): SyntheticTileSurfaceBodyRenderer {
  const events: SyntheticTileSurfaceLifecycleEvent[] = [];

  function SyntheticTileSurfaceBody(props: {
    readonly instanceId: string;
  }): ReactNode {
    useEffect(() => {
      events.push({ instanceId: props.instanceId, kind: "mount" });
      return () => {
        events.push({ instanceId: props.instanceId, kind: "unmount" });
      };
    }, [props.instanceId]);
    return (
      <div
        data-synthetic-tile-surface-body="true"
        data-testid={`synthetic-tile-surface-body-${props.instanceId}`}
      />
    );
  }

  return {
    renderRecordBody: (environment) => (
      <SyntheticTileSurfaceBody instanceId={environment.identity.instanceId} />
    ),
    events,
    mountCount: (instanceId) =>
      events.filter((e) => e.instanceId === instanceId && e.kind === "mount")
        .length,
    unmountCount: (instanceId) =>
      events.filter((e) => e.instanceId === instanceId && e.kind === "unmount")
        .length,
  };
}
