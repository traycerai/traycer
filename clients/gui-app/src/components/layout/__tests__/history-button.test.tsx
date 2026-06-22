import "../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { HistoryButton } from "@/components/layout/header/history-button";
import { TooltipProvider } from "@/components/ui/tooltip";

async function renderHistoryButton(initialPath: "/epics" | `/epics/${string}`) {
  const rootRoute = createRootRoute({
    component: () => (
      <TooltipProvider>
        <HistoryButton />
        <Outlet />
      </TooltipProvider>
    ),
  });
  const epicsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/epics",
    component: () => <div data-testid="epics-list" />,
  });
  const epicDetailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/epics/$epicId",
    component: () => <div data-testid="epic-detail" />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([epicsRoute, epicDetailRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });

  render(<RouterProvider router={router} />);
  return screen.findByTestId("history-button");
}

describe("<HistoryButton />", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows as active on the /epics history route", async () => {
    const button = await renderHistoryButton("/epics");

    expect(button.className).toContain("bg-accent");
  });

  it("does not show as active on an epic detail route", async () => {
    const button = await renderHistoryButton("/epics/epic-1");

    expect(button.className).not.toContain("bg-accent");
  });
});
