import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { createEmptyCanvas } from "@/stores/epics/canvas/canvas-state";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import { phaseMigrationController } from "@/components/epic-tabs/phase-migration-controller";
import { PhaseMigrationControllerHost } from "@/components/epic-tabs/phase-migration-controller-host";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { useTabsStore } from "@/stores/tabs/store";

interface MigrationOptions {
  readonly onSuccess: (data: { readonly epicId: string }) => void;
}

const testState = vi.hoisted(() => ({
  mutate: vi.fn(
    (_variables: { readonly phaseId: string }, _options: MigrationOptions) =>
      undefined,
  ),
}));

vi.mock("@/hooks/migration/use-phase-migrate-to-epic-mutation", () => ({
  usePhaseMigrateToEpic: () => ({ mutate: testState.mutate }),
}));

function resetState(): void {
  phaseMigrationController.resetForTesting();
  __resetTabNavigationControllerForTesting();
  testState.mutate.mockReset();
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

function seedMigration(focusedSide: "left" | "right"): void {
  useEpicCanvasStore.setState({
    tabsById: {
      "phase-tab": {
        tabId: "phase-tab",
        epicId: "phase-1",
        name: "Legacy Phase",
        surfaceMode: { kind: "phase-migration", phaseId: "phase-1" },
      },
      "partner-tab": {
        tabId: "partner-tab",
        epicId: "epic-partner",
        name: "Partner",
      },
    },
    canvasByTabId: {
      "phase-tab": createEmptyCanvas(),
      "partner-tab": createEmptyCanvas(),
    },
    openTabOrder: ["phase-tab", "partner-tab"],
    activeTabId: "phase-tab",
    mostRecentTabIdByEpicId: {
      "phase-1": "phase-tab",
      "epic-partner": "partner-tab",
    },
  });
  useTabsStore.setState({
    version: 2,
    items: [
      {
        kind: "split",
        id: "phase-split",
        left: { kind: "tab", ref: { kind: "epic", id: "phase-tab" } },
        right: { kind: "tab", ref: { kind: "epic", id: "partner-tab" } },
        focusedSide,
        routeBackingSide: focusedSide,
        leftRatio: 0.42,
      },
    ],
    activeItemId: "phase-split",
    stripOrder: [
      { kind: "epic", id: "phase-tab" },
      { kind: "epic", id: "partner-tab" },
    ],
    systemTabs: { history: null, settings: null },
  });
}

function renderHost() {
  const rootRoute = createRootRoute();
  const route = createRoute({
    path: "/epics/$epicId/$tabId",
    getParentRoute: () => rootRoute,
    component: PhaseMigrationControllerHost,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({
      initialEntries: ["/epics/phase-1/phase-tab?migrationSource=phase"],
    }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

function resolveMigration(epicId: string): void {
  const options = testState.mutate.mock.calls[0]?.[1];
  act(() => options.onSuccess({ epicId }));
}

describe("PhaseMigrationControllerHost settlement routing", () => {
  beforeEach(resetState);
  afterEach(() => {
    cleanup();
    resetState();
  });

  it("does not start a second mutation when the controller host is recreated", async () => {
    seedMigration("left");
    renderHost();

    await waitFor(() => expect(testState.mutate).toHaveBeenCalledTimes(1));
    cleanup();
    renderHost();

    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    });
    expect(testState.mutate).toHaveBeenCalledTimes(1);
  });

  it("converts in place without navigating when the partner owns focus", async () => {
    seedMigration("right");
    const router = renderHost();

    await waitFor(() => expect(testState.mutate).toHaveBeenCalledTimes(1));
    resolveMigration("epic-created");

    expect(useEpicCanvasStore.getState().tabsById["phase-tab"]?.epicId).toBe(
      "epic-created",
    );
    expect(useTabsStore.getState().items[0]).toMatchObject({
      focusedSide: "right",
      leftRatio: 0.42,
    });
    expect(router.state.location.pathname).toBe("/epics/phase-1/phase-tab");
  });

  it("replaces the route only when the exact migration ref still owns focus", async () => {
    seedMigration("left");
    const router = renderHost();

    await waitFor(() => expect(testState.mutate).toHaveBeenCalledTimes(1));
    resolveMigration("epic-created");

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(
        "/epics/epic-created/phase-tab",
      );
    });
    expect(router.state.location.search).not.toHaveProperty("migrationSource");
  });
});
