import "../../../../__tests__/test-browser-apis";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@pierre/diffs/edit";
import {
  isDiffEditActivationGesture,
  registerDiffEditor,
  resolveLineCaretCharacter,
  resolveTokenCaretCharacter,
} from "@/components/diff/diff-click-to-edit";
import {
  useDiffClickToEdit,
  type DiffEditActivationRequest,
  type DiffEditActivationResult,
} from "@/components/diff/use-diff-click-to-edit";

const preloadState = vi.hoisted(() => ({
  preload: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/components/diff/diff-edit-provider-loader", () => ({
  preloadDiffEditProvider: () => preloadState.preload(),
}));

type Activate = (
  request: DiffEditActivationRequest,
) => Promise<DiffEditActivationResult>;

describe("click-to-edit adapter", () => {
  beforeEach(() => {
    preloadState.preload.mockReset();
    preloadState.preload.mockImplementation(() => Promise.resolve());
  });

  it("only registers interactive line handlers when editing is available", () => {
    const { result } = renderHook(() =>
      useDiffClickToEdit({
        surfaceId: "read-only-surface",
        enabled: false,
        active: false,
        onActivate: vi.fn(),
        onActivationError: vi.fn(),
        onChange: vi.fn(),
        onBlur: vi.fn(),
        onSaveShortcut: vi.fn(),
      }),
    );

    expect(result.current.fileOptions.onLineClick).toBeUndefined();
    expect(result.current.fileOptions.onTokenClick).toBeUndefined();
    expect(result.current.diffOptions.onLineClick).toBeUndefined();
    expect(result.current.diffOptions.onTokenClick).toBeUndefined();
  });

  it("maps a token click to the nearest UTF-16 caret and deduplicates its line callback", () => {
    const activate = vi.fn<Activate>(() =>
      Promise.resolve({ kind: "activated" }),
    );
    const { result } = renderAdapter(activate, vi.fn());
    const token = document.createElement("span");
    vi.spyOn(token, "getBoundingClientRect").mockReturnValue(rect(10, 50));
    const event = new PointerEvent("click", {
      button: 0,
      clientX: 30,
    });

    act(() => {
      result.current.diffOptions.onTokenClick?.(
        {
          type: "token",
          side: "additions",
          lineNumber: 7,
          lineCharStart: 4,
          lineCharEnd: 8,
          tokenText: "test",
          tokenElement: token,
        },
        event,
      );
      result.current.diffOptions.onLineClick?.({
        type: "diff-line",
        annotationSide: "additions",
        lineType: "change-addition",
        lineNumber: 7,
        lineElement: document.createElement("div"),
        numberElement: document.createElement("div"),
        numberColumn: false,
        event,
      });
    });

    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate.mock.calls[0]?.[0].caret).toEqual({
      lineNumber: 7,
      character: 6,
    });
  });

  it("keeps old-side, gutter, modified, and non-primary clicks read-only", () => {
    const activate = vi.fn<Activate>(() =>
      Promise.resolve({ kind: "activated" }),
    );
    const { result } = renderAdapter(activate, vi.fn());
    const base = {
      type: "diff-line" as const,
      lineType: "change-deletion" as const,
      lineNumber: 2,
      lineElement: document.createElement("div"),
      numberElement: document.createElement("div"),
    };

    act(() => {
      result.current.diffOptions.onLineClick?.({
        ...base,
        annotationSide: "deletions",
        numberColumn: false,
        event: new PointerEvent("click", { button: 0 }),
      });
      result.current.diffOptions.onLineClick?.({
        ...base,
        annotationSide: "additions",
        numberColumn: true,
        event: new PointerEvent("click", { button: 0 }),
      });
      result.current.diffOptions.onLineClick?.({
        ...base,
        annotationSide: "additions",
        numberColumn: false,
        event: new PointerEvent("click", { button: 0, metaKey: true }),
      });
      result.current.diffOptions.onLineClick?.({
        ...base,
        annotationSide: "additions",
        numberColumn: false,
        event: new PointerEvent("click", { button: 1 }),
      });
    });

    expect(activate).not.toHaveBeenCalled();
  });

  it("suppresses an error from an activation superseded by a newer click", async () => {
    let rejectFirst: ((error: Error) => void) | null = null;
    const activate = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockImplementationOnce(() => new Promise(() => undefined));
    const onActivationError = vi.fn();
    const { result } = renderAdapter(activate, onActivationError);

    act(() => {
      result.current.fileOptions.onLineClick?.(fileLine(1));
      result.current.fileOptions.onLineClick?.(fileLine(2));
      rejectFirst?.(new Error("stale"));
    });
    await act(async () => Promise.resolve());

    expect(onActivationError).not.toHaveBeenCalled();
  });

  it("focuses the existing owner when a duplicate surface cannot take ownership", async () => {
    const editor = new Editor<undefined>({});
    const focus = vi.spyOn(editor, "focus").mockImplementation(() => undefined);
    const unregister = registerDiffEditor("owner-surface", editor);
    const activate = vi.fn<Activate>(() =>
      Promise.resolve({ kind: "focus-owner", ownerSurfaceId: "owner-surface" }),
    );
    const { result } = renderAdapter(activate, vi.fn());

    act(() => {
      result.current.fileOptions.onLineClick?.(fileLine(9));
    });
    await act(async () => Promise.resolve());

    expect(focus).toHaveBeenCalledWith({ lineNumber: 9, character: 0 });
    unregister();
  });

  it("flushes Cmd-S but leaves native Cmd-F untouched", () => {
    const flush = vi.fn();
    render(<KeyboardHarness onFlush={flush} />);
    const editor = screen.getByTestId("editor");

    expect(fireEvent.keyDown(editor, { key: "s", metaKey: true })).toBe(false);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(fireEvent.keyDown(editor, { key: "f", metaKey: true })).toBe(true);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("accepts touch taps and rejects an active selection gesture", () => {
    const target = document.createElement("div");
    target.textContent = "selected";
    document.body.append(target);
    const range = document.createRange();
    range.selectNodeContents(target);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const selectionEvent = new PointerEvent("click", { button: 0 });
    Object.defineProperty(selectionEvent, "composedPath", {
      value: () => [target, document.body, document, window],
    });

    expect(isDiffEditActivationGesture(selectionEvent)).toBe(false);
    selection?.removeAllRanges();
    expect(
      isDiffEditActivationGesture(
        new PointerEvent("click", { button: 0, pointerType: "touch" }),
      ),
    ).toBe(true);
    target.remove();
  });

  it("resolves clamped token caret positions", () => {
    const token = document.createElement("span");
    vi.spyOn(token, "getBoundingClientRect").mockReturnValue(rect(20, 40));
    expect(
      resolveTokenCaretCharacter({
        lineCharStart: 3,
        lineCharEnd: 7,
        tokenElement: token,
        clientX: 100,
      }),
    ).toBe(7);
    expect(
      isDiffEditActivationGesture(
        new MouseEvent("click", { button: 0, shiftKey: true }),
      ),
    ).toBe(false);
  });

  it("resolves pre-edit line-only clicks from measured text ranges, not character 0", () => {
    const line = document.createElement("div");
    line.append("hello");
    document.body.append(line);

    const rangeRect = vi
      .spyOn(Range.prototype, "getBoundingClientRect")
      .mockImplementation(function mockedRect(this: Range): DOMRect {
        const offset = this.startOffset;
        // Each glyph is 10px wide starting at x=0.
        return rect(offset * 10, 10);
      });

    try {
      // Click near the midpoint of the 4th character ("l" at index 3).
      expect(
        resolveLineCaretCharacter({
          lineElement: line,
          clientX: 35,
        }),
      ).toBe(3);
      // Past the final glyph → end of line.
      expect(
        resolveLineCaretCharacter({
          lineElement: line,
          clientX: 1000,
        }),
      ).toBe(5);
    } finally {
      rangeRect.mockRestore();
      line.remove();
    }
  });

  it("maps a line-only click through measured caret resolution", () => {
    const activate = vi.fn<Activate>(() =>
      Promise.resolve({ kind: "activated" }),
    );
    const { result } = renderAdapter(activate, vi.fn());
    const line = document.createElement("div");
    line.append("abcd");
    document.body.append(line);
    const rangeRect = vi
      .spyOn(Range.prototype, "getBoundingClientRect")
      .mockImplementation(function mockedRect(this: Range): DOMRect {
        return rect(this.startOffset * 10, 10);
      });

    try {
      act(() => {
        result.current.fileOptions.onLineClick?.({
          type: "line",
          lineNumber: 4,
          lineElement: line,
          numberElement: document.createElement("div"),
          numberColumn: false,
          event: new PointerEvent("click", { button: 0, clientX: 25 }),
        });
      });
    } finally {
      rangeRect.mockRestore();
      line.remove();
    }

    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate.mock.calls[0]?.[0].caret).toEqual({
      lineNumber: 4,
      character: 2,
    });
  });

  it("exposes editorReady as the preload promise so surfaces can wait before attach", async () => {
    let resolvePreload: (() => void) | null = null;
    const preloadPromise = new Promise<void>((resolve) => {
      resolvePreload = resolve;
    });
    preloadState.preload.mockReturnValue(preloadPromise);

    const activate = vi.fn<Activate>(() =>
      Promise.resolve({ kind: "activated" }),
    );
    const { result } = renderAdapter(activate, vi.fn());

    act(() => {
      result.current.fileOptions.onLineClick?.(fileLine(1));
    });

    expect(activate).toHaveBeenCalledTimes(1);
    const request = activate.mock.calls[0]?.[0];
    expect(request).toBeDefined();

    let editorReadySettled = false;
    void request.editorReady.then(() => {
      editorReadySettled = true;
    });
    await Promise.resolve();
    expect(editorReadySettled).toBe(false);
    expect(preloadState.preload).toHaveBeenCalled();

    await act(async () => {
      resolvePreload?.();
      await preloadPromise;
    });
    await request.editorReady;
    expect(editorReadySettled).toBe(true);
  });
});

