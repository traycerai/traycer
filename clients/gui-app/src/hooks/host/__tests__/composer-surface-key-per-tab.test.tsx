import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";

/**
 * Two browser tabs must not share a composer host pin.
 *
 * Every browser tab used to resolve the literal surface key `"browser"`, and
 * the pin store persists to `localStorage` - which is origin-wide, not per-tab.
 * So a pin chosen in one tab was hydrated by the next tab opened or reloaded.
 * The composer is PLACEMENT: its resolved host decides where a new epic or
 * chat lives for life, so that tab created work on a machine a DIFFERENT
 * window had picked.
 *
 * The assertion is that a pin written by one tab is NOT VISIBLE to the other -
 * not that the two keys are different strings. Distinct keys are how the fix
 * happens to work; invisibility of one tab's pin to another is what the defect
 * was about, and a future change that made the keys differ while both still
 * resolved to one stored entry would pass a string comparison.
 */
const tabIdRef = vi.hoisted(() => ({ value: "tab-1" }));

vi.mock("@/lib/browser-tab-identity", () => ({
  browserTabId: () => tabIdRef.value,
}));

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
    // The pin the first tab chose is its own...
    expect(selections[firstTabKey]).toBe("host-picked-in-tab-1");
    // ...and the second tab has none, so it follows its own effective host.
    expect(selections[secondTabKey]).toBeUndefined();
  });

  it("gives the SAME tab the same key across renders, so a reload keeps its pin", () => {
    // The other half of the contract, and the one a per-call random id would
    // break while still passing the case above: identity must be stable for
    // the tab's lifetime, or every render mints a fresh key and the pin the
    // user just chose is invisible to the next paint.
    expect(keyForTab("tab-1")).toBe(keyForTab("tab-1"));
  });

  it("keeps the desktop path on its bridge window id", async () => {
    // Desktop already had stable, finite per-window ids and no bug. If the
    // browser fallback started applying there, every desktop window would key
    // by a browser tab id instead - silently re-pointing pins that were
    // correct.
    vi.resetModules();
    vi.doMock("@/providers/windows-bridge-context", () => ({
      useWindowsBridge: () => ({ windowId: "desktop-window-7" }),
    }));
    const { useComposerSurfaceHostKey: useKeyOnDesktop } = await import(
      "@/hooks/host/use-composer-surface-host-pin"
    );

    tabIdRef.value = "tab-should-be-ignored";
    const { result } = renderHook(() => useKeyOnDesktop());

    expect(result.current).toContain("desktop-window-7");
    expect(result.current).not.toContain("tab-should-be-ignored");
  });
});
