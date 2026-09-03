import { useRef } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { usePublishBrowserGuestTile } from "@/components/epic-canvas/browser-guest/use-publish-browser-guest-tile";
import {
  startPersistentBrowserGuestHost,
  stopPersistentBrowserGuestHost,
} from "@/lib/browser-view/guest/persistent-browser-guest-host";
import { FakeBrowserViewBridge } from "@/lib/browser-view/__tests__/fake-browser-view-bridge";
import type { BrowserViewGuestMountRequested } from "@traycer-clients/shared/platform/browser-view";

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
    hostId: "host-1",
    sessionId: "session-1",
    tabId: "tab-1",
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
}) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  usePublishBrowserGuestTile({
    surfaceRef,
    registrationId: props.registrationId,
    instanceId: props.instanceId,
    viewTabId: props.viewTabId,
    paneId: props.paneId,
    presented: props.presented,
    tileKey: null,
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
  stopPersistentBrowserGuestHost();
});

describe("usePublishBrowserGuestTile", () => {
  it("sets registration-id anchor-name on the tile surface and follows the presented flag", () => {
    const bridge = new FakeBrowserViewBridge();
    startPersistentBrowserGuestHost(bridge, null);
    bridge.emitGuestMountRequested(mountRequest(REGISTRATION_A, PARTITION_A));
    expect(wrapperState(REGISTRATION_A)).toBe("unbound");

    const view = render(
      <TileProbe
        viewTabId="view-1"
        paneId="pane-1"
        instanceId="tile-1"
        registrationId={REGISTRATION_A}
        presented
      />,
    );
    const surface = screen.getByTestId(`tile-surface-${REGISTRATION_A}`);
    expect(surface.style.getPropertyValue("anchor-name")).toBe(ANCHOR_A);
    expect(wrapperState(REGISTRATION_A)).toBe("presented");
    const wrapper = queryWrapper(REGISTRATION_A);
    if (wrapper === null) throw new Error("expected guest wrapper");
    expect(wrapper.style.getPropertyValue("position-anchor")).toBe(ANCHOR_A);
    expect(wrapper.style.position).toBe("fixed");

    view.rerender(
      <TileProbe
        viewTabId="view-1"
        paneId="pane-1"
        instanceId="tile-1"
        registrationId={REGISTRATION_A}
        presented={false}
      />,
    );
    expect(surface.style.getPropertyValue("anchor-name")).toBe(ANCHOR_A);
    expect(wrapperState(REGISTRATION_A)).toBe("retained");
    expect(wrapper).toBe(queryWrapper(REGISTRATION_A));

    view.rerender(
      <TileProbe
        viewTabId="view-1"
        paneId="pane-2"
        instanceId="tile-1"
        registrationId={REGISTRATION_A}
        presented
      />,
    );
    expect(surface.style.getPropertyValue("anchor-name")).toBe(ANCHOR_A);
    expect(wrapperState(REGISTRATION_A)).toBe("presented");
    expect(wrapper.style.getPropertyValue("position-anchor")).toBe(ANCHOR_A);
    expect(queryWrapper(REGISTRATION_A)).toBe(wrapper);
  });

  it("clears only that owner's placement on unmount", () => {
    const bridge = new FakeBrowserViewBridge();
    startPersistentBrowserGuestHost(bridge, null);
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
            />
          ) : null}
          <TileProbe
            viewTabId="view-1"
            paneId="pane-2"
            instanceId="tile-b"
            registrationId={REGISTRATION_B}
            presented
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
