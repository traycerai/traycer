import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { TileFindOwnerBridge } from "@/components/epic-canvas/tile-find/tile-find-owner-bridge";
import { useTileFindStore } from "@/stores/tile-find";

/**
 * W2-H2: the bridge's DOM-dialog detector used to re-run a document-wide
 * `querySelectorAll` on EVERY mutation under `document.body` - including
 * ordinary content churn deep inside the app's `#root`, nowhere near a
 * dialog. The fix filters the MutationRecord batch first and only re-queries
 * (and only notifies) when a record could plausibly be a dialog opening,
 * closing, or losing its `role`. Exercised through the bridge's only public
 * surface (it has no other exports) and the store write it drives.
 */
function renderBridge(): void {
  const rootRoute = createRootRoute({
    component: () => <TileFindOwnerBridge />,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<RouterProvider router={router} />);
}

function currentBlockerReason(): string | null {
  return useTileFindStore.getState().ownerBlocker?.reason ?? null;
}

/** Stand-in for the app's real `#root` mount, since pane-local portals and
 * streaming content both land under it in production. */
function createAppRoot(): HTMLElement {
  const root = document.createElement("div");
  root.id = "root";
  document.body.appendChild(root);
  return root;
}

function appendDialog(scoped: boolean, root: Element): HTMLElement {
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("data-state", "open");
  if (scoped) {
    const scope = document.createElement("div");
    scope.setAttribute("data-tile-find-scope", "");
    scope.appendChild(dialog);
    root.appendChild(scope);
  } else {
    root.appendChild(dialog);
  }
  return dialog;
}

/** Let the MutationObserver's queued microtask deliver its records. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("TileFindOwnerBridge dom-dialog detection", () => {
  afterEach(() => {
    cleanup();
    useTileFindStore.setState(useTileFindStore.getInitialState(), true);
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("blocks on an open, unscoped dialog under #root and clears once it closes", async () => {
    renderBridge();
    const root = createAppRoot();
    await settle();
    expect(currentBlockerReason()).toBe(null);

    const dialog = appendDialog(false, root);
    await settle();
    expect(currentBlockerReason()).toBe("dom-dialog");

    dialog.setAttribute("data-state", "closed");
    await settle();
    expect(currentBlockerReason()).toBe(null);
  });

  it("exempts a dialog rendered under [data-tile-find-scope], even while open", async () => {
    renderBridge();
    const root = createAppRoot();
    await settle();

    appendDialog(true, root);
    await settle();
    expect(currentBlockerReason()).toBe(null);
  });

  it("detects a role removal via attributeOldValue, not only additions/removals", async () => {
    renderBridge();
    const root = createAppRoot();
    const dialog = appendDialog(false, root);
    await settle();
    expect(currentBlockerReason()).toBe("dom-dialog");

    // The node is never removed from the DOM - only its `role` goes away.
    // Detecting this needs `attributeOldValue`, since after the mutation the
    // attribute filter (`role`) no longer matches the target at all.
    dialog.removeAttribute("role");
    await settle();
    expect(currentBlockerReason()).toBe(null);
  });

  it("removing the dialog node itself (not just its role) also clears the blocker", async () => {
    renderBridge();
    const root = createAppRoot();
    const dialog = appendDialog(false, root);
    await settle();
    expect(currentBlockerReason()).toBe("dom-dialog");

    dialog.remove();
    await settle();
    expect(currentBlockerReason()).toBe(null);
  });

  it("still re-queries for a data-state flip on an already-present dialog", async () => {
    renderBridge();
    const root = createAppRoot();
    const dialog = appendDialog(false, root);
    dialog.setAttribute("data-state", "closed");
    await settle();
    expect(currentBlockerReason()).toBe(null);

    dialog.setAttribute("data-state", "open");
    await settle();
    expect(currentBlockerReason()).toBe("dom-dialog");
  });

  it("during unrelated #root churn, notifies neither the store nor a document-wide query, then still detects a nested dialog opening and closing", async () => {
    renderBridge();
    const root = createAppRoot();
    await settle();

    const storeListener = vi.fn();
    const unsubscribe = useTileFindStore.subscribe(storeListener);
    const querySpy = vi.spyOn(document, "querySelectorAll");

    // The shape of streaming chat content landing under #root: plain
    // element/text churn, nothing role- or dialog-related.
    const streamingHost = document.createElement("div");
    root.appendChild(streamingHost);
    streamingHost.appendChild(document.createElement("span"));
    streamingHost.textContent = "streaming content";
    await settle();

    // Falsification: an observer that still re-queries on every mutation
    // (the pre-fix behavior) calls this, and notifies the store, at least
    // once here.
    expect(querySpy).not.toHaveBeenCalled();
    expect(storeListener).not.toHaveBeenCalled();

    const dialog = appendDialog(false, root);
    await settle();
    expect(currentBlockerReason()).toBe("dom-dialog");
    expect(storeListener).toHaveBeenCalled();

    dialog.remove();
    await settle();
    expect(currentBlockerReason()).toBe(null);

    unsubscribe();
    querySpy.mockRestore();
  });
});
