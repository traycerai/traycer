import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import {
  CommandPaletteShell,
  RootView,
  type PaletteRootListProps,
} from "@/components/command-palette/command-palette-shell";
import { customizeSource } from "@/lib/commands/sources/customize.source";
import type { OpenLayoutEditorInput } from "@/lib/layout/editor-session";
import type { CommandContext, CommandItem } from "@/lib/commands/types";
import { useCommandPaletteStore } from "@/stores/command-palette/command-palette-store";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import { setMobileApp } from "@/lib/mobile-app";

const openLayoutEditorMock = vi.hoisted(() =>
  vi.fn<(input: OpenLayoutEditorInput) => boolean>(),
);

// No `@tanstack/react-router` mock: the source takes `ctx.router`, never
// `useNavigate()`, precisely because the palette mounts above
// `RouterProvider`. Rendering these tests with no router mock and no
// `<RouterProvider>` in the tree is itself the proof - a stray `useNavigate()`
// would throw "outside a <RouterProvider>" rather than fail an assertion.
vi.mock("@/lib/layout/editor-session", () => ({
  openLayoutEditor: openLayoutEditorMock,
}));

function ctx(): CommandContext {
  return {
    pathname: "/",
    router: {
      getPathname: () => "/",
      navigateHome: () => undefined,
      navigateSettings: () => undefined,
      navigateToEpic: () => undefined,
      navigateToEpicTab: () => undefined,
      navigateToEpicList: () => undefined,
      navigateSettingsSection: () => undefined,
      navigateToTabIntent: vi.fn(),
      goBack: () => undefined,
      goForward: () => undefined,
      isHistoryNavAvailable: () => false,
      canGoBack: () => false,
      canGoForward: () => false,
    },
    activeTabId: null,
    activeEpicId: null,
    focusedComposerKind: null,
    targetGroupId: null,
  };
}

function items(): ReadonlyArray<CommandItem> {
  let captured: ReadonlyArray<CommandItem> = [];
  function Probe() {
    captured = customizeSource.useItems(ctx());
    return null;
  }
  render(<Probe />);
  return captured;
}

/** The palette as the app mounts it, with this source as its only one. */
function PaletteRootList(props: PaletteRootListProps): ReactNode {
  const items = customizeSource.useItems(props.ctx);
  return <RootView {...props} items={items} loading={false} />;
}

function renderPalette(): void {
  useCommandPaletteStore.setState({
    open: true,
    query: "",
    recentIds: [],
    pinnedIds: [],
  });
  render(<CommandPaletteShell ctx={ctx()} RootList={PaletteRootList} />);
}

function resetPalette(): void {
  useCommandPaletteStore.setState({
    open: false,
    query: "",
    recentIds: [],
    pinnedIds: [],
  });
}

beforeEach(() => {
  resetPalette();
  useLayoutEditorStore.setState({ session: null, lockedBy: "none" });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  setMobileApp(false);
  resetPalette();
  useLayoutEditorStore.setState({ session: null, lockedBy: "none" });
});

describe("customizeSource", () => {
  it("offers only Layout settings in the installed app, where the editor can never open", () => {
    setMobileApp(true);

    expect(items().map((item) => item.id)).toEqual([
      "customize:layout-settings",
    ]);
  });

  it("opens the editor through the door, as a keyboard entry, with the palette's own navigateToTabIntent", () => {
    const [item, settingsItem, ...rest] = items();
    expect(rest).toEqual([]);
    expect(item.label).toBe("Customize layout");
    expect(item.disabled).toBeUndefined();

    const runCtx = ctx();
    void item.run(runCtx);

    expect(openLayoutEditorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "command_palette",
        // The palette is reached by typing, and the entry method gates the
        // View Transition as well as being reported (L-30, L-54).
        entry: "keyboard",
        target: null,
        origin: { kind: "tab" },
        // `ctx.router`, never `useNavigate()`: the palette mounts above
        // `RouterProvider`, where the hook has no router to navigate with.
        navigateToTabIntent: runCtx.router.navigateToTabIntent,
      }),
    );

    // What the door was handed reaches the palette router adapter's own
    // `navigateToTabIntent` when called, carrying the sample-workspace intent.
    const passed =
      openLayoutEditorMock.mock.calls.at(-1)?.[0]?.navigateToTabIntent;
    passed?.({ kind: "sample-workspace" });
    expect(runCtx.router.navigateToTabIntent).toHaveBeenCalledWith({
      kind: "sample-workspace",
    });

    // The palette's second layout door: the same form, reached via Settings.
    expect(settingsItem.id).toBe("customize:layout-settings");
    expect(settingsItem.label).toBe("Layout settings");
  });

  it("offers nothing from inside a session", () => {
    useLayoutEditorStore.setState({
      session: {
        entry: "pointer",
        source: "direct_ui",
        startedAt: 0,
        origin: { kind: "tab" },
      },
    });

    expect(items()).toEqual([]);
  });

  // The door declines while another window holds the lease (L-32), so the row
  // says why instead of being a press that does nothing.
  it("explains itself rather than acting while another window holds it, and offers only that one item", () => {
    useLayoutEditorStore.setState({ lockedBy: "other-window" });
    const [item, ...rest] = items();

    expect(rest).toEqual([]);
    expect(item.disabled).toBe(true);
    expect(item.description).toContain("another window");

    void item.run(ctx());

    expect(openLayoutEditorMock).not.toHaveBeenCalled();
  });
});

/**
 * LV2-07 said a real left click on this row did nothing while Enter on the
 * same row opened a session, so the row is driven here as a POINTER rather
 * than through `item.run`: the palette mounted, the row found by its label,
 * and an ordinary `click` on it.
 */
describe("the row under a mouse", () => {
  it("runs the item and closes the palette on a click", async () => {
    renderPalette();

    fireEvent.click(await screen.findByText("Customize layout"));

    expect(openLayoutEditorMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ source: "command_palette", target: null }),
    );
    await waitFor(() => {
      expect(useCommandPaletteStore.getState().open).toBe(false);
    });
  });

  it("does nothing when the row is the disabled one (L-32)", async () => {
    useLayoutEditorStore.setState({ lockedBy: "other-window" });
    renderPalette();

    fireEvent.click(await screen.findByText("Customize layout"));

    expect(openLayoutEditorMock).not.toHaveBeenCalled();
    expect(useCommandPaletteStore.getState().open).toBe(true);
  });
});
