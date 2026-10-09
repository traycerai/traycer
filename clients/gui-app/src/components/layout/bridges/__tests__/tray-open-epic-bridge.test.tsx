import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Only the open itself is replaced with a spy: it is the boundary the bridge
// hands a request to, and its own tab navigation is covered where it lives. The
// router, the tray store and the pending-delete reader are the real ones.
const openEpicFromList = vi.hoisted(() =>
  vi.fn<
    (
      navigate: unknown,
      epicId: string,
      currentPathname: string,
      options: {
        readonly title: string | undefined;
        readonly source: string;
      },
    ) => void
  >(),
);

vi.mock("@/lib/commands/actions/open-epic-from-list", () => ({
  openEpicFromList,
}));

import { TrayOpenEpicBridge } from "@/components/layout/bridges/tray-open-epic-bridge";
import { holdEpicBatchDelete } from "@/hooks/epic/__tests__/hold-epic-batch-delete";
import { useTrayProjectionStore } from "@/stores/tray/tray-projection-store";

function newQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

let queryClient = newQueryClient();

/**
 * The bridge mounts inside the router, as the root route does, and reads the
 * mutation cache for in-flight deletes, so it sits under a query client too.
 */
async function mountBridge(): Promise<void> {
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <TrayOpenEpicBridge />
        <Outlet />
      </QueryClientProvider>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <div data-testid="bridge-host" />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<RouterProvider router={router} />);
  await screen.findByTestId("bridge-host");
}

function requestOpen(epicId: string): void {
  act(() => {
    useTrayProjectionStore.getState().requestOpenEpic(epicId);
  });
}

describe("<TrayOpenEpicBridge />", () => {
  beforeEach(() => {
    queryClient = newQueryClient();
    openEpicFromList.mockReset();
    useTrayProjectionStore.getState().reset();
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
    useTrayProjectionStore.getState().reset();
  });

  it("opens the requested epic with its projected title, from the system tray", async () => {
    useTrayProjectionStore.getState().setEpics([
      { epicId: "epic-live", title: "Live task", subtitle: "just now" },
      { epicId: "epic-other", title: "Other task", subtitle: "earlier" },
    ]);
    await mountBridge();

    requestOpen("epic-live");

    expect(openEpicFromList).toHaveBeenCalledTimes(1);
    expect(openEpicFromList).toHaveBeenCalledWith(
      expect.any(Function),
      "epic-live",
      "/",
      { title: "Live task", source: "system_tray" },
    );
  });

  describe("a task whose deletion is in flight", () => {
    it("is not opened, while a request for another task in the same session still is", async () => {
      holdEpicBatchDelete(queryClient, ["epic-deleting"]);
      await mountBridge();

      requestOpen("epic-deleting");
      expect(openEpicFromList).not.toHaveBeenCalled();

      // The control: the bridge is mounted and listening, and the refusal is
      // about that one task rather than about the tray.
      requestOpen("epic-live");
      expect(openEpicFromList).toHaveBeenCalledTimes(1);
      expect(openEpicFromList.mock.calls.at(0)?.[1]).toBe("epic-live");
    });

    it("is not opened when it is one of several tasks in the same delete", async () => {
      holdEpicBatchDelete(queryClient, ["epic-first", "epic-deleting"]);
      await mountBridge();

      requestOpen("epic-deleting");

      expect(openEpicFromList).not.toHaveBeenCalled();
    });

    it("is opened by a request made after the delete settles", async () => {
      const held = holdEpicBatchDelete(queryClient, ["epic-deleting"]);
      await mountBridge();
      requestOpen("epic-deleting");
      expect(openEpicFromList).not.toHaveBeenCalled();

      await act(async () => {
        await held.settle();
      });
      requestOpen("epic-deleting");

      expect(openEpicFromList).toHaveBeenCalledTimes(1);
      expect(openEpicFromList.mock.calls.at(0)?.[1]).toBe("epic-deleting");
    });
  });
});
