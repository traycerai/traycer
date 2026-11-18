import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import {
  NATIVE_QUOTE_REQUEST_EVENT,
  useNativeQuoteRequest,
} from "../use-native-quote-request";

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function selectRange(range: Range): void {
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function makeContainerWithProse(text: string): {
  readonly container: HTMLElement;
  readonly paragraph: HTMLElement;
} {
  const container = document.createElement("div");
  const root = document.createElement("div");
  root.setAttribute("data-quotable", "true");
  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  root.appendChild(paragraph);
  container.appendChild(root);
  document.body.appendChild(container);
  return { container, paragraph };
}

function fireNativeRequest(): void {
  act(() => {
    window.dispatchEvent(new Event(NATIVE_QUOTE_REQUEST_EVENT));
  });
}

describe("useNativeQuoteRequest", () => {
  it("resolves the live selection inside its container into a snapshot", () => {
    const { container, paragraph } = makeContainerWithProse("Quotable text.");
    const onQuote = vi.fn();
    renderHook(() =>
      useNativeQuoteRequest({
        containerRef: { current: container },
        enabled: true,
        onQuote,
      }),
    );
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    selectRange(range);

    fireNativeRequest();

    expect(onQuote).toHaveBeenCalledTimes(1);
    expect(onQuote.mock.calls[0][0]).toMatchObject({
      text: "Quotable text.",
      fenceLanguage: null,
    });
  });

  it("leaves a selection that starts in another container to that container's instance", () => {
    const mine = makeContainerWithProse("Mine.");
    const other = makeContainerWithProse("Theirs.");
    const onQuote = vi.fn();
    renderHook(() =>
      useNativeQuoteRequest({
        containerRef: { current: mine.container },
        enabled: true,
        onQuote,
      }),
    );
    const range = document.createRange();
    range.selectNodeContents(other.paragraph);
    selectRange(range);

    fireNativeRequest();

    expect(onQuote).not.toHaveBeenCalled();
  });

  it("drops a selection that fails the quote rules (streaming tail)", () => {
    const { container, paragraph } = makeContainerWithProse("Still streaming");
    paragraph.setAttribute("data-md-streaming", "");
    const onQuote = vi.fn();
    renderHook(() =>
      useNativeQuoteRequest({
        containerRef: { current: container },
        enabled: true,
        onQuote,
      }),
    );
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    selectRange(range);

    fireNativeRequest();

    expect(onQuote).not.toHaveBeenCalled();
  });

  it("listens only while enabled", () => {
    const { container, paragraph } = makeContainerWithProse("Quotable text.");
    const onQuote = vi.fn();
    const { rerender } = renderHook(
      (props: { enabled: boolean }) =>
        useNativeQuoteRequest({
          containerRef: { current: container },
          enabled: props.enabled,
          onQuote,
        }),
      { initialProps: { enabled: false } },
    );
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    selectRange(range);

    fireNativeRequest();
    expect(onQuote).not.toHaveBeenCalled();

    rerender({ enabled: true });
    fireNativeRequest();
    expect(onQuote).toHaveBeenCalledTimes(1);

    rerender({ enabled: false });
    fireNativeRequest();
    expect(onQuote).toHaveBeenCalledTimes(1);
  });
});
