import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useInlineRename } from "@/hooks/ui/use-inline-rename";

const TITLE = "Original title";

function InlineRenameHarness() {
  const rename = useInlineRename({
    value: TITLE,
    canEdit: true,
    onCommit: () => undefined,
  });

  return (
    <div>
      {rename.isEditing ? (
        <input {...rename.inputProps} aria-label="Edit title" />
      ) : (
        <button type="button" onClick={rename.startEditing}>
          Edit
        </button>
      )}
    </div>
  );
}

function installAnimationFrameMock() {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextHandle = 1;

  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const handle = nextHandle;
    nextHandle += 1;
    callbacks.set(handle, callback);
    return handle;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle) => {
    callbacks.delete(handle);
  });

  return {
    flush() {
      const pending = Array.from(callbacks.values());
      callbacks.clear();
      pending.forEach((callback) => callback(16));
    },
  };
}

function getRenameInput() {
  const element = screen.getByRole("textbox", { name: /edit title/i });
  if (!(element instanceof HTMLInputElement)) {
    throw new Error("Expected rename input to be an HTMLInputElement");
  }
  return element;
}

describe("useInlineRename", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("focuses and selects the input on the animation frame after editing starts", () => {
    const frames = installAnimationFrameMock();

    const focusSpy = vi.spyOn(HTMLInputElement.prototype, "focus");
    const selectSpy = vi.spyOn(HTMLInputElement.prototype, "select");

    render(<InlineRenameHarness />);

    fireEvent.click(screen.getByRole("button", { name: /edit/i }));
    const input = getRenameInput();

    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(TITLE.length);
    const focusCallsBeforeFrame = focusSpy.mock.calls.length;
    const selectCallsBeforeFrame = selectSpy.mock.calls.length;

    act(() => {
      frames.flush();
    });

    expect(focusSpy.mock.calls.length).toBeGreaterThan(focusCallsBeforeFrame);
    expect(selectSpy.mock.calls.length).toBeGreaterThan(selectCallsBeforeFrame);
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(TITLE.length);
  });
});
