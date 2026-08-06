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
import { File } from "@pierre/diffs";
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

    expect(focus).toHaveBeenCalledWith({
      lineNumber: 9,
      character: 0,
      preventScroll: true,
    });
    unregister();
  });

  it("focuses the latest serial click without scrolling once attach completes", async () => {
    const activate = vi.fn<Activate>(() =>
      Promise.resolve({ kind: "activated" }),
    );
    const { result } = renderHook(() =>
      useDiffClickToEdit({
        surfaceId: "serial-attach-surface",
        enabled: true,
        active: true,
        onActivate: activate,
        onActivationError: vi.fn(),
        onChange: vi.fn(),
        onBlur: vi.fn(),
        onSaveShortcut: vi.fn(),
      }),
    );
    const editor = new Editor<undefined>({});
    const focus = vi.spyOn(editor, "focus").mockImplementation(() => undefined);
    const fileInstance = new File({}, undefined, true);

    act(() => {
      result.current.fileOptions.onLineClick?.(fileLine(3));
      result.current.fileOptions.onLineClick?.(fileLine(9));
      result.current.editorOptions.onAttach?.(editor, fileInstance);
    });
    await act(async () => Promise.resolve());

    expect(activate).toHaveBeenCalledTimes(2);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledWith({
      lineNumber: 9,
      character: 0,
      preventScroll: true,
    });
  });

  it("does not let a late attach focus an inactive kept-alive surface", async () => {
    const { result, rerender } = renderHook(
      (active: boolean) =>
        useDiffClickToEdit({
          surfaceId: "late-attach-surface",
          enabled: true,
          active,
          onActivate: () => Promise.resolve({ kind: "activated" }),
          onActivationError: vi.fn(),
          onChange: vi.fn(),
          onBlur: vi.fn(),
          onSaveShortcut: vi.fn(),
        }),
      { initialProps: true },
    );
    const editor = new Editor<undefined>({});
    const focus = vi.spyOn(editor, "focus").mockImplementation(() => undefined);
    const fileInstance = new File({}, undefined, true);

    act(() => {
      result.current.fileOptions.onLineClick?.(fileLine(4));
      result.current.editorOptions.onAttach?.(editor, fileInstance);
      rerender(false);
    });
    await act(async () => Promise.resolve());

    expect(focus).not.toHaveBeenCalled();
  });

  it("focuses automatic recovery at the first visible line without scrolling", async () => {
    const { result } = renderHook(() =>
      useDiffClickToEdit({
        surfaceId: "recovery-attach-surface",
        enabled: true,
        active: true,
        onActivate: () => Promise.resolve({ kind: "activated" }),
        onActivationError: vi.fn(),
        onChange: vi.fn(),
        onBlur: vi.fn(),
        onSaveShortcut: vi.fn(),
      }),
    );
    const editor = new Editor<undefined>({});
    const focus = vi.spyOn(editor, "focus").mockImplementation(() => undefined);

    act(() => {
      result.current.editorOptions.onAttach?.(
        editor,
        new File({}, undefined, true),
      );
    });
    await act(async () => Promise.resolve());

    expect(focus).toHaveBeenCalledWith({
      lineNumber: "first-visible",
      preventScroll: true,
    });
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
        // Each glyph is 10px wide starting at x=0. The optimized caret walk
        // measures the WHOLE node (startOffset 0, endOffset text.length)
        // before falling back to per-character ranges, so the mock must
        // size itself off both offsets, not just startOffset.
        return rect(
          this.startOffset * 10,
          (this.endOffset - this.startOffset) * 10,
        );
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

  it("skips whole text nodes left of the click instead of measuring every character", () => {
    // Regression for the click-to-edit hot path doing one Range +
    // getBoundingClientRect per UTF-16 code unit: a long, highlighted line
    // (many small token text nodes) must skip nodes entirely left of the
    // click in ~O(1) instead of walking every character of every node.
    const GLYPH_WIDTH = 10;
    const BEFORE_LENGTH = 3000;
    const line = document.createElement("div");
    const before = document.createElement("span");
    before.textContent = "x".repeat(BEFORE_LENGTH);
    const after = document.createElement("span");
    after.textContent = "abc";
    line.append(before, after);
    document.body.append(line);

    const beforeTextNode = before.firstChild;
    const beforeWidth = BEFORE_LENGTH * GLYPH_WIDTH;
    let callCount = 0;
    const rangeRect = vi
      .spyOn(Range.prototype, "getBoundingClientRect")
      .mockImplementation(function mockedRect(this: Range): DOMRect {
        callCount += 1;
        const base = this.startContainer === beforeTextNode ? 0 : beforeWidth;
        return rect(
          base + this.startOffset * GLYPH_WIDTH,
          (this.endOffset - this.startOffset) * GLYPH_WIDTH,
        );
      });

    try {
      // Click on the "b" in "abc", well past `before`'s span.
      const clientX = beforeWidth + 15;
      expect(resolveLineCaretCharacter({ lineElement: line, clientX })).toBe(
        BEFORE_LENGTH + 1,
      );
      // A per-character walk of `before` alone would need BEFORE_LENGTH
      // calls; skipping it whole plus a handful of calls for `after` stays
      // far below that.
      expect(callCount).toBeLessThan(20);
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
        return rect(
          this.startOffset * 10,
          (this.endOffset - this.startOffset) * 10,
        );
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

  it("does not leave opportunistic preload rejections unhandled", () => {
    // Regression: `preloadIfEnabled` (hover) and `onPointerDownCapture`
    // (pointerdown) both fire-and-forget `preloadDiffEditProvider()`, which
    // rethrows a failed dynamic import. Without a `.catch`, a failed
    // opportunistic preload leaks an unhandled rejection - unlike the
    // activation path, which awaits the same promise through `editorReady`
    // and reports failures via `onActivationError`. Spying on `.catch` of
    // the returned promise proves a handler is actually attached, rather
    // than relying on the timing of process-level rejection tracking.
    const rejection = Promise.reject(new Error("preload chunk failed"));
    const catchSpy = vi.spyOn(rejection, "catch");
    preloadState.preload.mockReturnValue(rejection);

    const { result } = renderAdapter(vi.fn(), vi.fn());
    act(() => {
      result.current.fileOptions.onLineEnter?.(fileLine(1));
    });
    expect(catchSpy).toHaveBeenCalledTimes(1);

    render(<PointerHarness />);
    fireEvent.pointerDown(screen.getByTestId("pointer-target"), {
      button: 0,
    });
    expect(catchSpy).toHaveBeenCalledTimes(2);

    // The shared test-suite rejection tracker (test-browser-apis.ts) only
    // *logs* a leaked rejection rather than failing the run, but attach a
    // real handler anyway so this deliberately-rejected fixture promise
    // never reaches it.
    return rejection.catch(() => undefined);
  });

  it("activateEmptyOrigin routes through the same onActivate as a line click, at the origin caret", () => {
    const activate = vi.fn<Activate>(() =>
      Promise.resolve({ kind: "activated" }),
    );
    const { result } = renderAdapter(activate, vi.fn());

    act(() => {
      result.current.activateEmptyOrigin();
    });

    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate.mock.calls[0]?.[0].caret).toEqual({
      lineNumber: 1,
      character: 0,
    });
  });

  it("activateEmptyOrigin does nothing while the adapter is disabled", () => {
    const activate = vi.fn<Activate>(() =>
      Promise.resolve({ kind: "activated" }),
    );
    const { result } = renderHook(() =>
      useDiffClickToEdit({
        surfaceId: "surface-disabled",
        enabled: false,
        active: false,
        onActivate: activate,
        onActivationError: vi.fn(),
        onChange: vi.fn(),
        onBlur: vi.fn(),
        onSaveShortcut: vi.fn(),
      }),
    );

    act(() => {
      result.current.activateEmptyOrigin();
    });

    expect(activate).not.toHaveBeenCalled();
  });

  it("reports attached only once editorOptions.onAttach fires, and resets it the moment active goes false", () => {
    const { result, rerender } = renderHook(
      (active: boolean) =>
        useDiffClickToEdit({
          surfaceId: "surface-attach",
          enabled: true,
          active,
          onActivate: () => Promise.resolve({ kind: "activated" }),
          onActivationError: vi.fn(),
          onChange: vi.fn(),
          onBlur: vi.fn(),
          onSaveShortcut: vi.fn(),
        }),
      { initialProps: true },
    );

    expect(result.current.attached).toBe(false);

    const editor = new Editor<undefined>({});
    const fileInstance = new File({}, undefined, true);
    act(() => {
      result.current.editorOptions.onAttach?.(editor, fileInstance);
    });
    expect(result.current.attached).toBe(true);

    // Deactivating (e.g. another surface claims ownership) must clear
    // `attached` immediately - a fresh activation cycle can start again
    // before any real editor has attached for it.
    rerender(false);
    expect(result.current.attached).toBe(false);
  });
});

function PointerHarness() {
  const adapter = useDiffClickToEdit({
    surfaceId: "pointer-surface",
    enabled: true,
    active: false,
    onActivate: () => Promise.resolve({ kind: "activated" }),
    onActivationError: vi.fn(),
    onChange: vi.fn(),
    onBlur: vi.fn(),
    onSaveShortcut: vi.fn(),
  });
  return (
    <div
      data-testid="pointer-target"
      onPointerDownCapture={adapter.onPointerDownCapture}
    />
  );
}

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
