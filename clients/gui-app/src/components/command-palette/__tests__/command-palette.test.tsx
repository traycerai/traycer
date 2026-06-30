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
import {
  dispatchAction,
  type KeybindingRouter,
} from "@/lib/keybindings/dispatch";
import { runCommandItem } from "@/lib/commands/dispatch";
import type { CommandContext, CommandItem } from "@/lib/commands/types";
import { useCommandPaletteStore } from "@/stores/command-palette/command-palette-store";

function resetStore(): void {
  useCommandPaletteStore.setState({
    open: false,
    query: "",
    recentIds: [],
    pinnedIds: [],
  });
}

function noopRouter(pathname: string): KeybindingRouter {
  return {
    getPathname: () => pathname,
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
    <CommandPaletteRoot adapter={noopRouter("/")}>
      {children}
    </CommandPaletteRoot>
  );
}

function getVisibleCommandRows(root: ParentNode): ReadonlyArray<HTMLElement> {
  return Array.from(
    root.querySelectorAll<HTMLElement>('[data-slot="command-item"]'),
  ).filter((row) => row.closest("[hidden]") === null);
}

function installPaletteListLayout(
  list: HTMLElement,
  rows: ReadonlyArray<HTMLElement>,
): void {
  Object.defineProperty(list, "clientHeight", {
    configurable: true,
    value: 144,
  });
  rows.forEach((row) => {
    Object.defineProperty(row, "offsetHeight", {
      configurable: true,
      value: 36,
    });
  });
}

function getCommandSearchInput(): HTMLElement {
  return screen.getByRole("combobox", { name: "Search commands" });
}

describe("<CommandPalette />", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetStore();
  });

  afterEach(() => {
    cleanup();
    resetStore();
  });

  it("is closed by default and the list is not in the DOM", () => {
    render(wrap(<div>app</div>));
    expect(screen.queryByTestId("command-palette-list")).toBeNull();
  });

  it("opens when the store flips to open", async () => {
    render(wrap(<div>app</div>));
    act(() => {
      useCommandPaletteStore.getState().setOpen(true);
    });
    expect(await screen.findByTestId("command-palette-list")).not.toBeNull();
    // Nav source always emits Open App Settings on a
    // non-`/settings` route; assert it renders as a smoke test
    // that sources are wired.
    expect(await screen.findByText("Open App Settings")).not.toBeNull();
  });

  it("shows a selected row for hover and arrow-key navigation", async () => {
    render(wrap(<div>app</div>));
    act(() => {
      useCommandPaletteStore.getState().setOpen(true);
    });
    await screen.findByTestId("command-palette-list");

    const firstRows = getVisibleCommandRows(document.body);
    expect(firstRows.length).toBeGreaterThan(1);
    expect(firstRows[0].className).toContain("data-selected:bg-primary/12");
    await waitFor(() => {
      expect(firstRows[0].getAttribute("data-selected")).toBe("true");
    });

    fireEvent.keyDown(getCommandSearchInput(), {
      key: "ArrowDown",
    });
    await waitFor(() => {
      expect(firstRows[1].getAttribute("data-selected")).toBe("true");
    });

    fireEvent.pointerMove(firstRows[0]);
    await waitFor(() => {
      expect(firstRows[0].getAttribute("data-selected")).toBe("true");
    });
  });

  it("moves the selected row by a viewport with PageUp and PageDown", async () => {
    render(wrap(<div>app</div>));
    act(() => {
      useCommandPaletteStore.getState().setOpen(true);
    });
    const list = await screen.findByTestId("command-palette-list");

    const rows = getVisibleCommandRows(document.body);
    expect(rows.length).toBeGreaterThan(3);
    installPaletteListLayout(list, rows);
    await waitFor(() => {
      expect(rows[0].getAttribute("data-selected")).toBe("true");
    });

    const input = getCommandSearchInput();
    fireEvent.keyDown(input, { key: "PageDown" });
    await waitFor(() => {
      expect(rows[3].getAttribute("data-selected")).toBe("true");
    });

    fireEvent.keyDown(input, { key: "PageUp" });
    await waitFor(() => {
      expect(rows[0].getAttribute("data-selected")).toBe("true");
    });
  });

  it("skips hidden rows when moving the selected row by a viewport", async () => {
    render(wrap(<div>app</div>));
    act(() => {
      useCommandPaletteStore.getState().setOpen(true);
    });
    const list = await screen.findByTestId("command-palette-list");

    const rows = getVisibleCommandRows(document.body);
    expect(rows.length).toBeGreaterThan(4);
    installPaletteListLayout(list, rows);
    rows[1].hidden = true;
    await waitFor(() => {
      expect(rows[0].getAttribute("data-selected")).toBe("true");
    });

    fireEvent.keyDown(getCommandSearchInput(), {
      key: "PageDown",
    });
    await waitFor(() => {
      expect(rows[4].getAttribute("data-selected")).toBe("true");
    });
  });

  it("closes when the store flips to closed", async () => {
    render(wrap(<div>app</div>));
    act(() => {
      useCommandPaletteStore.getState().setOpen(true);
    });
    await screen.findByTestId("command-palette-list");
    act(() => {
      useCommandPaletteStore.getState().setOpen(false);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("command-palette-list")).toBeNull();
    });
  });

  it("the global palette never shows the in-pane opener categories", async () => {
    // The opener now renders inline in empty panes (pane-opener.tsx), never in
    // the modal ⌘K palette.
    render(wrap(<div>app</div>));
    act(() => {
      useCommandPaletteStore.getState().setOpen(true);
    });
    await screen.findByTestId("command-palette-list");
    expect(screen.queryByText("Open into pane")).toBeNull();
    expect(await screen.findByText("Open App Settings")).not.toBeNull();
  });

  it("registers the app.palette.open action handler while mounted", () => {
    render(wrap(<div>app</div>));
    const router = noopRouter("/");

    act(() => {
      const first = dispatchAction("app.palette.open", router);
      expect(first).toBe(true);
    });
    expect(useCommandPaletteStore.getState().open).toBe(true);

    act(() => {
      const second = dispatchAction("app.palette.open", router);
      expect(second).toBe(true);
    });
    expect(useCommandPaletteStore.getState().open).toBe(false);
  });

  it("the palette opener action no-ops cleanly after unmount", () => {
    const { unmount } = render(wrap(<div>app</div>));
    unmount();
    const router = noopRouter("/");
    const fired = dispatchAction("app.palette.open", router);
    expect(fired).toBe(false);
    expect(useCommandPaletteStore.getState().open).toBe(false);
  });
});

