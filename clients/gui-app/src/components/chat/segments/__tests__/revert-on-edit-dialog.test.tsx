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
    expect(screen.getByRole("dialog").textContent).toMatch(
      /2 queued messages stay queued and will send after the edited message when the queue next runs/i,
    );
  });

  it("uses singular wording for a single parked item", () => {
    render(
      <RevertOnEditDialog
        open
        onOpenChange={onOpenChange}
        onRevert={onRevert}
        onDontRevert={onDontRevert}
        artifactCount={0}
        queuedCount={1}
      />,
    );
    expect(screen.getByRole("dialog").textContent).toMatch(
      /1 queued message stays queued and will send after the edited message when the queue next runs/i,
    );
  });

  it("omits the note when the queue is empty", () => {
    render(renderDialog(true));
    expect(screen.getByRole("dialog").textContent).not.toMatch(
      /queued message/i,
    );
  });
});

/**
 * A windowed transcript whose history below the edit point is not hydrated
 * cannot count the artifacts in scope. The opt-out still has to appear: it
 * defaults to CHECKED, so hiding it would revert artifacts with nothing on
 * screen saying so - and the host reverts the true scope regardless of what
 * this side could see.
 */
describe("<RevertOnEditDialog /> uncountable artifact scope", () => {
  afterEach(() => {
    cleanup();
  });

  it("still offers the opt-out when the count is unknown", () => {
    render(
      <RevertOnEditDialog
        open
        onOpenChange={onOpenChange}
        onRevert={onRevert}
        onDontRevert={onDontRevert}
        artifactCount={null}
        queuedCount={0}
      />,
    );
    const checkbox = screen.getByRole("checkbox", { name: /also revert/i });
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
  });

  it("states no number rather than an under-count", () => {
    render(
      <RevertOnEditDialog
        open
        onOpenChange={onOpenChange}
        onRevert={onRevert}
        onDontRevert={onDontRevert}
        artifactCount={null}
        queuedCount={0}
      />,
    );
    const label = screen.getByRole("dialog").textContent;
    expect(label).toMatch(/also revert artifacts changed since this message/i);
    // A digit here would be a measurement the client is not in a position to
    // make - the failure this whole three-state exists to prevent.
    expect(label).not.toMatch(/also revert \d+ artifact/i);
  });
});
