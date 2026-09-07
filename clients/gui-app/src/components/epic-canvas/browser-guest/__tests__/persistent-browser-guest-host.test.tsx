import { useRef } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PersistentBrowserGuestHost } from "@/components/epic-canvas/browser-guest/persistent-browser-guest-host";
import { usePublishBrowserGuestTile } from "@/components/epic-canvas/browser-guest/use-publish-browser-guest-tile";
import { FakeBrowserViewBridge } from "@/lib/browser-view/__tests__/fake-browser-view-bridge";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { createFakeRunnerHost } from "../../../../../__tests__/create-fake-runner-host";
import type { BrowserViewGuestMountRequested } from "@traycer-clients/shared/platform/browser-view";

const HOST_TEST_ID = "persistent-browser-guest-host";
const REGISTRATION_A = "reg-a";
const PARTITION_A = "persist:guest-a";
const SURFACE_TEST_ID = `tile-surface-${REGISTRATION_A}`;

function mountRequest(
  registrationId: string,
  partition: string,
): BrowserViewGuestMountRequested {
  return {
    registrationId,
    partition,
  };
}

function queryHost(): HTMLElement | null {
  const host = document.querySelector(`[data-testid="${HOST_TEST_ID}"]`);
  return host instanceof HTMLElement ? host : null;
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

function TileProbe() {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  usePublishBrowserGuestTile({
    surfaceRef,
    registrationId: REGISTRATION_A,
    instanceId: "tile-1",
    viewTabId: "view-1",
    paneId: "pane-1",
    presented: true,
    tileKey: null,
  });
  return <div ref={surfaceRef} data-testid={SURFACE_TEST_ID} />;
}

function HostApp(props: { readonly bridge: FakeBrowserViewBridge }) {
  return (
    <RunnerHostProvider
      runnerHost={createFakeRunnerHost({ browserView: props.bridge })}
    >
      <PersistentBrowserGuestHost />
      <TileProbe />
    </RunnerHostProvider>
  );
}

afterEach(() => {
  // Unmount tears the host down through the component's own disposer;
  // publisher owners clear their placements on the same pass.
  cleanup();
});

describe("PersistentBrowserGuestHost", () => {
  it("does not create a webview host when the runner has no browserView", () => {
    render(
      <RunnerHostProvider runnerHost={createFakeRunnerHost({})}>
        <PersistentBrowserGuestHost />
      </RunnerHostProvider>,
    );

    expect(queryHost()).toBeNull();
    expect(document.querySelectorAll("webview")).toHaveLength(0);
  });

  it("keeps a mounted publisher presented across browserView replacement", () => {
    const firstBridge = new FakeBrowserViewBridge();
    const view = render(<HostApp bridge={firstBridge} />);
    const firstHost = queryHost();
    if (firstHost === null) throw new Error("expected persistent host");
    const surface = document.querySelector(
      `[data-testid="${SURFACE_TEST_ID}"]`,
    );
    if (!(surface instanceof HTMLElement)) {
      throw new Error("expected tile surface");
    }

    firstBridge.emitGuestMountRequested(
      mountRequest(REGISTRATION_A, PARTITION_A),
    );
    const firstGuest = queryWrapper(REGISTRATION_A);
    if (firstGuest === null) throw new Error("expected presented guest");
    expect(wrapperState(REGISTRATION_A)).toBe("presented");

    const secondBridge = new FakeBrowserViewBridge();
    view.rerender(<HostApp bridge={secondBridge} />);
    const replacementHost = queryHost();
    if (replacementHost === null) {
      throw new Error("expected replacement persistent host");
    }
    expect(replacementHost).not.toBe(firstHost);
    expect(queryWrapper(REGISTRATION_A)).toBeNull();
    expect(document.querySelector(`[data-testid="${SURFACE_TEST_ID}"]`)).toBe(
      surface,
    );

    firstBridge.emitGuestMountRequested(
      mountRequest(REGISTRATION_A, PARTITION_A),
    );
    expect(queryWrapper(REGISTRATION_A)).toBeNull();

    secondBridge.emitGuestMountRequested(
      mountRequest(REGISTRATION_A, PARTITION_A),
    );
    const remounted = queryWrapper(REGISTRATION_A);
    if (remounted === null) throw new Error("expected remounted guest");
    expect(remounted).not.toBe(firstGuest);
    expect(remounted.parentNode).toBe(replacementHost);
    expect(wrapperState(REGISTRATION_A)).toBe("presented");

    view.unmount();
    expect(queryHost()).toBeNull();
    expect(queryWrapper(REGISTRATION_A)).toBeNull();
    secondBridge.emitGuestMountRequested(
      mountRequest(REGISTRATION_A, PARTITION_A),
    );
    expect(queryHost()).toBeNull();
    expect(queryWrapper(REGISTRATION_A)).toBeNull();
  });
});
