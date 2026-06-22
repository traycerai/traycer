import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RevertOnEditDialog } from "@/components/chat/segments/revert-on-edit-dialog";

const onOpenChange = vi.fn();
const onRevert = vi.fn();
const onDontRevert = vi.fn();

function renderDialog(open: boolean) {
  return (
    <RevertOnEditDialog
      open={open}
      onOpenChange={onOpenChange}
      onRevert={onRevert}
      onDontRevert={onDontRevert}
      artifactCount={2}
    />
  );
}

describe("<RevertOnEditDialog /> opt-out reset", () => {
  afterEach(() => {
    cleanup();
  });

  it("resets 'Also revert artifacts' to checked each time it reopens", () => {
    const { rerender } = render(renderDialog(true));

    const checkbox = () =>
      screen.getByRole("checkbox", { name: /also revert/i });
    expect(checkbox().getAttribute("aria-checked")).toBe("true");

    // User opts out for this edit.
    fireEvent.click(checkbox());
    expect(checkbox().getAttribute("aria-checked")).toBe("false");

    // Close, then reopen for a DIFFERENT edit: the always-mounted dialog must
    // not carry the prior opt-out - it resets to checked.
    rerender(renderDialog(false));
    rerender(renderDialog(true));
    expect(checkbox().getAttribute("aria-checked")).toBe("true");
  });
});
