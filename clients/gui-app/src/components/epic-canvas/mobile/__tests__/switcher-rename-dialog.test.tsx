import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SwitcherRenameDialog } from "../switcher-rename-dialog";

/**
 * Geometry contract for the mobile switcher's rename dialog: the same three
 * regions every dialog holding a text field uses. Return still saves here (the
 * form's `onSubmit`), so Save being reachable is a second route rather than the
 * only one - which is exactly why the shape has to be asserted rather than
 * assumed to have been noticed.
 */
describe("<SwitcherRenameDialog /> height cap and footer", () => {
  afterEach(cleanup);

  function renderDialog(): void {
    render(
      <SwitcherRenameDialog
        open
        onOpenChange={() => undefined}
        title="Rename agent"
        initialValue="Old name"
        nodeId="node-1"
        onSubmit={() => undefined}
      />,
    );
  }

  it("caps its height against the viewport", () => {
    renderDialog();

    const dialog = screen.getByTestId("switcher-rename-dialog");
    expect(dialog.className).toContain("max-h-[min(86dvh,calc(100dvh-2rem))]");
    expect(dialog.className).toContain("grid-rows-[auto_minmax(0,1fr)]");
  });

  it("keeps Save outside the scrolled field region", () => {
    renderDialog();

    const scroller = screen.getByTestId("switcher-rename-scroller");
    expect(scroller.className).toContain("overflow-y-auto");
    expect(scroller.contains(screen.getByLabelText("New name"))).toBe(true);

    const footer = screen
      .getByTestId("switcher-rename-dialog")
      .querySelector('[data-slot="dialog-footer"]');
    expect(footer).not.toBeNull();
    expect(scroller.contains(footer)).toBe(false);
    expect(
      footer?.contains(screen.getByTestId("switcher-rename-save-node-1")),
    ).toBe(true);
  });
});
