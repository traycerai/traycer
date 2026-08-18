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
      queuedCount={0}
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

describe("<RevertOnEditDialog /> queued-messages note", () => {
  afterEach(() => {
    cleanup();
  });

  it("names parked queue items so the edit doesn't silently carry them", () => {
    render(
      <RevertOnEditDialog
        open
        onOpenChange={onOpenChange}
        onRevert={onRevert}
        onDontRevert={onDontRevert}
        artifactCount={0}
        queuedCount={2}
      />,
    );
    expect(
      screen.getByText(
        /2 queued messages stay queued and send after the edited message/i,
      ),
    ).toBeTruthy();
  });

  it("omits the note when the queue is empty", () => {
    render(renderDialog(true));
    expect(screen.queryByText(/queued message/i)).toBeNull();
  });
});