function KeyboardHarness(props: { readonly onFlush: () => void }) {
  const adapter = useDiffClickToEdit({
    surfaceId: "keyboard-surface",
    enabled: true,
    active: true,
    onActivate: () => Promise.resolve({ kind: "activated" }),
    onActivationError: vi.fn(),
    onChange: vi.fn(),
    onBlur: vi.fn(),
    onSaveShortcut: props.onFlush,
  });
  return (
    <div
      data-diffs-editor-boundary=""
      onKeyDownCapture={adapter.onKeyDownCapture}
    >
      <div contentEditable suppressContentEditableWarning data-testid="editor">
        draft
      </div>
    </div>
  );
}

function renderAdapter(
  onActivate: Activate,
  onActivationError: (error: unknown) => void,
) {
  return renderHook(() =>
    useDiffClickToEdit({
      surfaceId: "surface-a",
      enabled: true,
      active: false,
      onActivate,
      onActivationError,
      onChange: vi.fn(),
      onBlur: vi.fn(),
      onSaveShortcut: vi.fn(),
    }),
  );
}

function fileLine(lineNumber: number) {
  return {
    type: "line" as const,
    lineNumber,
    lineElement: document.createElement("div"),
    numberElement: document.createElement("div"),
    numberColumn: false,
    event: new PointerEvent("click", { button: 0 }),
  };
}

function rect(left: number, width: number): DOMRect {
  return {
    x: left,
    y: 0,
    left,
    right: left + width,
    top: 0,
    bottom: 10,
    width,
    height: 10,
    toJSON: () => ({}),
  };
}
