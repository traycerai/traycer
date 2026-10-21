import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { CanvasNote } from "@traycer/protocol/persistence/epic/canvas-layout";
import { CanvasNoteContent } from "../canvas-note-content";
import { isCanvasTextInput, noteDimensions } from "../canvas-model";

interface DrawnLine {
  readonly viewBox: { readonly width: number; readonly height: number };
  readonly from: { readonly x: number; readonly y: number };
  readonly to: { readonly x: number; readonly y: number };
  readonly arrowhead: boolean;
}

function numberAttribute(element: Element, name: string): number {
  const value = Number(element.getAttribute(name));
  if (!Number.isFinite(value)) throw new Error(`${name} is not a number`);
  return value;
}

function drawLine(note: CanvasNote): DrawnLine {
  render(
    <CanvasNoteContent
      note={note}
      imageSource={null}
      onCommit={() => undefined}
    />,
  );
  const svg = screen.getByLabelText(note.type ?? "line");
  const line = svg.querySelector("line");
  if (line === null) throw new Error("the note drew no line");
  const [, , width, height] = (svg.getAttribute("viewBox") ?? "")
    .split(" ")
    .map(Number);
  return {
    viewBox: { width, height },
    from: { x: numberAttribute(line, "x1"), y: numberAttribute(line, "y1") },
    to: { x: numberAttribute(line, "x2"), y: numberAttribute(line, "y2") },
    arrowhead: line.hasAttribute("marker-end"),
  };
}

afterEach(cleanup);

describe("CanvasNoteContent lines", () => {
  it("draws a diagonal from the box's top-left to its bottom-right", () => {
    const drawn = drawLine({ type: "line", x: 10, y: 20, x2: 60, y2: 60 });
    expect(drawn.viewBox).toEqual({ width: 50, height: 40 });
    expect(drawn.from).toEqual({ x: 0, y: 0 });
    expect(drawn.to).toEqual({ x: 50, y: 40 });
  });

  it("starts a reversed diagonal at the far corner so the direction survives", () => {
    const drawn = drawLine({ type: "line", x: 60, y: 60, x2: 10, y2: 20 });
    expect(drawn.from).toEqual({ x: 50, y: 40 });
    expect(drawn.to).toEqual({ x: 0, y: 0 });
  });

  it("flips only the axis that is reversed", () => {
    const drawn = drawLine({ type: "line", x: 10, y: 60, x2: 60, y2: 20 });
    expect(drawn.from).toEqual({ x: 0, y: 40 });
    expect(drawn.to).toEqual({ x: 50, y: 0 });
  });

  it("keeps a horizontal line flat inside its drawable box", () => {
    const drawn = drawLine({ type: "line", x: 10, y: 50, x2: 210, y2: 50 });
    // The flat axis stays on the line's own coordinate (the box origin), not
    // on the centre of the minimum-height box, which would draw it 6 lower.
    expect(drawn.from.y).toBe(0);
    expect(drawn.to.y).toBe(0);
    expect(drawn.to.x - drawn.from.x).toBe(200);
  });

  it("keeps a vertical line upright inside its drawable box", () => {
    const drawn = drawLine({ type: "line", x: 40, y: 10, x2: 40, y2: 310 });
    expect(drawn.from.x).toBe(0);
    expect(drawn.to.x).toBe(0);
    expect(drawn.to.y - drawn.from.y).toBe(300);
  });

  it("keeps a reversed horizontal line pointing left", () => {
    const drawn = drawLine({ type: "line", x: 210, y: 50, x2: 10, y2: 50 });
    expect(drawn.from.y).toBe(0);
    expect(drawn.to.y).toBe(0);
    expect(drawn.to.x - drawn.from.x).toBe(-200);
  });

  it("keeps the true slope of a shallow 100 by 1 line", () => {
    const drawn = drawLine({ type: "line", x: 0, y: 0, x2: 100, y2: 1 });
    expect(drawn.to.x - drawn.from.x).toBe(100);
    expect(drawn.to.y - drawn.from.y).toBe(1);
  });

  it("keeps the true slope and direction of a reversed shallow line", () => {
    const drawn = drawLine({ type: "line", x: 100, y: 1, x2: 0, y2: 0 });
    expect(drawn.to.x - drawn.from.x).toBe(-100);
    expect(drawn.to.y - drawn.from.y).toBe(-1);
  });

  it("keeps every drawn point inside the view box", () => {
    for (const note of [
      { type: "line", x: 0, y: 0, x2: 100, y2: 1 },
      { type: "arrow", x: 100, y: 1, x2: 0, y2: 0 },
      { type: "line", x: 0, y: 5, x2: 100, y2: 5 },
      { type: "arrow", x: 5, y: 0, x2: 5, y2: 100 },
    ] satisfies CanvasNote[]) {
      cleanup();
      const { from, to, viewBox } = drawLine(note);
      for (const point of [from, to]) {
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(viewBox.width);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeLessThanOrEqual(viewBox.height);
      }
    }
  });

  it("sizes the view box like the node that hosts it", () => {
    const note: CanvasNote = { type: "arrow", x: 110, y: 90, x2: 10, y2: 20 };
    const drawn = drawLine(note);
    const { width, height } = noteDimensions(note);
    expect(drawn.viewBox).toEqual({ width, height });
  });

  it("gives only arrows an arrowhead", () => {
    expect(
      drawLine({ type: "arrow", x: 0, y: 0, x2: 50, y2: 50 }).arrowhead,
    ).toBe(true);
    cleanup();
    expect(
      drawLine({ type: "line", x: 0, y: 0, x2: 50, y2: 50 }).arrowhead,
    ).toBe(false);
  });
});

