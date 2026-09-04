import { useRef } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { usePublishBrowserGuestTile } from "@/components/epic-canvas/browser-guest/use-publish-browser-guest-tile";
import {
  startPersistentBrowserGuestHost,
  type BrowserGuestActivate,
} from "@/lib/browser-view/guest/persistent-browser-guest-host";
import { listTileRects } from "@/lib/browser-view/tiles/tile-rect-registry";
import { FakeBrowserViewBridge } from "@/lib/browser-view/__tests__/fake-browser-view-bridge";
import type {
  BrowserViewGuestMountRequested,
  BrowserViewTileKey,
} from "@traycer-clients/shared/platform/browser-view";

const NOOP_ACTIVATE: BrowserGuestActivate = {
  pointerDown: () => {},
  focus: () => {},
};

const TILE_KEY: BrowserViewTileKey = {
  viewTabId: "view-1",
  paneId: "pane-1",
  tileInstanceId: "tile-1",
  pageSessionId: "page-1",
};

let stopHost: (() => void) | null = null;

function startHost(bridge: FakeBrowserViewBridge): void {
  stopHost = startPersistentBrowserGuestHost(bridge, NOOP_ACTIVATE);
}

const REGISTRATION_A = "reg-a";
const REGISTRATION_B = "reg-b";
const PARTITION_A = "persist:guest-a";
const PARTITION_B = "persist:guest-b";
const ANCHOR_A = `--traycer-bv-${REGISTRATION_A}`;
const ANCHOR_B = `--traycer-bv-${REGISTRATION_B}`;

function mountRequest(
  registrationId: string,
  partition: string,
): BrowserViewGuestMountRequested {
  return {
    registrationId,
    partition,
  };
}

function queryWrapper(registrationId: string): HTMLElement | null {
  const wrapper = document.querySelector(
    `[data-browser-guest-registration="${registrationId}"]`,
  );
  return wrapper instanceof HTMLElement ? wrapper : null;
}

function wrapperState(registrationId: string): string | null {
  return (
    queryWrapper(registrationId)?.getAttribute("data-browser-guest-state") ??
    null
  );
}

function TileProbe(props: {
  readonly viewTabId: string;
  readonly paneId: string;
  readonly instanceId: string;
  readonly registrationId: string;
  readonly presented: boolean;
  readonly tileKey: BrowserViewTileKey | null;
}) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  usePublishBrowserGuestTile({
    surfaceRef,
    registrationId: props.registrationId,
    instanceId: props.instanceId,
    viewTabId: props.viewTabId,
    paneId: props.paneId,
    presented: props.presented,
    tileKey: props.tileKey,
  });
  return (
    <div
      ref={surfaceRef}
      data-testid={`tile-surface-${props.registrationId}`}
    />
  );
}

afterEach(() => {
  // Probe unmount clears that owner's placement. Host stop must not be
  // what wipes the map.
  cleanup();
  stopHost?.();
  stopHost = null;
});

describe("usePublishBrowserGuestTile", () => {
  it("keeps the registration-id anchor-name on the tile surface across pane and presentation changes", () => {
    const bridge = new FakeBrowserViewBridge();
    startHost(bridge);
    bridge.emitGuestMountRequested(mountRequest(REGISTRATION_A, PARTITION_A));

    const view = render(
      <TileProbe
        viewTabId="view-1"
        paneId="pane-1"
        instanceId="tile-1"
        registrationId={REGISTRATION_A}
        presented
        tileKey={null}
      />,
    );
    const surface = screen.getByTestId(`tile-surface-${REGISTRATION_A}`);
    expect(surface.style.getPropertyValue("anchor-name")).toBe(ANCHOR_A);

    view.rerender(
      <TileProbe
        viewTabId="view-1"
        paneId="pane-2"
        instanceId="tile-1"
        registrationId={REGISTRATION_A}
        presented={false}
        tileKey={null}
      />,
    );
    expect(surface.style.getPropertyValue("anchor-name")).toBe(ANCHOR_A);
  });

  it("registers the surface in the tile-rect registry and unregisters on unmount", () => {
    const bridge = new FakeBrowserViewBridge();
    startHost(bridge);
    bridge.emitGuestMountRequested(mountRequest(REGISTRATION_A, PARTITION_A));

    const view = render(
      <TileProbe
        viewTabId="view-1"
        paneId="pane-1"
        instanceId="tile-1"
        registrationId={REGISTRATION_A}
        presented
        tileKey={TILE_KEY}
      />,
    );
    expect(listTileRects()).toHaveLength(1);

    view.unmount();
    expect(listTileRects()).toEqual([]);
  });

  it("clears only that owner's placement on unmount", () => {
    const bridge = new FakeBrowserViewBridge();
    startHost(bridge);
    bridge.emitGuestMountRequested(mountRequest(REGISTRATION_A, PARTITION_A));
    bridge.emitGuestMountRequested(mountRequest(REGISTRATION_B, PARTITION_B));

    function DualTiles(props: { readonly showA: boolean }) {
      return (
        <>
          {props.showA ? (
            <TileProbe
              viewTabId="view-1"
              paneId="pane-1"
              instanceId="tile-a"
              registrationId={REGISTRATION_A}
              presented
              tileKey={null}
            />
          ) : null}
          <TileProbe
            viewTabId="view-1"
            paneId="pane-2"
            instanceId="tile-b"
            registrationId={REGISTRATION_B}
            presented
            tileKey={null}
          />
        </>
      );
    }

    const view = render(<DualTiles showA />);
    const surfaceA = screen.getByTestId(`tile-surface-${REGISTRATION_A}`);
    const surfaceB = screen.getByTestId(`tile-surface-${REGISTRATION_B}`);
    expect(wrapperState(REGISTRATION_A)).toBe("presented");
    expect(wrapperState(REGISTRATION_B)).toBe("presented");

    view.rerender(<DualTiles showA={false} />);
    expect(wrapperState(REGISTRATION_A)).toBe("unbound");
    expect(wrapperState(REGISTRATION_B)).toBe("presented");
    expect(surfaceA.style.getPropertyValue("anchor-name")).toBe("");
    expect(surfaceB.style.getPropertyValue("anchor-name")).toBe(ANCHOR_B);

    view.unmount();
    expect(wrapperState(REGISTRATION_A)).toBe("unbound");
    expect(wrapperState(REGISTRATION_B)).toBe("unbound");
  });
});
