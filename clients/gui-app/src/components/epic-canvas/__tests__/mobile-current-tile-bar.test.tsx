import "../../../../__tests__/test-browser-apis";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileCurrentTileBar } from "@/components/epic-canvas/mobile/mobile-current-tile-bar";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

// The live tile icon is covered by the tab-strip tests; stub it here so this
// test targets the bar's own composition (title, affordance, tap).
vi.mock("@/components/epic-canvas/canvas/tab-strip", () => ({
  TabIcon: () => <span data-testid="tab-icon" />,
  TabStrip: () => null,
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicTabDisplayTitle: (node: { readonly name: string }) => node.name,
  useEpicLiveArtifactTitleGenerating: () => false,
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

const TILE: EpicCanvasTileRef = {
  id: "spec-1",
  instanceId: "inst-1",
  type: "spec",
  name: "Life Philosophy",
  hostId: "host-A",
};

describe("<MobileCurrentTileBar />", () => {
  afterEach(cleanup);

  it("shows the current tile title, icon, and an accessible switch affordance", () => {
    render(
      <MobileCurrentTileBar
        epicId="epic-1"
        tile={TILE}
        onOpenSwitcher={() => undefined}
      />,
    );
    const bar = screen.getByTestId("mobile-current-tile-bar");
    expect(bar.textContent).toContain("Life Philosophy");
    expect(screen.getByTestId("tab-icon")).not.toBeNull();
    expect(bar.getAttribute("aria-label")).toContain("Life Philosophy");
  });

  it("invokes onOpenSwitcher when tapped", () => {
    const onOpenSwitcher = vi.fn();
    render(
      <MobileCurrentTileBar
        epicId="epic-1"
        tile={TILE}
        onOpenSwitcher={onOpenSwitcher}
      />,
    );
    fireEvent.click(screen.getByTestId("mobile-current-tile-bar"));
    expect(onOpenSwitcher).toHaveBeenCalledTimes(1);
  });
});
