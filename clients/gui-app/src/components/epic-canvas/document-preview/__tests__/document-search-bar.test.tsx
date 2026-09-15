/**
 * `DocumentSearchBar`'s keyboard and disabled-state contract
 * (document-search-bar.tsx): Enter steps to the next match, Shift+Enter
 * steps to the previous one, Escape closes the bar, an empty query disables
 * both step buttons and does nothing on Enter, and the match count renders
 * in a `polite` live region so screen readers hear a count update without
 * moving focus. Shared verbatim by the PDF and Word viewers - each owns what
 * a query DOES, this bar owns how it reads and behaves.
 */
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  DocumentSearchBar,
  type DocumentSearchBarProps,
} from "../document-search-bar";

function renderBar(
  overrides: Partial<DocumentSearchBarProps>,
): DocumentSearchBarProps {
  const props: DocumentSearchBarProps = {
    inputRef: createRef<HTMLInputElement>(),
    query: "",
    onQueryChange: vi.fn(),
    onStep: vi.fn(),
    onClose: vi.fn(),
    matchCountLabel: "",
    ...overrides,
  };
  render(<DocumentSearchBar {...props} />);
  return props;
}

function findInput(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>("Find in document");
}

describe("<DocumentSearchBar />", () => {
  afterEach(() => {
    cleanup();
  });

  it("steps to the next match on Enter", () => {
    const onStep = vi.fn();
    renderBar({ query: "foo", onStep });

    fireEvent.keyDown(findInput(), { key: "Enter" });

    expect(onStep).toHaveBeenCalledWith(false);
    expect(onStep).toHaveBeenCalledTimes(1);
  });

  it("steps to the previous match on Shift+Enter", () => {
    const onStep = vi.fn();
    renderBar({ query: "foo", onStep });

    fireEvent.keyDown(findInput(), { key: "Enter", shiftKey: true });

    expect(onStep).toHaveBeenCalledWith(true);
    expect(onStep).toHaveBeenCalledTimes(1);
  });

  it("does nothing on Enter with an empty query", () => {
    const onStep = vi.fn();
    renderBar({ query: "", onStep });

    fireEvent.keyDown(findInput(), { key: "Enter" });

    expect(onStep).not.toHaveBeenCalled();
  });

  it("closes on Escape regardless of the query", () => {
    const onClose = vi.fn();
    renderBar({ query: "", onClose });

    fireEvent.keyDown(findInput(), { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("disables the previous and next buttons while the query is empty", () => {
    renderBar({ query: "" });

    expect(
      screen
        .getByRole("button", { name: "Previous match" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Next match" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("enables the previous and next buttons once there is a query", () => {
    renderBar({ query: "foo" });

    expect(
      screen
        .getByRole("button", { name: "Previous match" })
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(
      screen
        .getByRole("button", { name: "Next match" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("steps forward and backward from the prev/next buttons", () => {
    const onStep = vi.fn();
    renderBar({ query: "foo", onStep });

    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous match" }));

    expect(onStep).toHaveBeenNthCalledWith(1, false);
    expect(onStep).toHaveBeenNthCalledWith(2, true);
  });

  it("reports query edits through onQueryChange", () => {
    const onQueryChange = vi.fn();
    renderBar({ query: "", onQueryChange });

    fireEvent.change(findInput(), { target: { value: "hello" } });

    expect(onQueryChange).toHaveBeenCalledWith("hello");
  });

  it("closes from the close button", () => {
    const onClose = vi.fn();
    renderBar({ query: "foo", onClose });

    fireEvent.click(screen.getByRole("button", { name: "Close search" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders the match count label in a polite live region", () => {
    renderBar({ query: "foo", matchCountLabel: "2 / 5" });

    const status = screen.getByText("2 / 5");
    expect(status.getAttribute("aria-live")).toBe("polite");
  });
});
