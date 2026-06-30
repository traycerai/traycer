import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { CommandPaletteRoot } from "@/providers/command-palette-provider";
import { getDefaultBindings } from "@/lib/keybindings/actions";
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";
import { useCommandPaletteStore } from "@/stores/command-palette/command-palette-store";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import { useSettingsStore } from "@/stores/settings/settings-store";

interface RouterCalls {
  settingsSection: Array<string>;
  epicList: number;
}

function buildRouter(calls: RouterCalls): KeybindingRouter {
  return {
    getPathname: () => "/",
    navigateHome: () => undefined,
    navigateSettings: () => undefined,
    navigateToEpic: () => undefined,
    navigateToEpicTab: () => undefined,
    navigateToEpicList: () => {
      calls.epicList += 1;
    },
    navigateSettingsSection: (sectionId) => {
      calls.settingsSection.push(sectionId);
    },
    navigateToTabIntent: () => undefined,
    goBack: () => undefined,
    goForward: () => undefined,
    isHistoryNavAvailable: () => false,
    canGoBack: () => false,
    canGoForward: () => false,
  };
}

function wrap(router: KeybindingRouter, children: ReactNode): ReactNode {
  return <CommandPaletteRoot adapter={router}>{children}</CommandPaletteRoot>;
}

function resetStores(): void {
  useCommandPaletteStore.setState({
    open: false,
    query: "",
    recentIds: [],
    pinnedIds: [],
  });
  useKeybindingStore.setState({ bindings: getDefaultBindings() });
  useSettingsStore.getState().setTheme("system");
}

describe("CommandPalette dispatch", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetStores();
  });

  afterEach(() => {
    cleanup();
    resetStores();
  });

  it("selecting a theme sub-page item flips the theme and records the use", async () => {
    const router = buildRouter({ settingsSection: [], epicList: 0 });
    render(wrap(router, <div>app</div>));
    act(() => {
      useCommandPaletteStore.getState().setOpen(true);
    });
    // Theme lives inside a sub-page - click the root entry first.
    fireEvent.click(await screen.findByText("Change theme"));
    fireEvent.click(await screen.findByText("Dark"));
    await waitFor(() => {
      expect(useCommandPaletteStore.getState().recentIds[0]).toBe("theme:dark");
    });
    expect(useSettingsStore.getState().theme).toBe("dark");
    expect(useCommandPaletteStore.getState().open).toBe(false);
  });

  it("selecting the Open Tasks nav item calls navigateToEpicList", async () => {
    const calls: RouterCalls = { settingsSection: [], epicList: 0 };
    const router = buildRouter(calls);
    render(wrap(router, <div>app</div>));
    act(() => {
      useCommandPaletteStore.getState().setOpen(true);
    });
    fireEvent.click(await screen.findByText("Open Tasks"));
    await waitFor(() => {
      expect(useCommandPaletteStore.getState().recentIds[0]).toBe("nav:epics");
    });
    expect(calls.epicList).toBe(1);
  });

  it("selecting the keybindings help item deep-links to the settings section", async () => {
    const calls: RouterCalls = { settingsSection: [], epicList: 0 };
    const router = buildRouter(calls);
    render(wrap(router, <div>app</div>));
    act(() => {
      useCommandPaletteStore.getState().setOpen(true);
    });
    const row = await screen.findByText("Open keybindings reference");
    fireEvent.click(row);
    await waitFor(() => {
      expect(calls.settingsSection).toEqual(["keybindings"]);
    });
  });

  it("renders the Recent group at the top when a recent id is set and the query is empty", async () => {
    const router = buildRouter({ settingsSection: [], epicList: 0 });
    render(wrap(router, <div>app</div>));
    // Use a root-level id so the recents bucket resolves through
    // the pool; sub-page leaf ids don't appear at the root.
    useCommandPaletteStore.setState({ recentIds: ["nav:epics"] });
    act(() => {
      useCommandPaletteStore.getState().setOpen(true);
    });
    // Heading text comes from the "Recent" group label.
    expect(await screen.findByText("Recent")).not.toBeNull();
  });
});
