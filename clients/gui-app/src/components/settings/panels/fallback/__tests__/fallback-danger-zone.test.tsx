import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FallbackDangerZone } from "@/components/settings/panels/fallback/fallback-danger-zone";

afterEach(() => {
  cleanup();
});

function openConfirmDialog(): void {
  fireEvent.click(screen.getByRole("button", { name: "Reset" }));
}

describe("FallbackDangerZone - confirm dialog scope", () => {
  it("names the host when one is resolved", () => {
    render(
      <FallbackDangerZone
        hostLabel="Anurag's MacBook"
        isPending={false}
        onConfirm={vi.fn()}
        status={null}
      />,
    );
    openConfirmDialog();
    expect(
      screen.getByText(/Applies to your chat agents on Anurag's MacBook\./),
    ).not.toBeNull();
  });

  it("drops the scope clause entirely when no host is resolved, rather than naming 'No host'", () => {
    render(
      <FallbackDangerZone
        hostLabel={null}
        isPending={false}
        onConfirm={vi.fn()}
        status={null}
      />,
    );
    openConfirmDialog();
    // The negative pin: stub `resetConfirmDescription` to always append the
    // host clause (or to render "on No host" for a null label) and this
    // assertion goes red.
    expect(screen.queryByText(/Applies to your chat agents on/)).toBeNull();
    // Positive control: the dialog still rendered its (host-independent)
    // description, so the absence above is the clause missing, not the
    // dialog failing to open.
    expect(screen.getByText(/Turns automatic fallback off/)).not.toBeNull();
  });

  it("invokes onConfirm only after the destructive action is confirmed, not on opening the dialog", () => {
    const onConfirm = vi.fn();
    render(
      <FallbackDangerZone
        hostLabel="Local host"
        isPending={false}
        onConfirm={onConfirm}
        status={null}
      />,
    );
    openConfirmDialog();
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("confirm-action"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
