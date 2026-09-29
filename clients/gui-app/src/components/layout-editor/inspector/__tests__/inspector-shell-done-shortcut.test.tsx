import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InspectorShell } from "@/components/layout-editor/inspector/inspector-shell";
import { formatChordForDisplay } from "@/lib/keybindings/chord";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";

/**
 * The Done menu's shortcut is the user's CURRENT close-tab binding, the chord
 * `closeLayoutEditorForCloseTabChord` actually answers to, not a fixed ⌘W.
 */
async function openDoneMenu(): Promise<HTMLElement> {
  render(<InspectorShell onExit={() => {}}>{null}</InspectorShell>);
  fireEvent.click(screen.getByRole("button", { name: "More ways out" }));
  return screen.findByRole("menuitem", { name: /^Done/ });
}

beforeEach(() => {
  window.localStorage.clear();
  useLayoutEditorStore.getState().endSession();
  useKeybindingStore.getState().resetAll();
});

afterEach(() => {
  cleanup();
  useKeybindingStore.getState().resetAll();
  useLayoutEditorStore.getState().endSession();
});

describe("inspector Done menu shortcut", () => {
  it("shows the chord tab.close is currently bound to", async () => {
    act(() => {
      useKeybindingStore.getState().setBinding("tab.close", "mod+shift+q");
    });

    const item = await openDoneMenu();

    expect(item.textContent).toContain(formatChordForDisplay("mod+shift+q"));
    expect(item.textContent).not.toContain(formatChordForDisplay("mod+w"));
  });

  it("shows no shortcut when tab.close is unbound", async () => {
    act(() => {
      useKeybindingStore.getState().clearBinding("tab.close");
    });

    const item = await openDoneMenu();

    expect(item.textContent).toBe("Done");
  });
});
