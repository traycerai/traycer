import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InlineTitleField } from "@/components/epic-canvas/mobile/inline-title-field";
import { LONG_PRESS_MS } from "@/hooks/ui/use-long-press";

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
  fireEvent.keyDown(screen.getByTestId("title-field"), { key: "Enter" });
  return screen.getByTestId("title-field-input");
}

function press(pointerType: "touch" | "mouse"): HTMLElement {
  const title = screen.getByTestId("title-field");
  fireEvent.pointerDown(title, {
    pointerId: 1,
    pointerType,
    isPrimary: true,
    button: 0,
    clientX: 10,
    clientY: 10,
  });
  return title;
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

  it("Enter on the focused button enters edit mode with an autofocused, labelled input", () => {
    render(<InlineTitleField {...DEFAULT_PROPS} />);
    const input = openEdit();
    expect(input.tagName).toBe("INPUT");
    expect(input.getAttribute("aria-label")).toBe("Title");
    expect(document.activeElement).toBe(input);
  });

  it("Space on the focused button enters edit mode", () => {
    render(<InlineTitleField {...DEFAULT_PROPS} />);
    fireEvent.keyDown(screen.getByTestId("title-field"), { key: " " });
    expect(screen.getByTestId("title-field-input")).not.toBeNull();
  });

  describe("hold to edit", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("a plain tap does not enter edit mode", () => {
      render(<InlineTitleField {...DEFAULT_PROPS} />);
      const title = press("touch");
      fireEvent.pointerUp(title, { pointerId: 1 });
      fireEvent.click(title);
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_MS);
      });
      expect(screen.queryByTestId("title-field-input")).toBeNull();
    });

    it.each(["touch", "mouse"] as const)(
      "a %s hold past the threshold enters edit mode with the title selected",
      (pointerType) => {
        render(<InlineTitleField {...DEFAULT_PROPS} />);
        press(pointerType);
        act(() => {
          vi.advanceTimersByTime(LONG_PRESS_MS - 1);
        });
        expect(screen.queryByTestId("title-field-input")).toBeNull();
        act(() => {
          vi.advanceTimersByTime(1);
        });
        const input = screen.getByTestId("title-field-input");
        expect(document.activeElement).toBe(input);
        expect(input).toBeInstanceOf(HTMLInputElement);
        if (!(input instanceof HTMLInputElement)) return;
        expect(input.selectionStart).toBe(0);
        expect(input.selectionEnd).toBe("Original title".length);
      },
    );

    it("moving the pointer during the hold abandons it", () => {
      render(<InlineTitleField {...DEFAULT_PROPS} />);
      const title = press("touch");
      fireEvent.pointerMove(title, { pointerId: 1, clientX: 40, clientY: 10 });
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_MS);
      });
      expect(screen.queryByTestId("title-field-input")).toBeNull();
    });

    it("a hold on a non-editable title enters nothing", () => {
      render(<InlineTitleField {...DEFAULT_PROPS} editable={false} />);
      press("touch");
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_MS);
      });
      expect(screen.queryByTestId("title-field-input")).toBeNull();
    });
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
