import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type {
  BrowserViewAttachSurface,
  BrowserViewNativeTabCapability,
} from "@traycer-clients/shared/platform/browser-view";
import {
  publishElectronTabBinding,
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
function publishedBinding(): ElectronTabBinding {
  const { result } = renderHook(() =>
    useElectronTabBindingOnHost(
      CAPABILITY.sessionId,
      CAPABILITY.tabId,
      CAPABILITY.hostId,
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
    const first = await publishedBinding().bindSurface(
      surfaceInput("binding-1"),
    );

    // A second `tabBound` for the SAME tab, with no removal in between. While
    // the chain lived in the publishing closure this republished binding
    // started its own, so the old lease's detach could interleave with the new
    // attach - which main refuses, leaving the tile blank.
    publishElectronTabBinding(owner, bridge, CAPABILITY);
    const second = publishedBinding().bindSurface(surfaceInput("binding-2"));
    await Promise.all([second, first.detach()]);

    expect(bridge.surfaceCalls).toEqual([
      "attach:binding-1",
      "detach:binding-1",
      "attach:binding-2",
    ]);

    removeOwnedElectronTabBindings(owner);
  });
});