describe("CanvasNoteContent text editing", () => {
  const PLACEHOLDER = "Type something";

  // The editor observes its own size, and jsdom has no ResizeObserver.
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        disconnect(): void {}
      },
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  interface EditorHarness {
    readonly onCommit: Mock<(text: string) => void>;
    readonly onGrow: Mock<(height: number) => void>;
    readonly onRootKeyDown: Mock<(code: string) => void>;
    readonly root: HTMLElement;
    readonly textarea: HTMLTextAreaElement;
  }

  // The wrapper stands in for the canvas surface, whose keyboard handler
  // deletes, nudges and switches tools: typing a note must never reach it.
  function editNote(note: CanvasNote): EditorHarness {
    const onCommit = vi.fn<(text: string) => void>();
    const onGrow = vi.fn<(height: number) => void>();
    const onRootKeyDown = vi.fn<(code: string) => void>();
    render(
      <div
        role="presentation"
        data-testid="surface"
        onKeyDown={(event) => onRootKeyDown(event.code)}
      >
        <CanvasNoteContent
          note={note}
          imageSource={null}
          editing
          onEdit={() => undefined}
          onGrow={onGrow}
          onCommit={onCommit}
        />
      </div>,
    );
    const textarea = screen.getByRole("textbox");
    if (!(textarea instanceof HTMLTextAreaElement))
      throw new Error("the editor is not a textarea");
    return {
      onCommit,
      onGrow,
      onRootKeyDown,
      root: screen.getByTestId("surface"),
      textarea,
    };
  }

  it("opens focused with the caret after the existing text", () => {
    const { textarea } = editNote({ type: "sticky", text: "Draft" });
    expect(document.activeElement).toBe(textarea);
    expect(textarea.value).toBe("Draft");
    expect(textarea.selectionStart).toBe("Draft".length);
    expect(textarea.selectionEnd).toBe("Draft".length);
  });

  it("shows the placeholder for an empty note without storing it as text", () => {
    const { textarea } = editNote({ type: "title", text: "" });
    expect(textarea.placeholder).toBe(PLACEHOLDER);
    expect(textarea.value).toBe("");
  });

  it("is recognised as a text input so canvas shortcuts stand down", () => {
    const { textarea, root } = editNote({ type: "sticky", text: "" });
    expect(isCanvasTextInput(textarea, root)).toBe(true);
  });

  it("keeps typed characters away from the canvas keyboard handler", async () => {
    const { textarea, onRootKeyDown } = editNote({ type: "sticky", text: "" });
    await userEvent.type(textarea, "Hello note");
    expect(textarea.value).toBe("Hello note");
    expect(onRootKeyDown).not.toHaveBeenCalled();
  });

  it("keeps Delete and Backspace in the text instead of deleting the note", async () => {
    const { textarea, onRootKeyDown } = editNote({
      type: "sticky",
      text: "abc",
    });
    await userEvent.type(textarea, "{Backspace}{Delete}");
    expect(onRootKeyDown).not.toHaveBeenCalled();
  });

  it("commits what was typed when focus leaves", async () => {
    const { textarea, onCommit } = editNote({ type: "sticky", text: "" });
    await userEvent.type(textarea, "Hello note");
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.blur(textarea);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("Hello note");
  });

  it("commits the edited text on Escape without letting Escape reach the canvas", async () => {
    const { textarea, onCommit, onRootKeyDown } = editNote({
      type: "title",
      text: "Roadmap",
    });
    await userEvent.type(textarea, " 2027{Escape}");
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("Roadmap 2027");
    expect(onRootKeyDown).not.toHaveBeenCalled();
  });

  it("commits an emptied note as empty text, never as the placeholder", () => {
    const { textarea, onCommit } = editNote({ type: "sticky", text: "Old" });
    fireEvent.input(textarea, { target: { value: "" } });
    fireEvent.blur(textarea);
    expect(onCommit).toHaveBeenCalledWith("");
    expect(onCommit).not.toHaveBeenCalledWith(PLACEHOLDER);
  });

  it("reports the textarea's measured scroll height on mount, input and resize", () => {
    // jsdom has no layout: the height and the observer are injected to prove
    // the editor reports the element's own measurement rather than computing
    // one. Real wrapping is the browser's business.
    let measured = 96;
    const scrollHeight = vi
      .spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get")
      .mockImplementation(() => measured);
    let resize: () => void = () => undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe(): void {}
        disconnect(): void {}
      },
    );
    try {
      const { textarea, onGrow } = editNote({ type: "sticky", text: "" });
      expect(onGrow).toHaveBeenLastCalledWith(96);
      measured = 180;
      fireEvent.input(textarea, { target: { value: "one\ntwo\nthree" } });
      expect(onGrow).toHaveBeenLastCalledWith(180);
      measured = 240;
      resize();
      expect(onGrow).toHaveBeenLastCalledWith(240);
    } finally {
      scrollHeight.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  // The note's height is written back from this measurement and the editor
  // tracks that height, so a repeat of an unchanged height would feed itself
  // ("Maximum update depth"). jsdom cannot reproduce the live layout loop;
  // this holds the two edges the loop travels through: the observer firing
  // again, and a render handing the editor a fresh onGrow closure.
  it("does not report a height again while the measured height is unchanged", () => {
    const measured = 120;
    const scrollHeight = vi
      .spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get")
      .mockImplementation(() => measured);
    let resize: () => void = () => undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe(): void {}
        disconnect(): void {}
      },
    );
    try {
      const note: CanvasNote = { type: "sticky", text: "" };
      const spy = vi.fn<(height: number) => void>();
      const view = (onGrow: (height: number) => void) => (
        <CanvasNoteContent
          note={note}
          imageSource={null}
          editing
          onEdit={() => undefined}
          onGrow={onGrow}
          onCommit={() => undefined}
        />
      );
      const { rerender } = render(view((height) => spy(height)));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenLastCalledWith(120);
      resize();
      resize();
      expect(spy).toHaveBeenCalledTimes(1);
      rerender(view((height) => spy(height)));
      rerender(view((height) => spy(height)));
      resize();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      scrollHeight.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

describe("CanvasNoteContent text display", () => {
  function displayText(note: CanvasNote, props: { viewOnly?: boolean }) {
    const onEdit = vi.fn<() => void>();
    render(
      <CanvasNoteContent
        note={note}
        imageSource={null}
        viewOnly={props.viewOnly}
        onEdit={onEdit}
        onCommit={() => undefined}
      />,
    );
    return onEdit;
  }

  it("shows a dimmed placeholder for an empty note instead of saved text", () => {
    displayText({ type: "title", text: "" }, {});
    const placeholder = screen.getByText("Type something");
    expect(placeholder.className).toContain("opacity-50");
  });

  it("shows the saved text and no placeholder once the note has text", () => {
    displayText({ type: "sticky", text: "Ship it" }, {});
    expect(screen.getByText("Ship it")).toBeDefined();
    expect(screen.queryByText("Type something")).toBeNull();
  });

  it("asks to edit on double click, but not in a view-only canvas", () => {
    const onEdit = displayText({ type: "sticky", text: "Ship it" }, {});
    fireEvent.doubleClick(screen.getByText("Ship it"));
    expect(onEdit).toHaveBeenCalledTimes(1);
    cleanup();
    const viewOnlyEdit = displayText(
      { type: "sticky", text: "Ship it" },
      { viewOnly: true },
    );
    fireEvent.doubleClick(screen.getByText("Ship it"));
    expect(viewOnlyEdit).not.toHaveBeenCalled();
  });

  it("keeps sticky text readable on both dark and light fills", () => {
    displayText({ type: "sticky", text: "Dark", color: "#101820" }, {});
    const darkFill = screen.getByRole("button", {
      name: "Edit sticky note",
    }).parentElement;
    expect(darkFill?.style.getPropertyValue("--canvas-note-color")).toBe(
      "#ffffff",
    );
    cleanup();
    displayText({ type: "sticky", text: "Light", color: "#fff3a3" }, {});
    const lightFill = screen.getByRole("button", {
      name: "Edit sticky note",
    }).parentElement;
    expect(lightFill?.style.getPropertyValue("--canvas-note-color")).toBe(
      "#202020",
    );
  });

  it("paints a title's text with its own colour", () => {
    displayText({ type: "title", text: "Plan", color: "#101820" }, {});
    const title = screen.getByRole("button", {
      name: "Edit title",
    }).parentElement;
    expect(title?.style.getPropertyValue("--canvas-note-color")).toBe(
      "#101820",
    );
  });
});
