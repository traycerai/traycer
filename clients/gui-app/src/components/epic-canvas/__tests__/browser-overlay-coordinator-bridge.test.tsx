import "../../../../__tests__/test-browser-apis";
import { useEffect, useRef } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { BrowserOverlayCoordinatorBridge } from "@/components/epic-canvas/browser-overlay-coordinator-bridge";
import {
  clearBrowserViewSnapshot,
  getBrowserViewSnapshot,
  registerBrowserOverlay,
  registerBrowserOverlayTile,
  setBrowserOverlayTileMotion,
} from "@/lib/browser-view/tiles/browser-overlay-coordinator";
import { BrowserViewSnapshotLayer } from "@/components/epic-canvas/renderers/browser-view-snapshot-layer";
import { useBrowserViewSnapshot } from "@/components/epic-canvas/renderers/use-browser-view-snapshot";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { SurfacePresentationBoundary } from "@/components/layout/surface-presentation-boundary";
import type {
  BrowserViewBridge,
  BrowserViewTileKey,
} from "@traycer-clients/shared/platform/browser-view";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { FakeBrowserViewBridge } from "@/lib/browser-view/__tests__/fake-browser-view-overlay-bridge";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import { getDefaultBindings } from "@/lib/keybindings/actions";
import type { BrowserViewReservedChord } from "@traycer-clients/shared/platform/browser-view";

const BASE_KEY: BrowserViewTileKey = {
  viewTabId: "view-1",
  paneId: "pane-1",
  tileInstanceId: "tile-1",
  pageSessionId: "page-1",
};

const unregisterTiles = new Set<() => void>();
const unregisterOverlays = new Set<() => void>();

function registerTestBrowserOverlayTile(input: {
  readonly key: BrowserViewTileKey;
  readonly rect: DOMRectReadOnly;
}): void {
  unregisterTiles.add(registerBrowserOverlayTile(input));
}

