import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PanelLeft } from "lucide-react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LayoutFormRow } from "@/components/layout-editor/inspector/rows/layout-form-row";

afterEach(cleanup);

function renderRow(
  stacked: boolean,
  onRevert: (() => void) | null,
  selected: boolean,
): HTMLElement {
  const control: ReactNode = <button type="button">The control</button>;
  const { container } = render(
    <LayoutFormRow
      anchor={null}
      icon={PanelLeft}
      label="Side"
      description="Which side the sidebar takes."
      control={control}
      onRevert={onRevert}
      revertLabel="Revert Side"
      stacked={stacked}
      selected={selected}
    />,
  );
  const row = container.querySelector<HTMLElement>("[data-layout-form-row]");
  if (row === null) throw new Error("no form row");
  return row;
}

/** The row's direct child that holds `node`. */
function columnOf(row: HTMLElement, node: HTMLElement): Element {
  const column = [...row.children].find((child) => child.contains(node));
  if (column === undefined) throw new Error("node is not in the row");
  return column;
}

describe("LayoutFormRow", () => {
  it("puts a stacked row's control after the label block, with no chevron slot after it", () => {
    const row = renderRow(true, null, false);
    const label = columnOf(row, screen.getByText("Side"));
    const control = columnOf(
      row,
      screen.getByRole("button", { name: "The control" }),
    );

    // The control gets its own block after the label and description, rather
    // than a column beside them.
    expect(label).not.toBe(control);
    expect(
      label.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      label.contains(screen.getByText("Which side the sidebar takes.")),
    ).toBe(true);
    expect(row.lastElementChild).toBe(control);
  });

  it("keeps an unstacked row's control in a column beside the label, before the chevron slot", () => {
    const row = renderRow(false, null, false);
    const control = columnOf(
      row,
      screen.getByRole("button", { name: "The control" }),
    );

    // The last child is the reserved chevron slot, so this control's right
    // edge lines up with a list row's.
    expect(control.nextElementSibling).toBe(row.lastElementChild);
    expect(row.lastElementChild?.getAttribute("aria-hidden")).toBe("true");
  });

  it("draws the revert after the label only while the row is changed", async () => {
    renderRow(false, null, false);
    expect(screen.queryByRole("button", { name: "Revert Side" })).toBeNull();
    cleanup();

    const onRevert = vi.fn();
    renderRow(false, onRevert, false);
    const revert = screen.getByRole("button", { name: "Revert Side" });
    expect(
      screen.getByText("Side").compareDocumentPosition(revert) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // No dot beside it: the revert is the row's changed signal.
    expect(screen.queryByTestId("changed-dot")).toBeNull();

    await userEvent.setup().click(revert);
    expect(onRevert).toHaveBeenCalledTimes(1);
  });

  it("carries the selected highlight only while selected is true", () => {
    const row = renderRow(false, null, false);
    expect(row.className).not.toContain("bg-foreground/6");
    cleanup();

    const selectedRow = renderRow(false, null, true);
    expect(selectedRow.className).toContain("bg-foreground/6");
  });
});
