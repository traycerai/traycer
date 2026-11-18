import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { HEADER_TAB_DND_TYPE } from "../../header-tab-dnd";
import { SideTabDragOverlay } from "../side-tab-drag-overlay";
import type { HeaderStripItem } from "@/stores/tabs/use-header-tabs";

afterEach(() => cleanup());

const PAIR: HeaderStripItem = {
  kind: "split",
  id: "split:lost-empty",
  focusedSide: "left",
  left: {
    kind: "fillable",
    slot: {
      kind: "unavailable",
      previousRef: { kind: "epic", id: "lost" },
      label: "Lost chat",
    },
  },
  right: { kind: "fillable", slot: { kind: "empty" } },
};

describe("SideTabDragOverlay on a split pair with a half to fill", () => {
  it("draws the Plus only on the half that offers a view, as the strip's row does", () => {
    render(
      <SideTabDragOverlay
        item={PAIR}
        ghost={null}
        size={null}
        source={{
          kind: HEADER_TAB_DND_TYPE,
          stripItemId: PAIR.id,
          tabKind: "epic",
          tabId: "lost",
          index: 0,
        }}
        isActive={false}
      />,
    );

    const overlay = screen.getByTestId(`split-tab-group-overlay-${PAIR.id}`);
    const titleOf = (label: string): HTMLElement => {
      const title = within(overlay)
        .getAllByTestId("side-tab-title")
        .find((candidate) => candidate.textContent === label);
      if (title === undefined) throw new Error(`no title ${label}`);
      return title;
    };
    expect(titleOf("Lost chat").querySelector("svg")).toBeNull();
    expect(titleOf("Choose a view").querySelector("svg")).not.toBeNull();
  });
});
