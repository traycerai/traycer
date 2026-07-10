import "../../../../../__tests__/test-browser-apis";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TileFindScope } from "@/components/epic-canvas/tile-find/tile-find-scope";
import { PaneVisibilityContext } from "@/components/epic-tabs/pane-visibility-context";
import { TILE_KIND_BLANK } from "@/stores/epics/canvas/tile-kinds";
import type { BlankTileRef } from "@/stores/epics/canvas/types";
import { useTileFindStore } from "@/stores/tile-find";

function makeBlankNode(instanceId: string): BlankTileRef {
  return {
    id: `${instanceId}-content`,
    instanceId,
    type: TILE_KIND_BLANK,
    name: "New tab",
    hostId: "host-1",
  };
}

describe("<TileFindScope />", () => {
  afterEach(() => {
    cleanup();
    useTileFindStore.getState().resetForTests();
  });

  it("excludes a hidden pane's active tile from find ownership, and transfers ownership when its pane becomes visible", () => {
    // The visible epic tab's active tile registers first.
    render(
      <PaneVisibilityContext.Provider value>
        <TileFindScope
          node={makeBlankNode("visible-tile")}
          viewTabId="view-visible"
          tileId="pane-visible"
          epicId="epic-1"
          isActive
        >
          <div />
        </TileFindScope>
      </PaneVisibilityContext.Provider>,
    );

    // A previously selected epic tab stays mounted (keep-alive) with its pane
    // hidden. It re-registers its active tile after the visible tab, so its
    // `registeredAt` outranks the visible tile's - the bug's exact trigger.
    const hidden = render(
      <PaneVisibilityContext.Provider value={false}>
        <TileFindScope
          node={makeBlankNode("hidden-tile")}
          viewTabId="view-hidden"
          tileId="pane-hidden"
          epicId="epic-1"
          isActive
        >
          <div />
        </TileFindScope>
      </PaneVisibilityContext.Provider>,
    );

    expect(useTileFindStore.getState().activeOwner?.tileInstanceId).toBe(
      "visible-tile",
    );

    // Switching tabs flips the hidden pane's visibility to true.
    act(() => {
      hidden.rerender(
        <PaneVisibilityContext.Provider value>
          <TileFindScope
            node={makeBlankNode("hidden-tile")}
            viewTabId="view-hidden"
            tileId="pane-hidden"
            epicId="epic-1"
            isActive
          >
            <div />
          </TileFindScope>
        </PaneVisibilityContext.Provider>,
      );
    });

    expect(useTileFindStore.getState().activeOwner?.tileInstanceId).toBe(
      "hidden-tile",
    );
  });
});