describe("<BrowserOverlayCoordinator />", () => {
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
    cleanup();
    unregisterTiles.forEach((unregister) => unregister());
    unregisterTiles.clear();
    unregisterOverlays.forEach((unregister) => unregister());
    unregisterOverlays.clear();
    clearBrowserViewSnapshot(BASE_KEY);
    vi.restoreAllMocks();
  });

  it("keeps a Radix wrapper's registered overlay id stable across re-renders", async () => {
    // Contract pin for `DialogContent`'s composed ref: `useComposedRefs`
    // (radix-ui/internal) is identity-stable across re-renders, so the
    // registration ref callback fires once, at mount, and a re-render of the
    // owning component touches neither the registry nor the bridge (no
    // deregister/re-register, no release/occlude storm). An inline
    // `mergeRefs(ref, registerOverlayRef)` would build a NEW function every
    // render and lose that guarantee - this suite's `vitest.config.ts` runs
    // the React Compiler, which auto-memoizes a plain inline-churn repro
    // away, so this asserts the actual contract this file relies on
    // (`useComposedRefs` on the composed ref) rather than trying to catch
    // the churn symptom directly.
    const bridge = new FakeBrowserViewBridge();
    registerTestBrowserOverlayTile({
      key: BASE_KEY,
      rect: rect(0, 0, 300, 300),
    });

    function Harness(props: { readonly counter: number }): React.JSX.Element {
      return (
        <SurfacePresentationBoundary visible focused>
          <Dialog open>
            <DialogContent>
              <div data-testid="counter">{props.counter}</div>
            </DialogContent>
          </Dialog>
        </SurfacePresentationBoundary>
      );
    }

    const runnerHost = Object.assign(
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
    const view = render(
      <RunnerHostProvider runnerHost={runnerHost}>
        <BrowserOverlayCoordinatorBridge />
        <Harness counter={0} />
      </RunnerHostProvider>,
    );

    const dialogContent = document.querySelector<HTMLElement>(
      '[data-slot="dialog-content"]',
    );
    if (dialogContent === null) throw new Error("dialog content not mounted");
    setElementRect(dialogContent, rect(0, 0, 200, 200));

    await waitFor(() => {
      expect(bridge.occludeCalls).toHaveLength(1);
    });
    const overlayId = bridge.occludeCalls[0]?.overlayId;

    act(() => {
      view.rerender(
        <RunnerHostProvider runnerHost={runnerHost}>
          <BrowserOverlayCoordinatorBridge />
          <Harness counter={1} />
        </RunnerHostProvider>,
      );
      view.rerender(
        <RunnerHostProvider runnerHost={runnerHost}>
          <BrowserOverlayCoordinatorBridge />
          <Harness counter={2} />
        </RunnerHostProvider>,
      );
    });
    // Give any (buggy) ref-churn-triggered rescan a chance to land before
    // asserting nothing moved: the mocked `requestAnimationFrame` above
    // resolves on a macrotask (`setTimeout(..., 0)`), so a microtask flush
    // alone would not observe it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(bridge.releaseCalls).toEqual([]);
    expect(bridge.occludeCalls).toHaveLength(1);
    expect(bridge.occludeCalls[0]?.overlayId).toBe(overlayId);
  });

  it("does not hide browser views for non-overlapping overlays", async () => {
    const bridge = new FakeBrowserViewBridge();
    registerTestBrowserOverlayTile({
      key: BASE_KEY,
      rect: rect(0, 0, 100, 100),
    });
    const overlay = appendOverlay(rect(200, 200, 40, 40));

    renderBrowserOverlayCoordinator(bridge);
    await Promise.resolve();

    expect(bridge.occludeCalls).toEqual([]);
    overlay.remove();
  });

  it("occludes every overlapping overlay through the desktop bridge", async () => {
    const bridge = new FakeBrowserViewBridge();
    registerTestBrowserOverlayTile({
      key: BASE_KEY,
      rect: rect(0, 0, 100, 100),
    });
    const commandPalette = appendOverlay(rect(20, 20, 20, 20));
    const toast = appendOverlay(rect(80, 80, 40, 40));

    renderBrowserOverlayCoordinator(bridge);

    await waitFor(() => {
      expect(bridge.occludeCalls).toHaveLength(2);
    });
    const occludedIds = bridge.occludeCalls.map((call) => call.overlayId);
    // Two distinct registrations occlude independently - the overlay id is
    // opaque (assigned at registration time), never derived from `kind`.
    expect(new Set(occludedIds).size).toBe(2);
    expect(
      bridge.occludeCalls.every((call) => call.tiles[0] === BASE_KEY),
    ).toBe(true);
    await waitFor(() => {
      const snapshot = getBrowserViewSnapshot(BASE_KEY);
      expect(snapshot).not.toBeNull();
      expect(occludedIds).toContain(
        snapshot?.dataUrl?.replace("data:image/png;base64,", ""),
      );
      expect(snapshot?.stale).toBe(false);
    });

    // Flicker fix phase 2: once the replacement frame is applied, the
    // coordinator acknowledges so main parks the native view. Each overlay
    // acks its own replacement frame; main-side parking is idempotent.
    await waitFor(() => {
      expect(bridge.paintAckCalls.slice().sort()).toEqual(
        occludedIds.slice().sort(),
      );
    });

    commandPalette.remove();
    toast.remove();
  });

  it("routes the registered overlay categories through one occlusion path", async () => {
    const bridge = new FakeBrowserViewBridge();
    registerTestBrowserOverlayTile({
      key: BASE_KEY,
      rect: rect(0, 0, 100, 100),
    });
    // One registration per overlay-primitive family in the app (command
    // palette, context menu, toast, ...) - the count is what matters, not
    // which family each stands in for.
    const OVERLAY_COUNT = 8;
    const overlays = Array.from({ length: OVERLAY_COUNT }, (_, index) =>
      appendOverlay(rect(5 + index, 5 + index, 20, 20)),
    );

    renderBrowserOverlayCoordinator(bridge);

    await waitFor(() => {
      expect(bridge.occludeCalls).toHaveLength(OVERLAY_COUNT);
    });
    // What this pins is that every registration reaches occlusion through
    // the one path, each with its own distinct id.
    expect(
      new Set(bridge.occludeCalls.map((call) => call.overlayId)).size,
    ).toBe(OVERLAY_COUNT);

    overlays.forEach((overlay) => overlay.remove());
  });

  it("measures Sonner's fixed toaster container as toast overlay geometry", async () => {
    const bridge = new FakeBrowserViewBridge();
    registerTestBrowserOverlayTile({
      key: BASE_KEY,
      rect: rect(0, 0, 100, 100),
    });
    const toaster = appendSonnerToaster(rect(16, 16, 48, 24));

    renderBrowserOverlayCoordinator(bridge);

    await waitFor(() => {
      expect(bridge.occludeCalls).toHaveLength(1);
    });
    expect(bridge.occludeCalls[0]?.tiles).toEqual([BASE_KEY]);
    expect(bridge.occludeCalls[0]?.overlayId).toMatch(/^browser-overlay-/);

    toaster.remove();
  });

  it("releases and clears snapshots when an overlay stops intersecting", async () => {
    const bridge = new FakeBrowserViewBridge();
    registerTestBrowserOverlayTile({
      key: BASE_KEY,
      rect: rect(0, 0, 100, 100),
    });
    const overlay = appendOverlay(rect(10, 10, 20, 20));

    renderBrowserOverlayCoordinator(bridge);
    await waitFor(() => {
      expect(getBrowserViewSnapshot(BASE_KEY)).not.toBeNull();
    });
    const overlayId = bridge.occludeCalls[0]?.overlayId;

    await act(async () => {
      overlay.remove();
      window.dispatchEvent(new Event("resize"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(bridge.releaseCalls).toEqual([{ overlayId }]);
    });
    await waitFor(() => {
      expect(getBrowserViewSnapshot(BASE_KEY)).toBeNull();
    });
  });

  it("keeps the stand-in mounted until the deferred restore event arrives (ticket 04)", async () => {
    // Invariant 4: a tile that WAS parked cannot restore synchronously
    // through `releaseOverlay`'s return value - main answers `restoredTiles:
    // []` there and the JPEG stand-in must survive until the new
    // `onOverlayTileRestored` event lands on the un-parked view's first
    // composited frame.
    const bridge = new FakeBrowserViewBridge();
    bridge.deferRestoredTiles = true;
    registerTestBrowserOverlayTile({
      key: BASE_KEY,
      rect: rect(0, 0, 100, 100),
    });
    const overlay = appendOverlay(rect(10, 10, 20, 20));

    renderBrowserOverlayCoordinator(bridge);
    await waitFor(() => {
      expect(getBrowserViewSnapshot(BASE_KEY)).not.toBeNull();
    });
    const overlayId = bridge.occludeCalls[0]?.overlayId;

    await act(async () => {
      overlay.remove();
      window.dispatchEvent(new Event("resize"));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(bridge.releaseCalls).toEqual([{ overlayId }]);
    });

    // The synchronous return value carried nothing to restore; the
    // stand-in must still be up.
    expect(getBrowserViewSnapshot(BASE_KEY)).not.toBeNull();

    act(() => {
      bridge.emitOverlayTileRestored(BASE_KEY);
    });

    expect(getBrowserViewSnapshot(BASE_KEY)).toBeNull();
  });

  it("marks a rendered snapshot stale from desktop invalidation events", async () => {
    const bridge = new FakeBrowserViewBridge();
    registerTestBrowserOverlayTile({
      key: BASE_KEY,
      rect: rect(0, 0, 100, 100),
    });
    const overlay = appendOverlay(rect(10, 10, 20, 20));

    renderBrowserOverlayCoordinator(bridge);
    let overlayId: string | undefined;
    await waitFor(() => {
      overlayId = bridge.occludeCalls[0]?.overlayId;
      expect(getBrowserViewSnapshot(BASE_KEY)).toEqual({
        dataUrl: `data:image/png;base64,${overlayId}`,
        stale: false,
      });
    });

    bridge.emitSnapshotInvalidated({ ...BASE_KEY, reason: "paint" });

    expect(getBrowserViewSnapshot(BASE_KEY)).toEqual({
      dataUrl: `data:image/png;base64,${overlayId}`,
      stale: true,
    });
    overlay.remove();
  });

  it("retries an overlay whose occlusion matched no tile in main", async () => {
    // The signature used to be recorded before the occlude resolved, so a
    // scan that raced tile teardown ("no matching entries") was never retried
    // and the tile stayed live under the overlay until it closed.
    const bridge = new FakeBrowserViewBridge();
    bridge.matchedCountOverride = 0;
    registerTestBrowserOverlayTile({
      key: BASE_KEY,
      rect: rect(0, 0, 100, 100),
    });
    const overlay = appendOverlay(rect(20, 20, 20, 20));

    renderBrowserOverlayCoordinator(bridge);
    await waitFor(() => {
      expect(bridge.occludeCalls).toHaveLength(1);
    });
    const overlayId = bridge.occludeCalls[0]?.overlayId;

    bridge.matchedCountOverride = null;
    act(() => {
      overlay.setAttribute("data-state", "open");
    });

    await waitFor(() => {
      expect(bridge.occludeCalls).toHaveLength(2);
    });
    expect(bridge.occludeCalls[1]).toMatchObject({ overlayId });
    overlay.remove();
  });

  it("retries an overlay whose occlusion matched only SOME of its tiles", async () => {
    // A partial match leaves the unmatched tile live under the overlay. The
    // signature stayed latched on any nonzero count, so the next layout
    // notification computed the same signature and returned early.
    const bridge = new FakeBrowserViewBridge();
    bridge.matchedCountOverride = 1;
    registerTestBrowserOverlayTile({
      key: BASE_KEY,
      rect: rect(0, 0, 100, 100),
    });
    registerTestBrowserOverlayTile({
      key: { ...BASE_KEY, tileInstanceId: "tile-2" },
      rect: rect(0, 0, 100, 100),
    });
    const overlay = appendOverlay(rect(20, 20, 20, 20));

    renderBrowserOverlayCoordinator(bridge);
    await waitFor(() => {
      expect(bridge.occludeCalls).toHaveLength(1);
    });
    expect(bridge.occludeCalls[0]?.tiles).toHaveLength(2);

    bridge.matchedCountOverride = null;
    act(() => {
      overlay.setAttribute("data-state", "open");
    });

    await waitFor(() => {
      expect(bridge.occludeCalls).toHaveLength(2);
    });
    overlay.remove();
  });

  it("occludes through the native browser bridge", async () => {
    const bridge = new FakeBrowserViewBridge();
    registerTestBrowserOverlayTile({
      key: BASE_KEY,
      rect: rect(0, 0, 100, 100),
    });
    const overlay = appendOverlay(rect(10, 10, 20, 20));

    renderBrowserOverlayCoordinator(bridge);

    await waitFor(() => {
      expect(bridge.occludeCalls).toHaveLength(1);
    });

    overlay.remove();
  });

  it("keeps a dialog occluded across a real Radix Select's aria-hidden churn", async () => {
    // The regression: Radix's hideOthers (fired by any Select/Popover/
    // DropdownMenu opening) sets aria-hidden="true" on every OTHER body
    // child while it's open - including a settings dialog that is itself a
    // direct body child via DialogPortal. The old `isElementVisible` treated
    // aria-hidden as "not painted", so the dialog dropped out of the next
    // scan's targets and got released while it still visibly covered the
    // tile. A bare-div overlay stand-in never exercises this: nothing calls
    // hideOthers on it, so this needs real Radix mount/unmount behavior.
    const bridge = new FakeBrowserViewBridge();
    registerTestBrowserOverlayTile({
      key: BASE_KEY,
      rect: rect(0, 0, 300, 300),
    });

    // Controlled `open`, driven by rerender rather than a simulated click:
    // Radix's own dismissable-layer close (from a real outside click) would
    // race a second, test-owned click handler toggling the same state,
    // double-flipping it back open. A controlled prop still mounts/unmounts
    // the real `SelectContent` - and runs its real `hideOthers` effect - on
    // each transition, which is the behavior under test.
    function Harness(props: {
      readonly selectOpen: boolean;
    }): React.JSX.Element {
      return (
        <SurfacePresentationBoundary visible focused>
          <Dialog open>
            <DialogContent>
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
            </DialogContent>
          </Dialog>
        </SurfacePresentationBoundary>
      );
    }

    const runnerHost = Object.assign(
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
    const view = render(
      <RunnerHostProvider runnerHost={runnerHost}>
        <BrowserOverlayCoordinatorBridge />
        <Harness selectOpen={false} />
      </RunnerHostProvider>,
    );

    const dialogContent = document.querySelector<HTMLElement>(
      '[data-slot="dialog-content"]',
    );
    if (dialogContent === null) throw new Error("dialog content not mounted");
    setElementRect(dialogContent, rect(0, 0, 200, 200));

    await waitFor(() => {
      expect(bridge.occludeCalls).toHaveLength(1);
    });
    const dialogOverlayId = bridge.occludeCalls[0].overlayId;

    // Open the Select: real Radix hideOthers churn, not a stubbed attribute.
    act(() => {
      view.rerender(
        <RunnerHostProvider runnerHost={runnerHost}>
          <BrowserOverlayCoordinatorBridge />
          <Harness selectOpen />
        </RunnerHostProvider>,
      );
    });
    await waitFor(() => {
      expect(dialogContent.getAttribute("aria-hidden")).toBe("true");
    });

    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      await Promise.resolve();
    });
    expect(
      bridge.releaseCalls.some((call) => call.overlayId === dialogOverlayId),
    ).toBe(false);

    // Close the Select again; the dialog is still open and still covers the
    // tile, so the scan that follows must not release it either - this is
    // the scan that catches a release-before-occlude ordering regression too.
    act(() => {
      view.rerender(
        <RunnerHostProvider runnerHost={runnerHost}>
          <BrowserOverlayCoordinatorBridge />
          <Harness selectOpen={false} />
        </RunnerHostProvider>,
      );
    });
    await waitFor(() => {
      expect(dialogContent.hasAttribute("aria-hidden")).toBe(false);
    });

    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      await Promise.resolve();
    });
    expect(
      bridge.releaseCalls.some((call) => call.overlayId === dialogOverlayId),
    ).toBe(false);
  });

  // Ticket 07 (invariant 9, case 1): a click on the uncovered region of an
  // overlay-frozen tile dismisses the overlay only, never forwarded to the
  // page. There is no renderer-side relay for the native tile - the parked
  // WebContentsView has no DOM presence and `BrowserViewSnapshotLayer` is
  // `pointer-events-none` (pinned directly in
  // `browser-view-snapshot-layer.test.tsx`) - so "never forwarded" already
  // holds structurally: nothing on the tile surface listens for a click to
  // forward anywhere. What is NOT structural, and what Radix actually
  // decides per wrapper, is whether the outside click reaches the DOM
  // beneath the overlay at all. `DropdownMenu` defaults `modal: true`
  // (`@radix-ui/react-menu` `modal = true`), which renders its
  // `DismissableLayer` with `disableOutsidePointerEvents: true`.
  //
  // That flag's real mechanism (`@radix-ui/react-dismissable-layer`) is
  // `document.body.style.pointerEvents = "none"` while the layer is
  // mounted, not `stopPropagation`/`preventDefault` on the outside event -
  // it is a hit-testing block a real compositor enforces, which
  // `fireEvent`'s direct `dispatchEvent(target)` cannot exercise (it never
  // hit-tests). So the swallow is pinned at the mechanism `fireEvent` CAN
  // observe: the body style toggling on for the modal layer's lifetime and
  // off again once it unmounts, exactly the effect in
  // `@radix-ui/react-dismissable-layer`'s `disableOutsidePointerEvents`
  // branch.
  it("locks out pointer events on the tile surface while a modal overlay (DropdownMenu) is open over it", async () => {
    const bridge = new FakeBrowserViewBridge();
    const onOpenChange = vi.fn();

    function TileSurface(): React.JSX.Element {
      const snapshot = useBrowserViewSnapshot(BASE_KEY);
      const ref = useRef<HTMLDivElement | null>(null);
      useEffect(() => {
        const surface = ref.current;
        if (surface === null) return undefined;
        setElementRect(surface, rect(0, 0, 300, 300));
        return registerBrowserOverlayTile({
          key: BASE_KEY,
          rect: rect(0, 0, 300, 300),
        });
      }, []);
      return (
        <div ref={ref} data-testid="tile-surface">
          <BrowserViewSnapshotLayer snapshot={snapshot} />
        </div>
      );
    }

    function Harness(props: { readonly menuOpen: boolean }): React.JSX.Element {
      return (
        <SurfacePresentationBoundary visible focused>
          <TileSurface />
          <DropdownMenu open={props.menuOpen} onOpenChange={onOpenChange}>
            <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem>Reload</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SurfacePresentationBoundary>
      );
    }

    const runnerHost = Object.assign(
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
    const originalBodyPointerEvents = document.body.style.pointerEvents;
    const view = render(
      <RunnerHostProvider runnerHost={runnerHost}>
        <BrowserOverlayCoordinatorBridge />
        <Harness menuOpen />
      </RunnerHostProvider>,
    );

    const menuContent = document.querySelector<HTMLElement>(
      '[data-slot="dropdown-menu-content"]',
    );
    if (menuContent === null) throw new Error("menu content not mounted");
    setElementRect(menuContent, rect(50, 50, 100, 100));

    // Real occlusion round trip: the tile parks and its real snapshot
    // stand-in mounts, matching what a user actually sees before clicking.
    await waitFor(() => {
      expect(bridge.occludeCalls).toHaveLength(1);
    });
    await waitFor(() => {
      expect(getBrowserViewSnapshot(BASE_KEY)).not.toBeNull();
    });
    const tileSurface = document.querySelector<HTMLElement>(
      '[data-testid="tile-surface"]',
    );
    if (tileSurface === null) throw new Error("tile surface not mounted");
    expect(
      tileSurface.querySelector("[data-browser-view-snapshot]"),
    ).not.toBeNull();

    // The swallow is live for the whole time the parked tile is showing
    // through - not just at the instant of a click.
    expect(document.body.style.pointerEvents).toBe("none");

    // The dismiss half still fires through the real outside-pointerdown
    // listener, which IS a normal document-level event listener and DOES
    // see a `fireEvent`-dispatched event bubble up to it.
    fireEvent.pointerDown(tileSurface, { button: 0, pointerType: "mouse" });
    fireEvent.click(tileSurface);
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    // Once the menu actually closes, the lockout lifts - pinning that this
    // is a real, cleaned-up effect and not a leaked global.
    act(() => {
      view.rerender(
        <RunnerHostProvider runnerHost={runnerHost}>
          <BrowserOverlayCoordinatorBridge />
          <Harness menuOpen={false} />
        </RunnerHostProvider>,
      );
    });
    expect(document.body.style.pointerEvents).toBe(originalBodyPointerEvents);
  });

  // Ticket 07 (invariant 9, case 1), the wrapper-specific counterpart: our
  // `Popover` never sets `modal`, so it takes Radix's default
  // (`@radix-ui/react-popover` `modal = false`), which renders
  // `PopoverContentNonModal` with `disableOutsidePointerEvents: false` - the
  // outside click that light-dismisses it is NOT swallowed at the DOM
  // level. Invariant 9 still holds only because nothing on the tile surface
  // forwards a click anywhere (case 1's "never forwarded to the page" is a
  // structural fact about the tile, not a Radix guarantee here). This pins
  // the actual, more permissive behavior so a future change cannot silently
  // start relying on Popover swallowing outside clicks the way the modal
  // wrappers do.
  it("does not swallow the outside click that light-dismisses a non-modal overlay (Popover) over a parked tile", async () => {
    const bridge = new FakeBrowserViewBridge();
    const onOpenChange = vi.fn();
    const tileSurfaceClick = vi.fn();

    function TileSurface(): React.JSX.Element {
      const snapshot = useBrowserViewSnapshot(BASE_KEY);
      const ref = useRef<HTMLDivElement | null>(null);
      useEffect(() => {
        const surface = ref.current;
        if (surface === null) return undefined;
        setElementRect(surface, rect(0, 0, 300, 300));
        return registerBrowserOverlayTile({
          key: BASE_KEY,
          rect: rect(0, 0, 300, 300),
        });
      }, []);
      return (
        <div
          ref={ref}
          data-testid="tile-surface"
          role="button"
          tabIndex={0}
          onClick={tileSurfaceClick}
          onKeyDown={tileSurfaceClick}
        >
          <BrowserViewSnapshotLayer snapshot={snapshot} />
        </div>
      );
    }

    function Harness(props: {
      readonly popoverOpen: boolean;
    }): React.JSX.Element {
      return (
        <SurfacePresentationBoundary visible focused>
          <TileSurface />
          <Popover open={props.popoverOpen} onOpenChange={onOpenChange}>
            <PopoverTrigger>Info</PopoverTrigger>
            <PopoverContent>Tile details</PopoverContent>
          </Popover>
        </SurfacePresentationBoundary>
      );
    }

    const runnerHost = Object.assign(
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
    render(
      <RunnerHostProvider runnerHost={runnerHost}>
        <BrowserOverlayCoordinatorBridge />
        <Harness popoverOpen />
      </RunnerHostProvider>,
    );

    const popoverContent = document.querySelector<HTMLElement>(
      '[data-slot="popover-content"]',
    );
    if (popoverContent === null) throw new Error("popover content not mounted");
    setElementRect(popoverContent, rect(50, 50, 100, 100));

    await waitFor(() => {
      expect(bridge.occludeCalls).toHaveLength(1);
    });
    await waitFor(() => {
      expect(getBrowserViewSnapshot(BASE_KEY)).not.toBeNull();
    });
    const tileSurface = document.querySelector<HTMLElement>(
      '[data-testid="tile-surface"]',
    );
    if (tileSurface === null) throw new Error("tile surface not mounted");

    // The DropdownMenu test above pins the modal lockout landing on
    // `document.body`; this is the same mechanism's absence for a
    // non-modal layer - nothing CSS-blocks the tile surface.
    expect(document.body.style.pointerEvents).not.toBe("none");

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    fireEvent.pointerDown(tileSurface, { button: 0, pointerType: "mouse" });
    fireEvent.click(tileSurface);

    // The dismiss half still fires - Radix closes non-modal content on an
    // outside pointerdown too - but the click itself was never swallowed.
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(tileSurfaceClick).toHaveBeenCalledTimes(1);
  });

  it("keeps a tile parked through a same-scan overlay ownership handoff", async () => {
    // Two overlays covering the same tile, both still open at once for a
    // single scan: overlay A's element is removed and overlay B's element
    // (also covering the tile) is added in the SAME act/resize, so the scan
    // that follows sees B as a still-active target and A as dropped in one
    // pass. Occlude-before-release ordering alone is not the whole story -
    // the fake's warm-tile path (mirroring browser-view-overlay.ts:302-308)
    // is what makes B's occlude land SYNCHRONOUSLY, before A's release can
    // ever observe the tile as unowned.
    const bridge = new FakeBrowserViewBridge();
    registerTestBrowserOverlayTile({
      key: BASE_KEY,
      rect: rect(0, 0, 100, 100),
    });
    const overlayA = appendOverlay(rect(10, 10, 20, 20));

    renderBrowserOverlayCoordinator(bridge);
    await waitFor(() => {
      expect(getBrowserViewSnapshot(BASE_KEY)).not.toBeNull();
    });
    const overlayAId = bridge.occludeCalls[0]?.overlayId;

    // B is registered (and covers the tile) before the single resize dispatch
    // below - what makes this a same-SCAN handoff is that A's removal and
    // B's presence both land before the one scan that follows, not that B's
    // registration itself happens inside `act()`.
    const overlayB = appendOverlay(rect(15, 15, 20, 20));
    await act(async () => {
      overlayA.remove();
      window.dispatchEvent(new Event("resize"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(
        bridge.occludeCalls.some((call) => call.overlayId !== overlayAId),
      ).toBe(true);
    });
    expect(bridge.restoreReports).toEqual([]);
    expect(getBrowserViewSnapshot(BASE_KEY)).not.toBeNull();

    overlayB.remove();
  });
});

// Invariant 8: motion is a second freeze input to the SAME state machine.
// The bounds-bridge rAF loop reports it through `setBrowserOverlayTileMotion`
// (pinned separately in `use-browser-view-bounds-bridge.test.ts`); here it is
// reported directly, as the synthetic per-tile owner `runScan` composes with
// overlay owners over the exact same occlude/release/ack path.
describe("motion freeze (invariant 8)", () => {
  beforeEach(() => {
    let nextFrameId = 1;
    // The cancel side has to honour the handle: the coordinator cancels its
    // pending frame on dispose, and a mock that ignores the id lets that
    // frame's `runScan` still fire afterwards, against a torn-down registry
    // or the next test's.
    const timersByFrameId = new Map<number, ReturnType<typeof setTimeout>>();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const frameId = nextFrameId;
      nextFrameId += 1;
      timersByFrameId.set(
        frameId,
        setTimeout(() => {
          timersByFrameId.delete(frameId);
          callback(performance.now());
        }, 0),
      );
      return frameId;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle) => {
      const timer = timersByFrameId.get(handle);
      if (timer === undefined) return;
      clearTimeout(timer);
      timersByFrameId.delete(handle);
    });
  });

  afterEach(() => {
    cleanup();
    // Before the tile registrations go: `setBrowserOverlayTileMotion` returns
    // early when the key has no tile entry, so resetting after the unregister
    // loop would be a no-op that only looks like teardown.
    setBrowserOverlayTileMotion(BASE_KEY, false);
    unregisterTiles.forEach((unregister) => unregister());
    unregisterTiles.clear();
    unregisterOverlays.forEach((unregister) => unregister());
    unregisterOverlays.clear();
    clearBrowserViewSnapshot(BASE_KEY);
    vi.restoreAllMocks();
  });

  it("occludes a moving tile through a synthetic motion owner", async () => {
    const bridge = new FakeBrowserViewBridge();
    registerTestBrowserOverlayTile({
      key: BASE_KEY,
      rect: rect(0, 0, 100, 100),
    });
    renderBrowserOverlayCoordinator(bridge);

    setBrowserOverlayTileMotion(BASE_KEY, true);

    await waitFor(() => {
      expect(bridge.occludeCalls).toHaveLength(1);
    });
    expect(bridge.occludeCalls[0]?.tiles).toEqual([BASE_KEY]);
    // A motion owner is a synthetic per-tile id, never a registered
    // overlay's opaque `browser-overlay-<n>` id.
    expect(bridge.occludeCalls[0]?.overlayId).not.toMatch(
      /^browser-overlay-\d/,
    );
  });

  it("releases the motion owner once motion is reported at rest", async () => {
    const bridge = new FakeBrowserViewBridge();
    registerTestBrowserOverlayTile({
      key: BASE_KEY,
      rect: rect(0, 0, 100, 100),
    });
    renderBrowserOverlayCoordinator(bridge);

    setBrowserOverlayTileMotion(BASE_KEY, true);
    await waitFor(() => {
      expect(bridge.occludeCalls).toHaveLength(1);
    });
    const overlayId = bridge.occludeCalls[0]?.overlayId;

    setBrowserOverlayTileMotion(BASE_KEY, false);

    await waitFor(() => {
      expect(bridge.releaseCalls).toEqual([{ overlayId }]);
    });
  });

  it("keeps a tile parked when motion ends while it is still overlay-covered", async () => {
    const bridge = new FakeBrowserViewBridge();
    registerTestBrowserOverlayTile({
      key: BASE_KEY,
      rect: rect(0, 0, 100, 100),
    });
    const overlay = appendOverlay(rect(10, 10, 20, 20));
    renderBrowserOverlayCoordinator(bridge);

    setBrowserOverlayTileMotion(BASE_KEY, true);
    await waitFor(() => {
      expect(bridge.occludeCalls).toHaveLength(2);
    });
    const motionOwnerId = bridge.occludeCalls.find((call) =>
      call.overlayId.startsWith("browser-overlay-motion:"),
    )?.overlayId;

    setBrowserOverlayTileMotion(BASE_KEY, false);

    await waitFor(() => {
      expect(bridge.releaseCalls).toEqual([{ overlayId: motionOwnerId }]);
    });
    // The overlay owner is still active - the tile must stay parked, not
    // restored, because the overlay in this same scan still covers it.
    expect(getBrowserViewSnapshot(BASE_KEY)).not.toBeNull();

    overlay.remove();
  });

  it("never un-parks a tile in between when it is covered, then starts moving", async () => {
    const bridge = new FakeBrowserViewBridge();
    registerTestBrowserOverlayTile({
      key: BASE_KEY,
      rect: rect(0, 0, 100, 100),
    });
    const overlay = appendOverlay(rect(10, 10, 20, 20));
    renderBrowserOverlayCoordinator(bridge);

    await waitFor(() => {
      expect(bridge.occludeCalls).toHaveLength(1);
    });
    const overlayOwnerId = bridge.occludeCalls[0]?.overlayId;

    setBrowserOverlayTileMotion(BASE_KEY, true);

    await waitFor(() => {
      expect(bridge.occludeCalls).toHaveLength(2);
    });
    // Occlude-before-release ordering (invariant 5) extended to a
    // motion/overlay handoff: the overlay owner must never have released
    // across the motion owner joining.
    expect(
      bridge.releaseCalls.some((call) => call.overlayId === overlayOwnerId),
    ).toBe(false);
    expect(getBrowserViewSnapshot(BASE_KEY)).not.toBeNull();

    overlay.remove();
  });
});

