import "../../../../../__tests__/test-browser-apis";
import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";
import {
  SidebarBulkSelectionProvider,
  useSidebarBulkSelection,
} from "../epic-sidebar-selection";

const INITIAL_IDS = ["chat-a", "chat-b"] as const;
const FILTERED_IDS = ["chat-b"] as const;

function SelectionHarness(props: { readonly ids: readonly string[] }) {
  const selection = useSidebarBulkSelection();
  const setSelectableIds = selection.setSelectableIds;
  useEffect(() => {
    setSelectableIds(props.ids);
  }, [props.ids, setSelectableIds]);
  return (
    <>
      <button type="button" onClick={selection.enterSelectionMode}>
        Enter selection
      </button>
      <button type="button" onClick={() => selection.toggleSelection("chat-a")}>
        Select chat A
      </button>
      <output data-testid="selectable-ids">
        {selection.selectableIds.join(",")}
      </output>
      <output data-testid="selected-ids">
        {selection.selectedVisibleIds.join(",")}
      </output>
    </>
  );
}

describe("SidebarBulkSelectionProvider", () => {
  it("reconciles selected rows when a shared filter changes", () => {
    const { rerender } = render(
      <SidebarBulkSelectionProvider panelId="chats" collapsed={false}>
        <SelectionHarness ids={INITIAL_IDS} />
      </SidebarBulkSelectionProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Enter selection" }));
    fireEvent.click(screen.getByRole("button", { name: "Select chat A" }));
    expect(screen.getByTestId("selected-ids").textContent).toBe("chat-a");

    rerender(
      <SidebarBulkSelectionProvider panelId="chats" collapsed={false}>
        <SelectionHarness ids={FILTERED_IDS} />
      </SidebarBulkSelectionProvider>,
    );

    expect(screen.getByTestId("selectable-ids").textContent).toBe("chat-b");
    expect(screen.getByTestId("selected-ids").textContent).toBe("");
  });
});
