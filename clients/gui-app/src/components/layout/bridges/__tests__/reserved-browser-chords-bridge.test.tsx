import "../../../../../__tests__/test-browser-apis";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ReservedBrowserChordsBridge } from "@/components/layout/bridges/reserved-browser-chords-bridge";
import { FakeBrowserViewBridge } from "@/lib/browser-view/__tests__/fake-browser-view-bridge";
import { reservedBrowserChordsFor } from "@/lib/browser-view/reserved-chords-registration";
import { getDefaultBindings } from "@/lib/keybindings/actions";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import { createFakeRunnerHost } from "../../../../../__tests__/create-fake-runner-host";

afterEach(() => {
  cleanup();
  act(() => {
    useKeybindingStore.setState({ bindings: getDefaultBindings() });
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
      reservedBrowserChordsFor(useKeybindingStore.getState().bindings),
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
