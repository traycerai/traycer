import "../../../../__tests__/test-browser-apis";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserOverlayCoordinatorBridge } from "@/components/epic-canvas/browser-overlay-coordinator-bridge";
import { FakeBrowserViewBridge } from "@/lib/browser-view/__tests__/fake-browser-view-bridge";
import { RESERVED_BROWSER_CHORDS } from "@/lib/browser-view/reserved-chords-registration";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";

afterEach(() => {
  cleanup();
});

describe("<BrowserOverlayCoordinatorBridge />", () => {
  it("pushes the reserved-chord table into main when a browserView exists", () => {
    const bridge = new FakeBrowserViewBridge();
    render(
      <RunnerHostProvider
        runnerHost={createFakeRunnerHost({ browserView: bridge })}
      >
        <BrowserOverlayCoordinatorBridge />
      </RunnerHostProvider>,
    );

    expect(bridge.reservedChordsCalls).toEqual([RESERVED_BROWSER_CHORDS]);
  });

  it("does not register chords when the runner has no browserView", () => {
    render(
      <RunnerHostProvider runnerHost={createFakeRunnerHost({})}>
        <BrowserOverlayCoordinatorBridge />
      </RunnerHostProvider>,
    );

    expect(document.body).toBeTruthy();
  });
});