function renderBrowserOverlayCoordinator(browserView: BrowserViewBridge): void {
  const runnerHost = Object.assign(
    new MockRunnerHost({
      signInUrl: "https://example.com",
      authnBaseUrl: "https://auth.example.com",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
    }),
    { browserView },
  );
  render(
    <RunnerHostProvider runnerHost={runnerHost}>
      <BrowserOverlayCoordinatorBridge />
    </RunnerHostProvider>,
  );
}

/**
 * Registers a bare-div occlusion surface directly through the registry -
 * the mechanical-registry-case stand-in the ticket carves out (real-Radix
 * coverage of the wrapper seam itself is ticket 08). A test that needs to
 * key off "which overlay is this" must capture the id from a
 * `bridge.occludeCalls` entry, not from anything passed here - the registry
 * carries no per-registration label.
 */
function appendOverlay(overlayRect: DOMRectReadOnly): HTMLElement {
  const element = document.createElement("div");
  setElementRect(element, overlayRect);
  document.body.append(element);
  unregisterOverlays.add(registerBrowserOverlay({ element }));
  return element;
}

/**
 * Mechanical stand-in for sonner's inner `<ol data-sonner-toaster>`: a
 * bare, hand-registered element pinning the occlusion-geometry path.
 * Behavioral coverage of the REAL wiring - that a live `<Toaster/>`'s `<ol>`
 * gets registered/deregistered as toasts come and go - lives in
 * `sonner.test.tsx`.
 */
