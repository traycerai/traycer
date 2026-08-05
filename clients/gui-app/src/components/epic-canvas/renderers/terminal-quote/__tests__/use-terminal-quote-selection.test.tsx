import "../../../../../../__tests__/test-browser-apis";
import { createRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

import {
  useTerminalQuoteSelection,
  type TerminalSelectionSource,
} from "../use-terminal-quote-selection";

afterEach(() => {
  cleanup();
});

/**
 * A stand-in for the pane's xterm engine, driven the way the real one drives
 * the hook: the selection is whatever the test set, and events are fired by
 * hand. Enough to exercise the publish/retract state machine without a canvas.
 */
function createSource(): TerminalSelectionSource & {
  readonly element: HTMLElement;
  readonly setSelection: (text: string) => void;
  readonly fireSelectionChange: () => void;
} {
  const element = document.createElement("div");
  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  element.appendChild(screen);
  document.body.appendChild(element);
  let text = "";
  const selectionListeners: Array<() => void> = [];
  return {
    element,
    rows: 24,
    cols: 80,
    buffer: { active: { viewportY: 0 } },
    hasSelection: () => text.length > 0,
    getSelection: () => text,
    getSelectionPosition: () =>
      text.length === 0 ? undefined : { start: { x: 5, y: 3 } },
    onSelectionChange: (listener) => {
      selectionListeners.push(listener);
      return { dispose: () => undefined };
    },
    onScroll: () => ({ dispose: () => undefined }),
    setSelection: (next) => {
      text = next;
    },
    fireSelectionChange: () => {
      for (const listener of selectionListeners) listener();
    },
  };
}

function renderSelection(source: TerminalSelectionSource) {
  const paneRef = createRef<HTMLElement>();
  const pane = document.createElement("div");
  document.body.appendChild(pane);
  paneRef.current = pane;
  return renderHook(() =>
    useTerminalQuoteSelection({ term: source, paneRef, menuOpen: false }),
  );
}

function mouse(type: string): MouseEvent {
  return new MouseEvent(type, { bubbles: true });
}

describe("useTerminalQuoteSelection", () => {
  it("publishes a drag released outside the pane", () => {
    const source = createSource();
    const { result } = renderSelection(source);

    // The way a user selects to the end of the output: press inside, drag past
    // the pane's edge, release over whatever is next to it. xterm finishes the
    // drag on the document, so a pane-local mouseup would never see this.
    act(() => {
      source.element.dispatchEvent(mouse("mousedown"));
      source.setSelection("error: build failed");
      document.body.dispatchEvent(mouse("mouseup"));
    });

    expect(result.current.selection?.text).toBe("error: build failed");
  });

  it("publishes a drag released inside the pane", () => {
    const source = createSource();
    const { result } = renderSelection(source);

    act(() => {
      source.element.dispatchEvent(mouse("mousedown"));
      source.setSelection("2 tests failed");
      source.element.dispatchEvent(mouse("mouseup"));
    });

    expect(result.current.selection?.text).toBe("2 tests failed");
  });

  it("ignores a mouseup from a drag that never started in this pane", () => {
    const source = createSource();
    const { result } = renderSelection(source);

    // Another pane's drag, or a stray click elsewhere: this pane is not
    // listening, so nothing is published even though xterm reports a selection.
    act(() => {
      source.setSelection("someone else's selection");
      document.body.dispatchEvent(mouse("mouseup"));
    });

    expect(result.current.selection).toBeNull();
  });

  it("retracts when the selection is cleared", () => {
    const source = createSource();
    const { result } = renderSelection(source);
    act(() => {
      source.element.dispatchEvent(mouse("mousedown"));
      source.setSelection("something");
      document.body.dispatchEvent(mouse("mouseup"));
    });

    act(() => {
      source.setSelection("");
      source.fireSelectionChange();
    });

    expect(result.current.selection).toBeNull();
  });

  it("stops listening on the document once the pane unmounts mid-drag", () => {
    const source = createSource();
    const { result, unmount } = renderSelection(source);
    act(() => {
      source.element.dispatchEvent(mouse("mousedown"));
    });

    unmount();
    source.setSelection("released after the tile closed");
    document.body.dispatchEvent(mouse("mouseup"));

    expect(result.current.selection).toBeNull();
  });
});