describe("runCommandItem", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetStore();
  });

  afterEach(() => {
    resetStore();
  });

  it("runs a non-action item, records its id, and closes the palette", async () => {
    let ran = false;
    const item: CommandItem = {
      id: "test.item",
      label: "Test",
      description: null,
      keywords: [],
      group: "actions",
      scope: "actions",
      shortcut: null,
      actionId: null,
      subpage: null,
      run: () => {
        ran = true;
      },
    };
    const ctx: CommandContext = {
      pathname: "/",
      router: noopRouter("/"),
      activeTabId: null,
      activeEpicId: null,
      focusedComposerKind: null,
      targetGroupId: null,
    };

    const recorded: Array<string> = [];
    let closed = 0;
    await runCommandItem(item, ctx, {
      recordUse: (id) => recorded.push(id),
      close: () => {
        closed += 1;
      },
    });

    expect(ran).toBe(true);
    expect(recorded).toEqual(["test.item"]);
    expect(closed).toBe(1);
  });

  it("always closes even when the item handler throws", async () => {
    const item: CommandItem = {
      id: "boom",
      label: "Boom",
      description: null,
      keywords: [],
      group: "actions",
      scope: "actions",
      shortcut: null,
      actionId: null,
      subpage: null,
      run: () => {
        throw new Error("kaboom");
      },
    };
    const ctx: CommandContext = {
      pathname: "/",
      router: noopRouter("/"),
      activeTabId: null,
      activeEpicId: null,
      focusedComposerKind: null,
      targetGroupId: null,
    };

    const recorded: Array<string> = [];
    let closed = 0;
    await expect(
      runCommandItem(item, ctx, {
        recordUse: (id) => recorded.push(id),
        close: () => {
          closed += 1;
        },
      }),
    ).rejects.toThrow("kaboom");

    expect(recorded).toEqual([]);
    expect(closed).toBe(1);
  });
});
