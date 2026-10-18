import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasInlineTextEditor } from "../canvas-inline-text-editor";
import { canvasTextEditorStyle } from "../canvas-inline-text-geometry";
import { useCanvasSelectionStore } from "../canvas-selection-store";
import {
  failSave,
  pendingSaves,
  REFUSED,
  SAVED,
  settleSave,
  textSelection,
} from "./canvas-edit-test-support";

vi.mock("../use-artboard-edit", async () =>
  (await import("./canvas-edit-test-support")).artboardEditModule(),
);

vi.mock("@/components/ui/agent-spinning-dots", () => ({
  AgentSpinningDots: () => <span data-testid="saving-spinner" />,
}));

const SELECTION = textSelection(null, { tid: "t1" });

interface Mounted {
  readonly onClose: () => void;
  readonly outerKeyDown: () => void;
  readonly outerPointerDown: () => void;
}

type ReadText = () => Promise<string | null>;

/** The live text of the element on the page, as the frame would report it. */
const readsHello: ReadText = () => Promise.resolve("Hello");

function mount(textNodeIndex: number | null): Mounted {
  return mountReading(textNodeIndex, readsHello);
}

function mountReading(
  textNodeIndex: number | null,
  readText: ReadText,
): Mounted {
  const onClose = vi.fn();
  const outerKeyDown = vi.fn();
  const outerPointerDown = vi.fn();
  render(
    <div
      role="presentation"
      onKeyDown={outerKeyDown}
      onPointerDown={outerPointerDown}
    >
      <CanvasInlineTextEditor
        selection={SELECTION}
        target={{ text: "Hello", textNodeIndex }}
        readText={readText}
        onClose={onClose}
      />
    </div>,
  );
  return { onClose, outerKeyDown, outerPointerDown };
}

function textarea(): HTMLTextAreaElement {
  const found = screen.getByRole("textbox", { name: "Edit element text" });
  if (!(found instanceof HTMLTextAreaElement))
    throw new Error("not a textarea");
  return found;
}

function type(value: string): void {
  fireEvent.change(textarea(), { target: { value } });
}

/** Lets the read of the page's live text and the save that follows it run. */
async function settled(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}
const enter = (): Promise<void> =>
  settled(() => fireEvent.keyDown(textarea(), { code: "Enter" }));
const leave = (): Promise<void> => settled(() => fireEvent.blur(textarea()));

beforeEach(() => {
  pendingSaves.length = 0;
  act(() => {
    useCanvasSelectionStore.getState().select(SELECTION);
  });
});

afterEach(() => {
  cleanup();
  act(() => {
    useCanvasSelectionStore.getState().clear();
  });
});

describe("CanvasInlineTextEditor opening", () => {
  it("opens focused with the current text selected", () => {
    mount(null);
    expect(document.activeElement).toBe(textarea());
    expect(textarea().value).toBe("Hello");
    expect(textarea().selectionStart).toBe(0);
    expect(textarea().selectionEnd).toBe(5);
  });

  it("keeps typing and clicks inside the editor from reaching the board under it", async () => {
    const { outerKeyDown, outerPointerDown } = mount(null);
    fireEvent.keyDown(textarea(), { code: "KeyA" });
    fireEvent.keyDown(textarea(), { code: "Escape" });
    await enter();
    fireEvent.pointerDown(textarea());
    expect(outerKeyDown).not.toHaveBeenCalled();
    expect(outerPointerDown).not.toHaveBeenCalled();
  });
});

