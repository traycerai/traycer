import { cleanup, render, waitFor } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it } from "vitest";
import { TileFindOwnerBridge } from "@/components/epic-canvas/tile-find/tile-find-owner-bridge";
import { useTileFindStore } from "@/stores/tile-find/tile-find-store";

/**
 * `hasBlockingDomDialog` (inside `tile-find-owner-bridge.tsx`) matches
 * `[role="dialog"][data-open]` - the Base UI Dialog's own contract, not
 * Radix's `data-state="open"`. A dialog mock must carry `data-open` for this
 * suite to say anything about the real DOM.
 */
function buildBridgeRouter() {
  const rootRoute = createRootRoute({
    component: () => <TileFindOwnerBridge />,
  });
  return createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

function renderBridge() {
  const router = buildBridgeRouter();
  return render(<RouterProvider router={router} />);
}

describe("TileFindOwnerBridge - DOM dialog blocking", () => {
  afterEach(() => {
    cleanup();
    useTileFindStore.getState().resetForTests();
    for (const stray of document.querySelectorAll('[role="dialog"]'))
      stray.remove();
  });

  it("blocks tile-find ownership while an open dialog sits outside the tile-find scope", async () => {
    renderBridge();
    expect(useTileFindStore.getState().ownerBlocker).toBe(null);

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-open", "");
    document.body.append(dialog);

    await waitFor(() => {
      expect(useTileFindStore.getState().ownerBlocker).toEqual({
        reason: "dom-dialog",
        ownerId: "dom-dialog",
      });
    });

    dialog.remove();
    await waitFor(() => {
      expect(useTileFindStore.getState().ownerBlocker).toBe(null);
    });
  });

  it("does not block a dialog that lives inside the tile-find scope itself", async () => {
    renderBridge();
    const scope = document.createElement("div");
    scope.setAttribute("data-tile-find-scope", "");
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-open", "");
    scope.append(dialog);
    document.body.append(scope);

    // Give the observer a turn; there is nothing to wait for becoming true,
    // so this asserts the blocker never arrives.
    await waitFor(() => {
      expect(dialog.isConnected).toBe(true);
    });
    expect(useTileFindStore.getState().ownerBlocker).toBe(null);

    scope.remove();
  });
});
