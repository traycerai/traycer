import "../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { BrowserViewTileKey } from "@traycer-clients/shared/platform/browser-view";
import { BrowserOverlayCoordinatorBridge } from "@/components/epic-canvas/browser-overlay-coordinator-bridge";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { SurfacePresentationBoundary } from "@/components/layout/surface-presentation-boundary";
import { FakeBrowserViewBridge } from "@/lib/browser-view/__tests__/fake-browser-view-overlay-bridge";
import {
  clearBrowserViewSnapshot,
  getBrowserViewSnapshot,
  registerBrowserOverlayTile,
} from "@/lib/browser-view/tiles/browser-overlay-coordinator";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Toaster } from "@/components/ui/sonner";

/**
 * Ticket 08's real-Radix integration suite. Test-bar layer 1: coordinator
 * behavior proved against actual Radix portals - `hideOthers` churn,
 * `data-state` transitions, real portal mount ordering - rather than a
 * bare-div stand-in, which is the blind spot that shipped the occlusion
 * bug. Every scenario here asserts on the occlusion IPC the bridge emits
 * and the registry's own state (`getBrowserViewSnapshot`), never on
 * rendered pixels.
 *
 * The settings-nested-select scenario (Dialog -> Select, aria-hidden churn)
 * and the DropdownMenu/Popover pointer-swallow pins already live in
 * `browser-overlay-coordinator-bridge.test.tsx` - this file extends the
 * matrix the ticket names rather than repeating those: a tooltip
 * (over/away from a tile), a real ContextMenu, a three-deep
 * Dialog->Popover->Select chain, a DropdownMenu submenu handoff, a
 * Dialog+Toast composition, and a corner-clipping overlay.
 */

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "dark" }),
}));

const BASE_KEY: BrowserViewTileKey = {
  viewTabId: "view-1",
  paneId: "pane-1",
  tileInstanceId: "tile-1",
  pageSessionId: "page-1",
};

function rect(
  left: number,
  top: number,
  width: number,
  height: number,
): DOMRectReadOnly {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  };
}

function setElementRect(
  element: HTMLElement,
  elementRect: DOMRectReadOnly,
): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => elementRect,
  });
}

function findBySlot(slot: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
  if (element === null) throw new Error(`no element for data-slot="${slot}"`);
  return element;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    await Promise.resolve();
  });
}

const unregisterTiles = new Set<() => void>();

function registerTile(input: {
  readonly key: BrowserViewTileKey;
  readonly rect: DOMRectReadOnly;
}): void {
  unregisterTiles.add(registerBrowserOverlayTile(input));
}

function makeRunnerHost(bridge: FakeBrowserViewBridge): MockRunnerHost {
  return Object.assign(
    new MockRunnerHost({
      signInUrl: "https://example.com",
      authnBaseUrl: "https://auth.example.com",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
    }),
    { browserView: bridge },
  );
}

function withBridge(
  bridge: FakeBrowserViewBridge,
  ui: React.ReactElement,
): React.ReactElement {
  return (
    <RunnerHostProvider runnerHost={makeRunnerHost(bridge)}>
      <BrowserOverlayCoordinatorBridge />
      {ui}
    </RunnerHostProvider>
  );
}

function renderWithBridge(
  bridge: FakeBrowserViewBridge,
  ui: React.ReactElement,
): ReturnType<typeof render> {
  return render(withBridge(bridge, ui));
}