describe("CanvasInlineTextEditor committing", () => {
  it("saves the whole element text on Enter and closes once the host accepts", async () => {
    const { onClose } = mount(null);
    type("Hello world");
    await enter();

    expect(pendingSaves).toHaveLength(1);
    expect(pendingSaves[0].variables.selection).toBe(SELECTION);
    expect(pendingSaves[0].variables.edit).toEqual({
      kind: "set-text-content",
      text: "Hello world",
    });
    expect(onClose).not.toHaveBeenCalled();

    await settleSave(0, SAVED);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("saves only the one text node when the element has other children", async () => {
    const { onClose } = mount(2);
    type("Changed");
    await enter();

    expect(pendingSaves[0].variables.edit).toEqual({
      kind: "set-text-node",
      index: 2,
      text: "Changed",
      expectedText: "Hello",
    });
    await settleSave(0, SAVED);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("saves when focus leaves the editor", async () => {
    const { onClose } = mount(null);
    type("Elsewhere");
    await leave();

    expect(pendingSaves).toHaveLength(1);
    expect(pendingSaves[0].variables.edit).toMatchObject({ text: "Elsewhere" });
    await settleSave(0, SAVED);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes without saving when nothing changed", async () => {
    const { onClose } = mount(null);
    await enter();
    expect(pendingSaves).toHaveLength(0);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("lets Shift+Enter add a line instead of saving", async () => {
    mount(null);
    type("one\ntwo");
    await settled(() =>
      fireEvent.keyDown(textarea(), { code: "Enter", shiftKey: true }),
    );
    expect(pendingSaves).toHaveLength(0);
  });

  it("does not save on the Enter that confirms an IME composition", async () => {
    mount(null);
    type("かな");
    await settled(() =>
      fireEvent.keyDown(textarea(), { code: "Enter", isComposing: true }),
    );
    expect(pendingSaves).toHaveLength(0);
  });

  it("saves once however many times Enter and blur arrive while it is pending", async () => {
    const { onClose } = mount(null);
    type("Once");
    await enter();
    await enter();
    await leave();

    expect(pendingSaves).toHaveLength(1);
    expect(textarea().disabled).toBe(true);
    expect(screen.getByTestId("saving-spinner")).toBeDefined();

    await settleSave(0, SAVED);
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("CanvasInlineTextEditor cancelling", () => {
  it("closes on Escape without saving, even though the blur that follows would have", async () => {
    const { onClose } = mount(null);
    type("Discard me");
    fireEvent.keyDown(textarea(), { code: "Escape" });
    await leave();

    expect(pendingSaves).toHaveLength(0);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes without saving when the selection moved to another element", async () => {
    const { onClose } = mount(null);
    type("Too late");
    act(() => {
      useCanvasSelectionStore
        .getState()
        .select(textSelection(null, { tid: "other" }));
    });
    await enter();

    expect(pendingSaves).toHaveLength(0);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes without saving when the selection was cleared", async () => {
    const { onClose } = mount(null);
    type("Too late");
    act(() => {
      useCanvasSelectionStore.getState().clear();
    });
    await leave();

    expect(pendingSaves).toHaveLength(0);
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("CanvasInlineTextEditor when the host says no", () => {
  it("stays open with the draft, shows the reason and focuses the field", async () => {
    const { onClose } = mount(null);
    type("Draft that was refused");
    await enter();
    await settleSave(0, REFUSED);

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe(
      REFUSED.ok ? "" : REFUSED.detail,
    );
    expect(textarea().value).toBe("Draft that was refused");
    expect(textarea().disabled).toBe(false);
    expect(document.activeElement).toBe(textarea());
  });

  it("lets the same draft be tried again", async () => {
    const { onClose } = mount(null);
    type("Try twice");
    await enter();
    await settleSave(0, REFUSED);

    await enter();
    expect(pendingSaves).toHaveLength(2);
    expect(pendingSaves[1].variables.edit).toMatchObject({ text: "Try twice" });

    await settleSave(1, SAVED);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps newer typing made while the first try was pending", async () => {
    mount(null);
    type("First");
    await enter();
    await settleSave(0, REFUSED);
    type("First, then more");
    expect(textarea().value).toBe("First, then more");
  });

  it("shows a plain message when the save fails outright", async () => {
    const { onClose } = mount(null);
    type("Unlucky");
    await enter();
    await failSave(0);

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe(
      "The change could not be saved. Try again.",
    );
    expect(textarea().value).toBe("Unlucky");
  });

  it("clears the message when the next try starts", async () => {
    mount(null);
    type("Retry");
    await enter();
    await settleSave(0, REFUSED);
    expect(screen.getByRole("status")).toBeDefined();

    await enter();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("CanvasInlineTextEditor when the page's text may have changed", () => {
  const CHANGED =
    "This text was changed by a script. Ask the agent to change it.";
  const drifted: ReadText = () => Promise.resolve("Hello, now different");

  function deferred<T>() {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  it("asks the page for the live text each time it is about to save", async () => {
    const readText = vi.fn<ReadText>(readsHello);
    mountReading(null, readText);
    type("First");
    await enter();
    await settleSave(0, REFUSED);
    type("Second");
    await enter();

    expect(readText).toHaveBeenCalledTimes(2);
  });

  it("names the text it read as the text the change replaces", async () => {
    mountReading(2, () => Promise.resolve("Hello"));
    type("Hi");
    await enter();
    expect(pendingSaves[0].variables.edit).toMatchObject({
      kind: "set-text-node",
      index: 2,
      expectedText: "Hello",
    });
  });

  it("saves the whole element's text without an expectation", async () => {
    mountReading(null, readsHello);
    type("Hi");
    await enter();
    expect(pendingSaves[0].variables.edit).toEqual({
      kind: "set-text-content",
      text: "Hi",
    });
  });

  it("refuses to save over text a script changed after the editor opened", async () => {
    const { onClose } = mountReading(2, drifted);
    type("Mine");
    await enter();

    expect(pendingSaves).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe(CHANGED);
  });

  it("keeps the draft and focus when it refuses, so nothing typed is lost", async () => {
    mountReading(2, drifted);
    type("Mine, kept");
    await enter();

    expect(textarea().value).toBe("Mine, kept");
    expect(textarea().disabled).toBe(false);
    expect(document.activeElement).toBe(textarea());
  });

  it("refuses the same way when the page can no longer be read", async () => {
    const { onClose } = mountReading(2, () => Promise.resolve(null));
    type("Mine");
    await enter();

    expect(pendingSaves).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe(CHANGED);
    expect(textarea().value).toBe("Mine");
  });

  it("refuses a drifted element on blur too", async () => {
    const { onClose } = mountReading(null, drifted);
    type("Mine");
    await leave();
    expect(pendingSaves).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe(CHANGED);
  });

  it("lets a retry go through once the text on the page is back to what it was", async () => {
    let live = "Hello, now different";
    mountReading(2, () => Promise.resolve(live));
    type("Mine");
    await enter();
    expect(pendingSaves).toHaveLength(0);

    live = "Hello";
    await enter();
    expect(pendingSaves).toHaveLength(1);
    expect(pendingSaves[0].variables.edit).toMatchObject({
      text: "Mine",
      expectedText: "Hello",
    });
  });

  it("saves nothing if the selection moved while the page was being read", async () => {
    const read = deferred<string | null>();
    mountReading(2, () => read.promise);
    type("Mine");
    await enter();
    act(() => {
      useCanvasSelectionStore
        .getState()
        .select(textSelection(null, { tid: "other" }));
    });
    await act(async () => {
      read.resolve("Hello");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(pendingSaves).toHaveLength(0);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps typing made while the page was being read, sends nothing, and can be retried", async () => {
    const read = deferred<string | null>();
    const readText = vi
      .fn<ReadText>(readsHello)
      .mockImplementationOnce(() => read.promise);
    const { onClose } = mountReading(2, readText);
    type("Mine");
    await enter();

    // More typing arrives while the bridge round-trip is outstanding.
    type("Mine, and more");
    await act(async () => {
      read.resolve("Hello");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(pendingSaves).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
    expect(textarea().value).toBe("Mine, and more");
    expect(textarea().disabled).toBe(false);

    // The same text can be sent again, and it is the newer text that goes.
    await enter();
    expect(pendingSaves).toHaveLength(1);
    expect(pendingSaves[0].variables.edit).toMatchObject({
      kind: "set-text-node",
      index: 2,
      text: "Mine, and more",
      expectedText: "Hello",
    });
  });

  it("saves nothing if the editor was cancelled while the page was being read", async () => {
    const read = deferred<string | null>();
    mountReading(2, () => read.promise);
    type("Mine");
    await enter();
    await settled(() => fireEvent.keyDown(textarea(), { code: "Escape" }));
    await act(async () => {
      read.resolve("Hello");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(pendingSaves).toHaveLength(0);
  });

  it("saves nothing if the editor left the screen while the page was being read", async () => {
    const read = deferred<string | null>();
    mountReading(2, () => read.promise);
    type("Mine");
    await enter();
    cleanup();
    await act(async () => {
      read.resolve("Hello");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(pendingSaves).toHaveLength(0);
  });

  it("does not read the page twice for one Enter pressed again while it waits", async () => {
    const read = deferred<string | null>();
    const readText = vi.fn<ReadText>(() => read.promise);
    mountReading(2, readText);
    type("Mine");
    await act(async () => {
      fireEvent.keyDown(textarea(), { code: "Enter" });
      fireEvent.keyDown(textarea(), { code: "Enter" });
      fireEvent.blur(textarea());
      await Promise.resolve();
    });
    expect(readText).toHaveBeenCalledOnce();

    await act(async () => {
      read.resolve("Hello");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(pendingSaves).toHaveLength(1);
  });
});

describe("canvasTextEditorStyle", () => {
  it("places the editor over the element with its own text styling", () => {
    const style = canvasTextEditorStyle(
      textSelection(null, {
        box: { x: 12, y: 34, width: 300, height: 48 },
        computedStyles: [
          { property: "font-family", value: "Georgia" },
          { property: "font-size", value: "22px" },
          { property: "font-weight", value: "700" },
          { property: "line-height", value: "30px" },
          { property: "text-align", value: "center" },
          { property: "color", value: "rgb(1, 2, 3)" },
          { property: "background-color", value: "rgb(4, 5, 6)" },
          { property: "padding-top", value: "1px" },
          { property: "padding-right", value: "2px" },
          { property: "padding-bottom", value: "3px" },
          { property: "padding-left", value: "4px" },
        ],
      }),
    );
    expect(style).toMatchObject({
      "--text-x": "12px",
      "--text-y": "34px",
      "--text-width": "300px",
      "--text-height": "48px",
      "--text-font": "Georgia",
      "--text-size": "22px",
      "--text-weight": "700",
      "--text-leading": "30px",
      "--text-align": "center",
      "--text-color": "rgb(1, 2, 3)",
      "--text-background": "rgb(4, 5, 6)",
      "--text-padding-top": "1px",
      "--text-padding-right": "2px",
      "--text-padding-bottom": "3px",
      "--text-padding-left": "4px",
    });
  });

  it("falls back to values that do not hide the text when styles are missing", () => {
    expect(canvasTextEditorStyle(textSelection(null, {}))).toMatchObject({
      "--text-font": "inherit",
      "--text-size": "16px",
      "--text-weight": "normal",
      "--text-leading": "normal",
      "--text-align": "left",
      "--text-color": "var(--foreground)",
      "--text-background": "var(--background)",
      "--text-padding-top": "0px",
    });
  });

  it.each([
    ["transparent", "transparent"],
    ["a transparent rgba", "rgba(0, 0, 0, 0)"],
    ["a translucent rgba", "rgba(10, 20, 30, 0.5)"],
    ["a slash-alpha colour", "rgb(10 20 30 / 50%)"],
  ])(
    "uses the theme's own colours over %s, so the text underneath cannot show through",
    (_label, background) => {
      expect(
        canvasTextEditorStyle(
          textSelection(null, {
            computedStyles: [
              { property: "background-color", value: background },
              { property: "color", value: "rgb(200, 200, 200)" },
            ],
          }),
        ),
      ).toMatchObject({
        "--text-background": "var(--background)",
        "--text-color": "var(--foreground)",
      });
    },
  );

  it("keeps the element's own colours when its background is opaque", () => {
    expect(
      canvasTextEditorStyle(
        textSelection(null, {
          computedStyles: [
            { property: "background-color", value: "rgb(255, 238, 204)" },
            { property: "color", value: "rgb(34, 51, 68)" },
          ],
        }),
      ),
    ).toMatchObject({
      "--text-background": "rgb(255, 238, 204)",
      "--text-color": "rgb(34, 51, 68)",
    });
  });

  it("falls back to the theme's text colour when an opaque background names none", () => {
    expect(
      canvasTextEditorStyle(
        textSelection(null, {
          computedStyles: [
            { property: "background-color", value: "rgb(255, 238, 204)" },
          ],
        }),
      ),
    ).toMatchObject({
      "--text-background": "rgb(255, 238, 204)",
      "--text-color": "var(--foreground)",
    });
  });

  it("gives an empty or tiny element a box big enough to type in", () => {
    expect(
      canvasTextEditorStyle(
        textSelection(null, { box: { x: 0, y: 0, width: 0, height: 2 } }),
      ),
    ).toMatchObject({ "--text-width": "12px", "--text-height": "24px" });
  });
});
