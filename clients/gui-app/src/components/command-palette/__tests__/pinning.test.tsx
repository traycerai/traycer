import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { CommandPaletteRoot } from "@/providers/command-palette-provider";
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";
import { useCommandPaletteStore } from "@/stores/command-palette/command-palette-store";

function noopRouter(): KeybindingRouter {
  return {
    getPathname: () => "/",
    navigateHome: () => undefined,
    navigateSettings: () => undefined,
    navigateToEpic: () => undefined,
    navigateToEpicTab: () => undefined,
    navigateToEpicList: () => undefined,
    navigateSettingsSection: () => undefined,
    navigateToTabIntent: () => undefined,
    goBack: () => undefined,
    goForward: () => undefined,
    isHistoryNavAvailable: () => false,
    canGoBack: () => false,
    canGoForward: () => false,
  };
}

function wrap(children: ReactNode): ReactNode {
  return (
    <CommandPaletteRoot adapter={noopRouter()}>{children}</CommandPaletteRoot>
  );
}

function resetStore(): void {
  useCommandPaletteStore.setState({
    open: false,
    query: "",
    recentIds: [],
    pinnedIds: [],
  });
}

describe("pinning in palette shell", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetStore();
  });

  afterEach(() => {
    cleanup();
    resetStore();
  });

  it("clicking a pin toggle adds the id to the store's pinnedIds", async () => {
    render(wrap(<div>app</div>));
    act(() => {
      useCommandPaletteStore.getState().setOpen(true);
    });
    const pinButton = await screen.findByTestId(
      "command-palette-pin-nav:epics",
    );
    fireEvent.pointerDown(pinButton);
    expect(useCommandPaletteStore.getState().pinnedIds).toContain("nav:epics");
  });

  it("clicking pin on an already-pinned item removes it", async () => {
    useCommandPaletteStore.setState({ pinnedIds: ["nav:epics"] });
    render(wrap(<div>app</div>));
    act(() => {
      useCommandPaletteStore.getState().setOpen(true);
    });
    const pinButton = await screen.findByTestId(
      "command-palette-pin-nav:epics",
    );
    fireEvent.pointerDown(pinButton);
    expect(useCommandPaletteStore.getState().pinnedIds).not.toContain(
      "nav:epics",
    );
  });

  it("pin action does not dispatch the underlying command", async () => {
    render(wrap(<div>app</div>));
    act(() => {
      useCommandPaletteStore.getState().setOpen(true);
    });
    const pinButton = await screen.findByTestId(
      "command-palette-pin-nav:epics",
    );
    fireEvent.pointerDown(pinButton);
    // Palette stays open - dispatch closes on success. Pin alone
    // must not close.
    expect(useCommandPaletteStore.getState().open).toBe(true);
  });
});
