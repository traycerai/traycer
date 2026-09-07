import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

/**
 * A composer pin written by one browser tab must not be visible to another. Assert invisibility, not merely distinct key strings.
 */
const tabIdRef = vi.hoisted(() => ({ value: "tab-1" }));
/** The real module's subscriber set, so a case can drive a regeneration. */
const identity = vi.hoisted(() => ({ listeners: new Set<() => void>() }));

vi.mock("@/lib/browser-tab-identity", () => ({
  browserTabId: () => tabIdRef.value,
  subscribeBrowserTabId: (listener: () => void) => {
    identity.listeners.add(listener);
    return () => {
      identity.listeners.delete(listener);
    };
  },
}));

/** A duplicated tab claiming this tab's id, as the real claim channel delivers it: the id changes and subscribers are notified, with NO render of this tab's own doing anywhere in the sequence. */
function regenerateTabId(next: string): void {
  tabIdRef.value = next;
  act(() => {
    for (const listener of identity.listeners) listener();
  });
}

// No desktop windows bridge - this is the browser path the defect lived on.
vi.mock("@/providers/windows-bridge-context", () => ({
  useWindowsBridge: () => null,
}));

import { useComposerSurfaceHostKey } from "@/hooks/host/use-composer-surface-host-pin";
import { useSurfaceHostSelectionStore } from "@/stores/host/surface-host-selection-store";

function keyForTab(tabId: string): string {
  tabIdRef.value = tabId;
  const { result, unmount } = renderHook(() => useComposerSurfaceHostKey());
  const key = result.current;
  unmount();
  return key;
}

beforeEach(() => {
  useSurfaceHostSelectionStore.setState({ selections: {} });
});

afterEach(() => {
  cleanup();
  identity.listeners.clear();
  tabIdRef.value = "tab-1";
  useSurfaceHostSelectionStore.setState({ selections: {} });
});

describe("the browser composer pin is per tab", () => {
  it("does not show one tab's pin to another tab", () => {
    const firstTabKey = keyForTab("tab-1");
    const secondTabKey = keyForTab("tab-2");

    useSurfaceHostSelectionStore
      .getState()
      .setSelection(firstTabKey, "host-picked-in-tab-1");

    const selections = useSurfaceHostSelectionStore.getState().selections;
    expect(selections[firstTabKey]).toBe("host-picked-in-tab-1");
    // ...and the second tab has none, so it follows its own effective host.
    expect(selections[secondTabKey]).toBeUndefined();
  });

  it("gives the SAME tab the same key across renders, so a reload keeps its pin", () => {
    // The other half of the contract, and the one a per-call random id would break while still passing the case above: identity must be stable for the tab's lifetime, or every render mints a fresh key and the pin the user just chose is invisible to the next paint.
    expect(keyForTab("tab-1")).toBe(keyForTab("tab-1"));
  });

  it("stops reading the duplicate's pin the moment a MOUNTED tab regenerates", () => {
    // After a duplicate, the original must stop resolving the shared pin. Assert invisibility, not merely distinct keys.
    tabIdRef.value = "tab-original";
    const { result } = renderHook(() => useComposerSurfaceHostKey());
    const sharedKey = result.current;
    act(() => {
      useSurfaceHostSelectionStore.getState().setSelection(sharedKey, "host-a");
    });

    regenerateTabId("tab-regenerated");

    const selections = useSurfaceHostSelectionStore.getState().selections;
    // This tab, with no render of its own in between, has left the shared key.
    expect(result.current).not.toBe(sharedKey);
    // Both sides are asserted because either alone passes a build that is wrong in the other direction: the pin is readable under the new key, and gone from the old one - so the duplicate, which is now addressing that old key, inherits nothing it never chose.
    expect(selections[result.current]).toBe("host-a");
    expect(selections[sharedKey]).toBeUndefined();
  });

  it("keeps the desktop path on its bridge window id", async () => {
    // Desktop already had stable, finite per-window ids and no bug.
    vi.resetModules();
    vi.doMock("@/providers/windows-bridge-context", () => ({
      useWindowsBridge: () => ({ windowId: "desktop-window-7" }),
    }));
    const { useComposerSurfaceHostKey: useKeyOnDesktop } =
      await import("@/hooks/host/use-composer-surface-host-pin");

    tabIdRef.value = "tab-should-be-ignored";
    const { result } = renderHook(() => useKeyOnDesktop());

    expect(result.current).toContain("desktop-window-7");
    expect(result.current).not.toContain("tab-should-be-ignored");
  });
});