function appendSonnerToaster(overlayRect: DOMRectReadOnly): HTMLElement {
  const element = document.createElement("ol");
  setElementRect(element, overlayRect);
  document.body.append(element);
  unregisterOverlays.add(registerBrowserOverlay({ element }));
  return element;
}

function setElementRect(
  element: HTMLElement,
  overlayRect: DOMRectReadOnly,
): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => overlayRect,
  });
}

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

/**
 * The reserved-chord policy is derived from the reader's live bindings, so the
 * bridge has to keep pushing it - registration is the ONLY copy of those
 * bindings in the guest input path, and main holds whatever it was last told.
 * A one-shot registration keyed on the runner host reads as correct and leaves
 * a rebind half-done: the app renderer honours the new chord, the focused tile
 * still claiming the old one.
 */
describe("<BrowserOverlayCoordinatorBridge /> reserved chords", () => {
  afterEach(() => {
    cleanup();
    act(() => {
      useKeybindingStore.setState({ bindings: getDefaultBindings() });
    });
  });

  it("re-pushes the policy when a forwarded action is rebound", async () => {
    const bridge = new RecordingChordsBridge();
    renderBrowserOverlayCoordinator(bridge);

    await waitFor(() => {
      expect(bridge.reservedCalls).toHaveLength(1);
    });
    expect(tokensOf(bridge.reservedCalls[0])).toContain("mod+shift+w");

    act(() => {
      useKeybindingStore.getState().setBinding("epic.close", "mod+shift+e");
    });

    await waitFor(() => {
      expect(bridge.reservedCalls).toHaveLength(2);
    });
    const latest = tokensOf(bridge.reservedCalls[1]);
    expect(latest).toContain("mod+shift+e");
    expect(latest).not.toContain("mod+shift+w");
  });

  it("drops an unbound action's chord from the pushed policy", async () => {
    const bridge = new RecordingChordsBridge();
    renderBrowserOverlayCoordinator(bridge);

    await waitFor(() => {
      expect(bridge.reservedCalls).toHaveLength(1);
    });
    expect(tokensOf(bridge.reservedCalls[0])).toContain("mod+j");

    act(() => {
      useKeybindingStore.getState().clearBinding("app.terminal.toggle");
    });

    await waitFor(() => {
      expect(bridge.reservedCalls).toHaveLength(2);
    });
    const latest = tokensOf(bridge.reservedCalls[1]);
    expect(latest).not.toContain("mod+j");
    // The browser's own rows are not bindings and never move.
    expect(latest).toContain("mod+w");
  });
});

class RecordingChordsBridge extends FakeBrowserViewBridge {
  readonly reservedCalls: (readonly BrowserViewReservedChord[])[] = [];

  override setReservedChords(
    chords: readonly BrowserViewReservedChord[],
  ): Promise<void> {
    this.reservedCalls.push(chords);
    return Promise.resolve();
  }
}

function tokensOf(
  chords: readonly BrowserViewReservedChord[] | undefined,
): readonly string[] {
  return (chords ?? []).map((chord) => chord.token);
}
