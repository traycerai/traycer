import "../../../../../__tests__/test-browser-apis";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const tileNavigationMocks = vi.hoisted(() => ({
  openTileInEpic: vi.fn(),
  openTileInTab: vi.fn(),
  openTilePreviewInEpic: vi.fn(),
  openTilePreviewInTab: vi.fn(),
}));
vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => tileNavigationMocks,
}));

import { CommGraphOpenButton } from "@/components/epic-canvas/comm-graph/comm-graph-open-button";
import { makeCommGraphTileRef } from "@/stores/epics/canvas/tile-schema/comm-graph-tile";

const EPIC_ID = "epic-open-button";

afterEach(() => {
  cleanup();
  tileNavigationMocks.openTileInEpic.mockClear();
});

describe("CommGraphOpenButton", () => {
  it("opens the epic's graph tile", () => {
    render(
      <CommGraphOpenButton epicId={EPIC_ID} disabled={false} className="" />,
    );

    fireEvent.click(screen.getByTestId("epic-sidebar-open-comm-graph"));

    expect(tileNavigationMocks.openTileInEpic).toHaveBeenCalledWith(
      EPIC_ID,
      // `instanceId` is a fresh uuid per ref by design; the CONTENT id is what
      // identifies the tile and what the opener dedupes on.
      expect.objectContaining({
        id: makeCommGraphTileRef(EPIC_ID).id,
        type: "comm-graph",
        epicId: EPIC_ID,
      }),
    );
  });

  /**
   * The graph tile's content id is derived from the epic rather than minted per
   * instance, and `openTile` focuses an existing tab with that id. Two presses
   * must therefore reach the SAME ref - a second tab sharing that id would have
   * two writers for the graph's persisted viewport.
   */
  it("asks for the same epic-derived ref every time, so the opener can dedupe", () => {
    render(
      <CommGraphOpenButton epicId={EPIC_ID} disabled={false} className="" />,
    );

    const button = screen.getByTestId("epic-sidebar-open-comm-graph");
    fireEvent.click(button);
    fireEvent.click(button);

    expect(tileNavigationMocks.openTileInEpic).toHaveBeenCalledTimes(2);
    // Same content id both times - that, not the per-call `instanceId`, is what
    // makes the second press focus the open graph instead of minting a rival.
    const contentId = makeCommGraphTileRef(EPIC_ID).id;
    expect(tileNavigationMocks.openTileInEpic).toHaveBeenNthCalledWith(
      1,
      EPIC_ID,
      expect.objectContaining({ id: contentId }),
    );
    expect(tileNavigationMocks.openTileInEpic).toHaveBeenNthCalledWith(
      2,
      EPIC_ID,
      expect.objectContaining({ id: contentId }),
    );
  });

  it("does not open while the panel is collapsed", () => {
    render(<CommGraphOpenButton epicId={EPIC_ID} disabled className="" />);

    fireEvent.click(screen.getByTestId("epic-sidebar-open-comm-graph"));

    expect(tileNavigationMocks.openTileInEpic).not.toHaveBeenCalled();
  });
});
