import "../../../../../__tests__/test-browser-apis";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ReservedBrowserChordsBridge } from "@/components/layout/bridges/reserved-browser-chords-bridge";
import { FakeBrowserViewBridge } from "@/lib/browser-view/__tests__/fake-browser-view-bridge";
import { reservedBrowserChordsFor } from "@/lib/browser-view/reserved-chords-registration";
import { getDefaultBindings } from "@/lib/keybindings/actions";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import type { TabStripItem } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import { createFakeRunnerHost } from "../../../../../__tests__/create-fake-runner-host";

// The default layout is a Start Page owning the screen, which every case here
// assumes unless it puts an epic there itself.
const INITIAL_TABS_LAYOUT = {
  items: useTabsStore.getState().items,
  activeItemId: useTabsStore.getState().activeItemId,
};
const EPIC_TAB: TabStripItem = {
  kind: "tab",
  id: "item-epic-a",
  ref: { kind: "epic", id: "epic-a" },
};

afterEach(() => {
  cleanup();
  act(() => {
    useKeybindingStore.setState({ bindings: getDefaultBindings() });
    useTabsStore.setState(INITIAL_TABS_LAYOUT);
  });
});

function renderBridge(bridge: FakeBrowserViewBridge): void {
  render(
    <RunnerHostProvider
      runnerHost={createFakeRunnerHost({ browserView: bridge })}
    >
      <ReservedBrowserChordsBridge />
    </RunnerHostProvider>,
  );
}

function tokensOf(
  chords: ReadonlyArray<{ readonly token: string }> | undefined,
): readonly string[] {
  return (chords ?? []).map((chord) => chord.token);
}

describe("<ReservedBrowserChordsBridge />", () => {
  it("pushes the reserved-chord table into main when a browserView exists", () => {
    const bridge = new FakeBrowserViewBridge();
    renderBridge(bridge);

    expect(bridge.reservedChordsCalls).toEqual([
      reservedBrowserChordsFor(useKeybindingStore.getState().bindings, {
        landingSurfaceActive: true,
      }),
    ]);
  });
});

/**
 * The reserved-chord policy is derived from the reader's live bindings, so the
 * bridge has to keep pushing it - registration is the ONLY copy of those
 * bindings in the guest input path, and main holds whatever it was last told.
 * A one-shot registration keyed on the runner host reads as correct and leaves
 * a rebind half-done: the app renderer honours the new chord, the focused tile
 * still claiming the old one.
 */
describe("<ReservedBrowserChordsBridge /> rebinds", () => {
  it("re-pushes the policy when a forwarded action is rebound", async () => {
    const bridge = new FakeBrowserViewBridge();
    renderBridge(bridge);

    await waitFor(() => {
      expect(bridge.reservedChordsCalls).toHaveLength(1);
    });
    expect(tokensOf(bridge.reservedChordsCalls[0])).toContain("mod+shift+w");

    act(() => {
      useKeybindingStore.getState().setBinding("epic.close", "mod+shift+e");
    });

    await waitFor(() => {
      expect(bridge.reservedChordsCalls).toHaveLength(2);
    });
    const latest = tokensOf(bridge.reservedChordsCalls[1]);
    expect(latest).toContain("mod+shift+e");
    expect(latest).not.toContain("mod+shift+w");
  });

  it("drops an unbound action's chord from the pushed policy", async () => {
    const bridge = new FakeBrowserViewBridge();
    renderBridge(bridge);

    await waitFor(() => {
      expect(bridge.reservedChordsCalls).toHaveLength(1);
    });
    expect(tokensOf(bridge.reservedChordsCalls[0])).toContain("mod+j");

    act(() => {
      useKeybindingStore.getState().clearBinding("app.terminal.toggle");
    });

    await waitFor(() => {
      expect(bridge.reservedChordsCalls).toHaveLength(2);
    });
    const latest = tokensOf(bridge.reservedChordsCalls[1]);
    expect(latest).not.toContain("mod+j");
    // The browser's own rows are not bindings and never move.
    expect(latest).toContain("mod+w");
  });
});

/**
 * The Start Page panel's three are forwarded only while the panel has a
 * handler for them, which is while the Start Page owns the screen. Main's
 * table is per window: an epic canvas's guest would otherwise lose those keys
 * to a replay no handler answers.
 */
describe("<ReservedBrowserChordsBridge /> surfaces", () => {
  it("stops forwarding the panel's chords when an epic takes the screen, and resumes when it leaves", async () => {
    const bridge = new FakeBrowserViewBridge();
    renderBridge(bridge);

    await waitFor(() => {
      expect(bridge.reservedChordsCalls).toHaveLength(1);
    });
    expect(tokensOf(bridge.reservedChordsCalls[0])).toContain("mod+alt+b");

    act(() => {
      useTabsStore.setState({ items: [EPIC_TAB], activeItemId: EPIC_TAB.id });
    });

    await waitFor(() => {
      expect(bridge.reservedChordsCalls).toHaveLength(2);
    });
    const onEpic = tokensOf(bridge.reservedChordsCalls[1]);
    for (const token of ["mod+alt+b", "mod+shift+j", "mod+j"]) {
      expect(onEpic).not.toContain(token);
    }
    // App-level forwarding and the browser's own rows are unchanged.
    expect(onEpic).toContain("mod+shift+w");
    expect(onEpic).toContain("mod+w");

    act(() => {
      useTabsStore.setState(INITIAL_TABS_LAYOUT);
    });

    await waitFor(() => {
      expect(bridge.reservedChordsCalls).toHaveLength(3);
    });
    expect(tokensOf(bridge.reservedChordsCalls[2])).toContain("mod+alt+b");
  });
});
