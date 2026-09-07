import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DropdownMenu,
  DropdownMenuContent,
} from "@/components/ui/dropdown-menu";

const tileNavigationMocks = vi.hoisted(() => ({
  openTile: vi.fn(),
}));
vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => tileNavigationMocks,
}));

import {
  CommGraphOpenButton,
  CommGraphOpenMenuItem,
} from "@/components/epic-canvas/comm-graph/comm-graph-open-button";
import { makeCommGraphTileRef } from "@/stores/epics/canvas/tile-schema/comm-graph-tile";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

const EPIC_ID = "epic-open-button";

afterEach(() => {
  cleanup();
  tileNavigationMocks.openTile.mockClear();
});

describe("CommGraphOpenButton", () => {
  it("opens the epic's graph tile", () => {
    render(
      <CommGraphOpenButton epicId={EPIC_ID} disabled={false} className="" />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open communication graph" }),
    );

    expect(tileNavigationMocks.openTile).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { epicId: EPIC_ID },
        gesture: "explicit",
        modifiers: null,
        placement: null,
        dedupe: true,
        // `instanceId` is a fresh uuid per ref by design; the CONTENT id is what
        // identifies the tile and what the opener dedupes on.
        node: expect.objectContaining({
          id: makeCommGraphTileRef(EPIC_ID).id,
          type: "comm-graph",
          epicId: EPIC_ID,
        }) as EpicCanvasTileRef,
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

    const button = screen.getByRole("button", {
      name: "Open communication graph",
    });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(tileNavigationMocks.openTile).toHaveBeenCalledTimes(2);
    // Same content id both times - that, not the per-call `instanceId`, is what
    // makes the second press focus the open graph instead of minting a rival.
    const contentId = makeCommGraphTileRef(EPIC_ID).id;
    expect(tileNavigationMocks.openTile).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        target: { epicId: EPIC_ID },
        dedupe: true,
        node: expect.objectContaining({ id: contentId }) as EpicCanvasTileRef,
      }),
    );
    expect(tileNavigationMocks.openTile).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        target: { epicId: EPIC_ID },
        dedupe: true,
        node: expect.objectContaining({ id: contentId }) as EpicCanvasTileRef,
      }),
    );
  });

  it("does not open while the panel is collapsed", () => {
    render(<CommGraphOpenButton epicId={EPIC_ID} disabled className="" />);

    fireEvent.click(
      screen.getByRole("button", { name: "Open communication graph" }),
    );

    expect(tileNavigationMocks.openTile).not.toHaveBeenCalled();
  });
});

describe("CommGraphOpenMenuItem", () => {
  it("opens the epic's graph tile from the compact overflow menu", () => {
    render(
      <DropdownMenu open>
        <DropdownMenuContent>
          <CommGraphOpenMenuItem epicId={EPIC_ID} disabled={false} />
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    fireEvent.click(
      screen.getByRole("menuitem", { name: "Open communication graph" }),
    );

    expect(tileNavigationMocks.openTile).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { epicId: EPIC_ID },
        gesture: "explicit",
        modifiers: null,
        placement: null,
        dedupe: true,
        node: expect.objectContaining({
          id: makeCommGraphTileRef(EPIC_ID).id,
          type: "comm-graph",
          epicId: EPIC_ID,
        }) as EpicCanvasTileRef,
      }),
    );
  });
});
