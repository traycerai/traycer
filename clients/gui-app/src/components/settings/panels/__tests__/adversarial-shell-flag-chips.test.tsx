import "../../../../../__tests__/test-browser-apis";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShellFlagChips } from "@/components/settings/panels/shell/shell-flag-chips";

afterEach(cleanup);

function renderChips(props: {
  readonly args: readonly string[];
  readonly disabled: boolean | undefined;
  readonly onAdd: ((flag: string) => void) | undefined;
  readonly onRemove: ((index: number) => void) | undefined;
}) {
  render(
    <ShellFlagChips
      args={props.args}
      disabled={props.disabled ?? false}
      onAdd={props.onAdd ?? (() => undefined)}
      onRemove={props.onRemove ?? (() => undefined)}
    />,
  );
}

function startAdding(): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: "＋ flag" }));
  return screen.getByRole("textbox", { name: "New shell flag" });
}

describe("adversarial: ShellFlagChips input edge cases", () => {
  it("does not add an empty or whitespace-only flag on Enter", () => {
    const onAdd = vi.fn();
    renderChips({ args: [], disabled: undefined, onAdd, onRemove: undefined });
    const input = startAdding();
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("adds a trimmed flag exactly once on Enter (no Enter+blur double-commit)", () => {
    const onAdd = vi.fn();
    renderChips({ args: [], disabled: undefined, onAdd, onRemove: undefined });
    const input = startAdding();
    fireEvent.change(input, { target: { value: "  -x  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    // Enter commits and closes the input; the flag must land exactly once even
    // though the input then unmounts (a stray blur must not re-commit).
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith("-x");
  });

  it("cancels on Escape without adding", () => {
    const onAdd = vi.fn();
    renderChips({ args: [], disabled: undefined, onAdd, onRemove: undefined });
    const input = startAdding();
    fireEvent.change(input, { target: { value: "-l" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onAdd).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("textbox", { name: "New shell flag" }),
    ).toBeNull();
  });

  it("commits a pending draft on blur", () => {
    const onAdd = vi.fn();
    renderChips({ args: [], disabled: undefined, onAdd, onRemove: undefined });
    const input = startAdding();
    fireEvent.change(input, { target: { value: "-i" } });
    fireEvent.blur(input);
    expect(onAdd).toHaveBeenCalledWith("-i");
  });

  it("removes the correct occurrence index for duplicate flags", () => {
    const onRemove = vi.fn();
    // Two identical "-o" chips: removing the second must pass index 3, not 1.
    renderChips({
      args: ["-a", "-o", "-b", "-o"],
      disabled: undefined,
      onAdd: undefined,
      onRemove,
    });
    const removeButtons = screen.getAllByRole("button", {
      name: "Remove flag -o",
    });
    expect(removeButtons).toHaveLength(2);
    fireEvent.click(removeButtons[1]);
    expect(onRemove).toHaveBeenCalledWith(3);
  });

  it("shows the 'No flags' hint only when empty and not adding", () => {
    renderChips({
      args: [],
      disabled: undefined,
      onAdd: undefined,
      onRemove: undefined,
    });
    expect(screen.getByText("No flags")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "＋ flag" }));
    expect(screen.queryByText("No flags")).toBeNull();
  });

  it("disables the add affordance and chip removals when disabled", () => {
    renderChips({
      args: ["-i"],
      disabled: true,
      onAdd: undefined,
      onRemove: undefined,
    });
    expect(screen.getByRole("button", { name: "＋ flag" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(
      screen.getByRole("button", { name: "Remove flag -i" }),
    ).toHaveProperty("disabled", true);
  });
});
