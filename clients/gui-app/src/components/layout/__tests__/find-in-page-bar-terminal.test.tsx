import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { FindInPageBar } from "@/components/layout/find-in-page-bar";
import { useFindInPageStore } from "@/stores/find-in-page/find-in-page-store";
import { useTerminalFindStore } from "@/stores/find-in-page/terminal-find-store";

describe("<FindInPageBar /> terminal search", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useFindInPageStore.setState({
      isOpen: false,
      query: "",
      matches: null,
      matchCase: false,
      advanceForwardNonce: 0,
      advanceBackwardNonce: 0,
      focusRequestNonce: 0,
    });
    useTerminalFindStore.setState({ activeController: null });
  });

  afterEach(() => {
    cleanup();
    useTerminalFindStore.setState({ activeController: null });
    vi.useRealTimers();
  });

  it("routes live query changes and navigation to the active terminal controller", () => {
    const findNext = vi.fn(() => true);
    const findPrevious = vi.fn(() => true);
    const clear = vi.fn();
    useTerminalFindStore.setState({
      activeController: {
        id: "terminal:test",
        findNext,
        findPrevious,
        clear,
      },
    });
    useFindInPageStore.getState().open();

    render(<FindInPageBar />);

    const input = screen.getByRole("textbox", { name: "Find in page" });
    clear.mockClear();
    fireEvent.change(input, { target: { value: "needle" } });
    act(() => {
      vi.advanceTimersByTime(140);
    });

    expect(findNext).toHaveBeenCalledWith("needle", false, true);

    fireEvent.keyDown(input, { key: "Enter" });
    expect(findNext).toHaveBeenLastCalledWith("needle", false, false);
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(findPrevious).toHaveBeenCalledWith("needle", false);
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(input, { key: "Escape" });
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("clears terminal decorations when the query is emptied", () => {
    const clear = vi.fn();
    useTerminalFindStore.setState({
      activeController: {
        id: "terminal:test",
        findNext: vi.fn(() => true),
        findPrevious: vi.fn(() => true),
        clear,
      },
    });
    useFindInPageStore.setState({
      isOpen: true,
      query: "needle",
      matches: { current: 1, total: 2 },
    });

    render(<FindInPageBar />);

    fireEvent.change(screen.getByRole("textbox", { name: "Find in page" }), {
      target: { value: "" },
    });

    expect(clear).toHaveBeenCalled();
    expect(useFindInPageStore.getState().matches).toBeNull();
  });

  it("focuses the existing input when find is opened again", () => {
    useTerminalFindStore.setState({
      activeController: {
        id: "terminal:test",
        findNext: vi.fn(() => true),
        findPrevious: vi.fn(() => true),
        clear: vi.fn(),
      },
    });
    useFindInPageStore.getState().open();

    render(
      <>
        <button type="button">Other focus target</button>
        <FindInPageBar />
      </>,
    );

    const input = screen.getByRole("textbox", { name: "Find in page" });
    const otherTarget = screen.getByRole("button", {
      name: "Other focus target",
    });
    expect(document.activeElement).toBe(input);

    otherTarget.focus();
    expect(document.activeElement).toBe(otherTarget);

    act(() => {
      useFindInPageStore.getState().open();
    });

    expect(document.activeElement).toBe(input);
  });
});
