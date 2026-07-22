import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { PhaseToEpicMigrationGate } from "@/routes/epic-tab-route-components";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { useTabsStore } from "@/stores/tabs/store";

const testState = vi.hoisted(() => ({
  mutate: vi.fn(
    (
      _variables: { readonly phaseId: string },
      options: {
        readonly onSuccess:
          ((data: { readonly epicId: string }) => void) | undefined;
      },
    ) => {
      options.onSuccess?.({ epicId: "phase-1" });
    },
  ),
}));

vi.mock("@/components/epic-canvas/epic-route-session-body", () => ({
  // Note: epic-route-session-body stays at root, not moved
  EpicRouteSessionBody: (props: { readonly epicId: string }) => (
    <div data-epic-id={props.epicId} data-testid="epic-route-session-body" />
  ),
}));

vi.mock("@/providers/epic-session-provider", () => ({
  EpicSessionProvider: (props: {
    readonly children: ReactNode;
    readonly epicId: string;
    readonly tabId: string;
  }) => (
    <div
      data-epic-id={props.epicId}
      data-tab-id={props.tabId}
      data-testid="epic-session-provider"
    >
      {props.children}
    </div>
  ),
}));

vi.mock("@/hooks/migration/use-phase-migrate-to-epic-mutation", () => ({
  usePhaseMigrateToEpic: () => ({
    data: undefined,
    error: null,
    isError: false,
    isPending: true,
    mutate: testState.mutate,
  }),
}));

function resetStores(): void {
  vi.clearAllMocks();
  __resetTabNavigationControllerForTesting();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useTabsStore.setState({
    version: 2,
    items: [],
    activeItemId: null,
    stripOrder: [],
    systemTabs: { history: null, settings: null },
  });
  tabCommandCoordinator.resetReconciliationForTesting();
}

beforeEach(() => {
  resetStores();
});

afterEach(() => {
  cleanup();
  resetStores();
});

function mountPhaseMigrationGate() {
  const rootRoute = createRootRoute();
  const epicRoute = createRoute({
    path: "/epics/$epicId",
    getParentRoute: () => rootRoute,
    component: () => (
      <PhaseToEpicMigrationGate
        phaseId="phase-1"
        tabId="tab-phase-1"
        search={{
          focusedAt: undefined,
          focusArtifactId: undefined,
          focusThreadId: undefined,
          migrationSource: "phase",
          focusPaneId: undefined,
          focusTileInstanceId: undefined,
        }}
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([epicRoute]),
    history: createMemoryHistory({
      initialEntries: ["/epics/phase-1?migrationSource=phase"],
    }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

describe("/epics/$epicId phase migration gate", () => {
  it("creates the persisted migration ref without starting a route-owned mutation", async () => {
    mountPhaseMigrationGate();

    await waitFor(() => {
      const tab = Object.values(useEpicCanvasStore.getState().tabsById).find(
        (candidate) =>
          candidate?.surfaceMode?.kind === "phase-migration" &&
          candidate.surfaceMode.phaseId === "phase-1",
      );
      expect(tab?.epicId).toBe("phase-1");
      expect(tab?.name).toBe("Untitled epic");
    });
    expect(testState.mutate).not.toHaveBeenCalled();
  });
});

// TODO(canvas-tab-groups): rewrite the route-level integration tests against
// the new TileTabGroup data model. The previous suite asserted on
// `activeTileId`, `splitTileInEpic`, `closeTileInEpic`, `findLeafByTileId`,
// and `flattenLeaves` - all replaced by the tab/group action surface.
// Re-add coverage for: `?focusArtifactId` opening as preview and canvas
// restoration from the persisted `EpicCanvasState` shape.
