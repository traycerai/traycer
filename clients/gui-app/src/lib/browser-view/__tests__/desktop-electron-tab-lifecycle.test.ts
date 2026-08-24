import { describe, expect, it } from "vitest";
import {
  resolveDesktopBrowserViewBridge,
  resolveDesktopElectronTabLifecycleBridge,
} from "@/lib/browser-view/desktop-browser-view";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";

const LIFECYCLE_METHODS = [
  "ensureTab",
  "attachSurface",
  "detachSurface",
  "releaseTab",
  "controlElectronTab",
  "dispatchElectronTabCdp",
  "onNativeTabStatusChange",
  "onNativeTabCdpSessionEnded",
  "onNativeTabCdpTargetAttached",
  "onElectronTabHandoff",
] as const;

function completeLifecycle(): Record<string, unknown> {
  return Object.fromEntries(
    LIFECYCLE_METHODS.map((name) => [name, () => undefined]),
  );
}

function runnerHost(browserView: Record<string, unknown>) {
  return Object.assign(createFakeRunnerHost({}), { browserView });
}

describe("resolveDesktopElectronTabLifecycleBridge", () => {
  it("requires the complete lifecycle and CDP seam", () => {
    expect(
      resolveDesktopElectronTabLifecycleBridge(runnerHost(completeLifecycle())),
    ).not.toBeNull();

    for (const missing of LIFECYCLE_METHODS) {
      const browserView = completeLifecycle();
      delete browserView[missing];
      expect(
        resolveDesktopElectronTabLifecycleBridge(runnerHost(browserView)),
      ).toBeNull();
    }
  });

  it("does not infer lifecycle readiness from profile capture", () => {
    expect(
      resolveDesktopElectronTabLifecycleBridge(
        runnerHost({ capturePrimaryProfile: () => undefined }),
      ),
    ).toBeNull();
  });

  it("keeps lifecycle methods out of the general browser-view capability", () => {
    const browserView = new Proxy<Record<string, unknown>>(
      {},
      {
        get: (_target, property) =>
          property === "capturePrimaryProfile" || property === "overlayPaintAck"
            ? undefined
            : () => undefined,
      },
    );

    const bridge = resolveDesktopBrowserViewBridge(runnerHost(browserView));

    expect(bridge).not.toBeNull();
    if (bridge === null) throw new Error("Expected the general bridge.");
    for (const method of LIFECYCLE_METHODS) {
      expect(method in bridge).toBe(false);
    }
    expect("capturePrimaryProfile" in bridge).toBe(false);
    expect("overlayPaintAck" in bridge).toBe(false);
  });
});
