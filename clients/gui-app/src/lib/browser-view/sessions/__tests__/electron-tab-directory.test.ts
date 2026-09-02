import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type {
  BrowserViewAttachSurface,
  BrowserViewNativeTabCapability,
} from "@traycer-clients/shared/platform/browser-view";
import {
  publishElectronTabBinding,
  removeOwnedElectronTabBinding,
  removeOwnedElectronTabBindings,
  useElectronTabBindingOnHost,
  type ElectronTabBinding,
} from "@/lib/browser-view/sessions/electron-tab-directory";
import { FakeBrowserViewBridge } from "@/lib/browser-view/__tests__/fake-browser-view-bridge";

const CAPABILITY: BrowserViewNativeTabCapability = {
  hostId: "host-1",
  sessionId: "sess-1",
  tabId: "tab-1",
  registrationId: "native:tab-1",
};

type SurfaceInput = Omit<
  BrowserViewAttachSurface,
  keyof BrowserViewNativeTabCapability
>;

function surfaceInput(bindingId: string): SurfaceInput {
  return {
    bindingId,
    surface: {
      viewTabId: "view-1",
      paneId: "pane-1",
      tileInstanceId: `tile-${bindingId}`,
      pageSessionId: "page-1",
    },
  };
}

/** The published binding, read the way a tile reads it. */
function publishedBinding(
  capability: BrowserViewNativeTabCapability,
): ElectronTabBinding {
  const { result } = renderHook(() =>
    useElectronTabBindingOnHost(
      capability.sessionId,
      capability.tabId,
      capability.hostId,
    ),
  );
  const binding = result.current;
  if (binding === null) throw new Error("expected a published binding");
  return binding;
}

describe("publishElectronTabBinding surface serialization", () => {
  it("keeps one attach/detach chain across a republish of the same tab", async () => {
    const bridge = new FakeBrowserViewBridge();
    const owner = Symbol("owner");
    publishElectronTabBinding(owner, bridge, CAPABILITY);
    const first = await publishedBinding(CAPABILITY).bindSurface(
      surfaceInput("binding-1"),
    );

    // A second `tabBound` for the SAME tab, with no removal in between. While
    // the chain lived in the publishing closure this republished binding
    // started its own, so the old lease's detach could interleave with the new
    // attach - which main refuses, leaving the tile blank.
    publishElectronTabBinding(owner, bridge, CAPABILITY);
    const second = publishedBinding(CAPABILITY).bindSurface(
      surfaceInput("binding-2"),
    );
    await Promise.all([second, first.detach()]);

    expect(bridge.surfaceCalls).toEqual([
      "attach:binding-1",
      "detach:binding-1",
      "attach:binding-2",
    ]);

    removeOwnedElectronTabBindings(owner);
  });

  it("re-attaches a still-live tab after a stream retirement republishes it", async () => {
    // RULE: retiring this renderer's bindings on a non-live transition tells
    // MAIN nothing - the native tab survives with the old `bindingId` still
    // attached, and main refuses a second attach while it does. So the chain
    // has to survive the retirement and detach the old surface first. Dropping
    // it started a fresh chain that attached against a surface main had not
    // released, and the tile came back blank.
    const capability: BrowserViewNativeTabCapability = {
      ...CAPABILITY,
      tabId: "tab-retired",
      registrationId: "native:tab-retired",
    };
    const bridge = new FakeBrowserViewBridge();
    const owner = Symbol("owner");
    publishElectronTabBinding(owner, bridge, capability);
    const first = await publishedBinding(capability).bindSurface(
      surfaceInput("binding-1"),
    );

    // The stream drops: the coordinator retires every binding it published.
    removeOwnedElectronTabBindings(owner);

    // It returns, the tab is republished, and the old tile's effect cleanup
    // releases its lease against the new incarnation.
    publishElectronTabBinding(owner, bridge, capability);
    const second = publishedBinding(capability).bindSurface(
      surfaceInput("binding-2"),
    );
    await Promise.all([second, first.detach()]);

    // `binding-1` is detached exactly once, before `binding-2` attaches, and
    // never after it.
    expect(bridge.surfaceCalls).toEqual([
      "attach:binding-1",
      "detach:binding-1",
      "attach:binding-2",
    ]);
  });

  it("starts a clean chain after a genuine tab release", async () => {
    // The counterpart: `tabReleased` means main already dropped the native
    // entry, so the recorded surface names nothing and a later incarnation of
    // the same tab must not open by detaching it.
    const capability: BrowserViewNativeTabCapability = {
      ...CAPABILITY,
      tabId: "tab-released",
      registrationId: "native:tab-released",
    };
    const bridge = new FakeBrowserViewBridge();
    const owner = Symbol("owner");
    publishElectronTabBinding(owner, bridge, capability);
    await publishedBinding(capability).bindSurface(surfaceInput("binding-1"));

    removeOwnedElectronTabBinding(owner, capability);

    publishElectronTabBinding(owner, bridge, capability);
    await publishedBinding(capability).bindSurface(surfaceInput("binding-2"));

    expect(bridge.surfaceCalls).toEqual([
      "attach:binding-1",
      "attach:binding-2",
    ]);

    removeOwnedElectronTabBinding(owner, capability);
  });
});
