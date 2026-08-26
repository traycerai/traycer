import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InlineTitleField } from "@/components/epic-canvas/mobile/inline-title-field";

const onCommit = vi.fn();

const DEFAULT_PROPS = {
  value: "Original title",
  editable: true,
  onCommit,
  inputLabel: "Title",
  testId: "title-field",
  className: "truncate",
};

function openEdit(): HTMLElement {
  fireEvent.click(screen.getByTestId("title-field"));
  return screen.getByTestId("title-field-input");
}

describe("<InlineTitleField />", () => {
  beforeEach(() => onCommit.mockClear());
  afterEach(cleanup);

  it("renders a button showing the value when editable and not editing", () => {
    render(<InlineTitleField {...DEFAULT_PROPS} />);
    const el = screen.getByTestId("title-field");
    expect(el.tagName).toBe("BUTTON");
    expect(el.textContent).toBe("Original title");
  });

  it("renders a plain span (no control) when not editable", () => {
    render(<InlineTitleField {...DEFAULT_PROPS} editable={false} />);
    const el = screen.getByTestId("title-field");
    expect(el.tagName).toBe("SPAN");
    expect(el.textContent).toBe("Original title");
  });

  it("tapping the button enters edit mode with an autofocused, labelled input", () => {
    render(<InlineTitleField {...DEFAULT_PROPS} />);
    const input = openEdit();
    expect(input.tagName).toBe("INPUT");
    expect(input.getAttribute("aria-label")).toBe("Title");
    expect(document.activeElement).toBe(input);
  });

  it("commits the trimmed value on blur", () => {
    render(<InlineTitleField {...DEFAULT_PROPS} />);
    const input = openEdit();
    fireEvent.change(input, { target: { value: "  New title  " } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("New title");
  });

  it("Enter commits exactly once (no double commit via the blur it triggers)", () => {
    render(<InlineTitleField {...DEFAULT_PROPS} />);
    const input = openEdit();
    fireEvent.change(input, { target: { value: "New title" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("New title");
  });

  it("Escape cancels the edit without committing and restores the button", () => {
    render(<InlineTitleField {...DEFAULT_PROPS} />);
    const input = openEdit();
    fireEvent.change(input, { target: { value: "Discarded" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onCommit).not.toHaveBeenCalled();
    const el = screen.getByTestId("title-field");
    expect(el.tagName).toBe("BUTTON");
    expect(el.textContent).toBe("Original title");
  });

  it("an empty/whitespace-only value is never committed", () => {
    render(<InlineTitleField {...DEFAULT_PROPS} />);
    const input = openEdit();
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByTestId("title-field").textContent).toBe(
      "Original title",
    );
  });

  it("a value unchanged from the original is never committed", () => {
    render(<InlineTitleField {...DEFAULT_PROPS} />);
    const input = openEdit();
    fireEvent.change(input, { target: { value: "Original title" } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });
});