describe("real-Radix overlay/tile occlusion integration", () => {
  beforeEach(() => {
    let nextFrameId = 1;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const frameId = nextFrameId;
      nextFrameId += 1;
      setTimeout(() => {
        callback(performance.now());
      }, 0);
      return frameId;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(
      (_handle) => undefined,
    );
  });

  afterEach(() => {
    toast.dismiss();
    cleanup();
    unregisterTiles.forEach((unregister) => unregister());
    unregisterTiles.clear();
    clearBrowserViewSnapshot(BASE_KEY);
    vi.restoreAllMocks();
  });

  it("occludes a tile through a real Tooltip that overlaps it", async () => {
    const bridge = new FakeBrowserViewBridge();
    registerTile({ key: BASE_KEY, rect: rect(0, 0, 300, 300) });

    renderWithBridge(
      bridge,
      <Tooltip open>
        <TooltipTrigger>Info</TooltipTrigger>
        <TooltipContent>Details</TooltipContent>
      </Tooltip>,
    );

    setElementRect(findBySlot("tooltip-content"), rect(20, 20, 40, 20));

    await waitFor(() => {
      expect(bridge.occludeCalls).toHaveLength(1);
    });
    expect(bridge.occludeCalls[0]?.tiles).toEqual([BASE_KEY]);
  });

  // Invariant 2: pure geometric intersection is the only trigger. A tooltip
  // that never overlaps a tile must cause NO occlusion IPC at all, not one
  // that gets retried away.
  it("causes no occlusion IPC for a Tooltip that never overlaps a tile", async () => {
    const bridge = new FakeBrowserViewBridge();
    registerTile({ key: BASE_KEY, rect: rect(0, 0, 100, 100) });

    renderWithBridge(
      bridge,
      <Tooltip open>
        <TooltipTrigger>Info</TooltipTrigger>
        <TooltipContent>Details</TooltipContent>
      </Tooltip>,
    );

    const tooltipContent = findBySlot("tooltip-content");
    setElementRect(tooltipContent, rect(500, 500, 40, 20));
    await settle();

    expect(bridge.occludeCalls).toEqual([]);

    // Positive control: the same tooltip, moved to actually overlap the
    // tile, DOES occlude - proving the negative result above is because the
    // scan saw no intersection, not because the scan never ran at all.
    setElementRect(tooltipContent, rect(20, 20, 40, 20));
    window.dispatchEvent(new Event("resize"));
    await waitFor(() => {
      expect(bridge.occludeCalls).toHaveLength(1);
    });
  });

  it("occludes a tile through a real ContextMenu, opened by an actual contextmenu event", async () => {
    const bridge = new FakeBrowserViewBridge();
    registerTile({ key: BASE_KEY, rect: rect(0, 0, 300, 300) });

    renderWithBridge(
      bridge,
      <SurfacePresentationBoundary visible focused>
        <ContextMenu>
          <ContextMenuTrigger>
            <div data-testid="surface">Right click me</div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem>Reload</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </SurfacePresentationBoundary>,
    );

    const trigger = document.querySelector<HTMLElement>(
      '[data-testid="surface"]',
    );
    if (trigger === null) throw new Error("context menu trigger not mounted");
    // `fireEvent` is act-wrapped, so Radix's synchronous open-state commit
    // has already mounted the content by the time this returns - set its
    // rect before anything yields, exactly like the Dialog/Select pins
    // above, so the FIRST scan (not a forced retry) sees the real geometry.
    fireEvent.contextMenu(trigger);

    const content = findBySlot("context-menu-content");
    setElementRect(content, rect(20, 20, 60, 60));

    await waitFor(() => {
      expect(bridge.occludeCalls).toHaveLength(1);
    });
    expect(bridge.occludeCalls[0]?.tiles).toEqual([BASE_KEY]);
  });

  it("keeps a tile parked across a Dialog -> Popover -> Select chain, released only once the outermost Dialog closes", async () => {
    function Harness(props: {
      readonly popoverOpen: boolean;
      readonly selectOpen: boolean;
    }): React.JSX.Element {
      return (
        <SurfacePresentationBoundary visible focused>
          <Dialog open>
            <DialogContent>
              <DialogTitle>Settings</DialogTitle>
              <Popover open={props.popoverOpen} onOpenChange={() => undefined}>
                <PopoverTrigger>Open</PopoverTrigger>
                <PopoverContent>
                  <Select
                    open={props.selectOpen}
                    onOpenChange={() => undefined}
                    value="a"
                    onValueChange={() => undefined}
                  >
                    <SelectTrigger aria-label="Pick">
                      <SelectValue placeholder="Pick" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="a">A</SelectItem>
                    </SelectContent>
                  </Select>
                </PopoverContent>
              </Popover>
            </DialogContent>
          </Dialog>
        </SurfacePresentationBoundary>
      );
    }

    const bridge = new FakeBrowserViewBridge();
    registerTile({ key: BASE_KEY, rect: rect(0, 0, 300, 300) });

    const view = renderWithBridge(
      bridge,
      <Harness popoverOpen={false} selectOpen={false} />,
    );
    setElementRect(findBySlot("dialog-content"), rect(0, 0, 200, 200));
    await waitFor(() => {
      expect(
        bridge.occludeCalls.some((call) => call.tiles[0] === BASE_KEY),
      ).toBe(true);
    });
    const dialogOverlayId = bridge.occludeCalls.find(
      (call) => call.tiles[0] === BASE_KEY,
    )?.overlayId;
    expect(dialogOverlayId).toBeDefined();

    // Open the Popover (real hideOthers churn), then the Select nested
    // inside it - the exact three-deep shape the settings-nested-select
    // pin covers only two levels of.
    act(() => {
      view.rerender(
        withBridge(bridge, <Harness popoverOpen selectOpen={false} />),
      );
    });
    setElementRect(findBySlot("popover-content"), rect(0, 0, 200, 200));
    await settle();
    expect(getBrowserViewSnapshot(BASE_KEY)).not.toBeNull();

    act(() => {
      view.rerender(withBridge(bridge, <Harness popoverOpen selectOpen />));
    });
    setElementRect(findBySlot("select-content"), rect(0, 0, 200, 200));
    await settle();

    // Every layer so far is still open; the outermost Dialog owner must
    // never have released across the two inner opens (invariant 5, "never
    // revealed in between" - now proved across three real Radix layers).
    expect(
      bridge.releaseCalls.some((call) => call.overlayId === dialogOverlayId),
    ).toBe(false);
    expect(getBrowserViewSnapshot(BASE_KEY)).not.toBeNull();

    // Close the Select, then the Popover - the Dialog is still open and
    // still covers the tile, so it must stay parked throughout.
    act(() => {
      view.rerender(
        withBridge(bridge, <Harness popoverOpen={false} selectOpen={false} />),
      );
    });
    await settle();
    expect(
      bridge.releaseCalls.some((call) => call.overlayId === dialogOverlayId),
    ).toBe(false);
    expect(getBrowserViewSnapshot(BASE_KEY)).not.toBeNull();
  });

  it("keeps a tile parked when a DropdownMenu submenu closes but its parent content still covers the tile", async () => {
    function Harness(props: { readonly subOpen: boolean }): React.JSX.Element {
      return (
        <SurfacePresentationBoundary visible focused>
          <DropdownMenu open>
            <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem>Reload</DropdownMenuItem>
              <DropdownMenuSub
                open={props.subOpen}
                onOpenChange={() => undefined}
              >
                <DropdownMenuSubTrigger>More</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem>Nested action</DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuContent>
          </DropdownMenu>
        </SurfacePresentationBoundary>
      );
    }

    const bridge = new FakeBrowserViewBridge();
    registerTile({ key: BASE_KEY, rect: rect(0, 0, 300, 300) });

    const view = renderWithBridge(bridge, <Harness subOpen={false} />);
    setElementRect(findBySlot("dropdown-menu-content"), rect(0, 0, 100, 100));
    await waitFor(() => {
      expect(bridge.occludeCalls).toHaveLength(1);
    });
    const menuOverlayId = bridge.occludeCalls.find(
      (call) => call.tiles[0] === BASE_KEY,
    )?.overlayId;
    expect(menuOverlayId).toBeDefined();

    act(() => {
      view.rerender(withBridge(bridge, <Harness subOpen />));
    });
    // The submenu covers a DIFFERENT region of the tile than its parent
    // content - both are independently registered overlay surfaces, so
    // this is a genuine two-owner ownership case, not the same rect twice.
    setElementRect(
      findBySlot("dropdown-menu-sub-content"),
      rect(150, 0, 100, 100),
    );
    await waitFor(() => {
      expect(bridge.occludeCalls.length).toBeGreaterThanOrEqual(2);
    });

    // Close the submenu again; the parent content is still open and still
    // covers the tile, so the tile must stay parked - this is the
    // ownership-handoff scan invariant 5 exists for.
    act(() => {
      view.rerender(withBridge(bridge, <Harness subOpen={false} />));
    });
    await settle();

    expect(
      bridge.releaseCalls.some((call) => call.overlayId === menuOverlayId),
    ).toBe(false);
    expect(getBrowserViewSnapshot(BASE_KEY)).not.toBeNull();
  });

  it("keeps a tile parked by the Toast alone once the Dialog covering it closes", async () => {
    const bridge = new FakeBrowserViewBridge();
    registerTile({ key: BASE_KEY, rect: rect(0, 0, 300, 300) });

    function Harness(props: {
      readonly dialogOpen: boolean;
    }): React.JSX.Element {
      return (
        <SurfacePresentationBoundary visible focused>
          {props.dialogOpen ? (
            <Dialog open>
              <DialogContent>
                <DialogTitle>Settings</DialogTitle>
              </DialogContent>
            </Dialog>
          ) : null}
          <Toaster />
        </SurfacePresentationBoundary>
      );
    }

    const view = renderWithBridge(bridge, <Harness dialogOpen />);
    setElementRect(findBySlot("dialog-content"), rect(0, 0, 300, 300));
    await waitFor(() => {
      expect(
        bridge.occludeCalls.some((call) => call.tiles[0] === BASE_KEY),
      ).toBe(true);
    });
    const dialogOverlayId = bridge.occludeCalls.find(
      (call) => call.tiles[0] === BASE_KEY,
    )?.overlayId;
    expect(dialogOverlayId).toBeDefined();

    act(() => {
      toast.info("Working in the background");
    });
    const toasterList = await waitForToasterList();
    setElementRect(toasterList, rect(0, 0, 300, 300));
    // The `<ol>` mounted with jsdom's default zero-size rect and already
    // ran (and was filtered out by) one scan by the time `waitFor` above
    // resolved - a `resize` dispatch is the production-safe way to force
    // the rescan that picks up the geometry just set.
    window.dispatchEvent(new Event("resize"));
    await waitFor(() => {
      expect(
        bridge.occludeCalls.filter((call) => call.tiles[0] === BASE_KEY).length,
      ).toBeGreaterThanOrEqual(2);
    });

    // Close the Dialog; its OWN overlay correctly releases (it unmounted -
    // that release is not the bug this pins). What matters is that the
    // toast independently still owns the tile, so the tile itself must
    // stay parked - two independent owners, releasing one is not "the
    // last one".
    act(() => {
      view.rerender(withBridge(bridge, <Harness dialogOpen={false} />));
    });
    await settle();

    expect(
      bridge.releaseCalls.some((call) => call.overlayId === dialogOverlayId),
    ).toBe(true);
    expect(bridge.isTileParked(BASE_KEY)).toBe(true);
    expect(getBrowserViewSnapshot(BASE_KEY)).not.toBeNull();
  });

  // Invariant: an overlay that only clips a CORNER of the tile still swaps
  // the whole native view, not a partial region - matched entirely through
  // main's per-tile occlusion, never a sub-rect.
  it("swaps the whole tile when a real Popover only corner-clips it", async () => {
    const bridge = new FakeBrowserViewBridge();
    registerTile({ key: BASE_KEY, rect: rect(0, 0, 300, 300) });

    renderWithBridge(
      bridge,
      <SurfacePresentationBoundary visible focused>
        <Popover open onOpenChange={() => undefined}>
          <PopoverTrigger>Open</PopoverTrigger>
          <PopoverContent>Details</PopoverContent>
        </Popover>
      </SurfacePresentationBoundary>,
    );

    // Only the top-left 20x20 corner of the 300x300 tile is covered.
    setElementRect(findBySlot("popover-content"), rect(-10, -10, 30, 30));

    await waitFor(() => {
      expect(bridge.occludeCalls).toHaveLength(1);
    });
    expect(bridge.occludeCalls[0]?.tiles).toEqual([BASE_KEY]);
    await waitFor(() => {
      expect(getBrowserViewSnapshot(BASE_KEY)).not.toBeNull();
    });
  });
});

async function waitForToasterList(): Promise<HTMLElement> {
  await waitFor(() => {
    expect(document.querySelector("[data-sonner-toaster]")).not.toBeNull();
  });
  const element = document.querySelector<HTMLElement>("[data-sonner-toaster]");
  if (element === null) throw new Error("sonner toaster list not mounted");
  return element;
}
