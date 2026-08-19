import { Editor, type JSONContent } from "@tiptap/core";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { RefObject } from "react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { buildArtifactExtensions, deriveCollabUser } from "@/editor-core";
import { ArtifactHeadingMinimap } from "../artifact-heading-minimap";
import { ARTIFACT_HEADING_SCROLL_PADDING } from "../artifact-heading-items";

const editors: Editor[] = [];
const CONTENT: JSONContent = {
  type: "doc",
  content: [
    {
      type: "heading",
      attrs: { level: 1 },
      content: [{ type: "text", text: "Title" }],
    },
    { type: "paragraph", content: [{ type: "text", text: "Intro" }] },
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "Section A" }],
    },
    { type: "paragraph", content: [{ type: "text", text: "Body" }] },
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "Section B" }],
    },
  ],
};

function rect(input: {
  readonly left: number;
  readonly right: number;
  readonly top?: number;
}): DOMRect {
  const top = input.top ?? 0;
  return {
    x: input.left,
    y: top,
    width: input.right - input.left,
    height: 0,
    top,
    right: input.right,
    bottom: top,
    left: input.left,
    toJSON: () => ({}),
  };
}

function headingContent(count: number): JSONContent {
  return {
    type: "doc",
    content: Array.from({ length: count }, (_unused, index) => ({
      type: "heading",
      attrs: { level: index % 4 === 0 ? 1 : 2 },
      content: [{ type: "text", text: `Section ${index}` }],
    })),
  };
}

function makeEditor(content: JSONContent): Editor {
  const ydoc = new Y.Doc();
  const editor = new Editor({
    extensions: buildArtifactExtensions({
      doc: ydoc,
      fragment: ydoc.getXmlFragment("default"),
      awareness: new Awareness(ydoc),
      user: deriveCollabUser({ userName: "Tester", email: "t@x.io" }),
      onCommentShortcut: null,
      placeholderText: "Start writing…",
      titlePlaceholderText: "Untitled",
    }),
  });
  editor.commands.setContent(content);
  editors.push(editor);
  return editor;
}

function makeScroller(
  input:
    | {
        readonly clientHeight?: number;
        readonly scrollTop?: number;
      }
    | undefined,
): {
  readonly element: HTMLElement;
  readonly scrollTo: Mock<(options: ScrollToOptions) => void>;
} {
  const options = input ?? {};
  const element = document.createElement("div");
  element.getBoundingClientRect = () => rect({ left: 0, right: 600 });
  Object.defineProperty(element, "scrollTop", {
    value: options.scrollTop ?? 0,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(element, "clientHeight", {
    value: options.clientHeight ?? 400,
    configurable: true,
  });
  Object.defineProperty(element, "scrollHeight", {
    value: 900,
    configurable: true,
  });
  const scrollTo = vi.fn<(options: ScrollToOptions) => void>();
  Object.defineProperty(element, "scrollTo", {
    configurable: true,
    value: scrollTo,
  });
  return { element, scrollTo };
}

function stubLayout(
  editor: Editor,
  input:
    | { readonly contentLeft?: number; readonly contentRight?: number }
    | undefined,
): void {
  const options = input ?? {};
  editor.view.dom.getBoundingClientRect = () =>
    rect({
      left: options.contentLeft ?? 60,
      right: options.contentRight ?? 540,
    });
  Array.from(editor.view.dom.querySelectorAll("h1, h2")).forEach(
    (heading, index) => {
      heading.getBoundingClientRect = () =>
        rect({ left: 60, right: 540, top: index * 300 });
    },
  );
}

function refreshRef(): RefObject<() => void> {
  return { current: () => undefined };
}

async function flushFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
}

afterEach(() => {
  cleanup();
  editors.splice(0).forEach((editor) => editor.destroy());
});

describe("ArtifactHeadingMinimap", () => {
  it("shows one item for an artifact with one heading", async () => {
    const editor = makeEditor({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 1 },
          content: [{ type: "text", text: "Only heading" }],
        },
      ],
    });
    const scroller = makeScroller(undefined);
    stubLayout(editor, undefined);
    render(
      <ArtifactHeadingMinimap
        editor={editor}
        refreshRef={refreshRef()}
        scroller={scroller.element}
        side="right"
      />,
    );
    await flushFrame();

    expect(screen.getAllByTestId("artifact-heading-minimap-tick")).toHaveLength(
      1,
    );
  });

  it("opens at the top section with one active row", async () => {
    const editor = makeEditor(CONTENT);
    const scroller = makeScroller(undefined);
    stubLayout(editor, undefined);
    render(
      <ArtifactHeadingMinimap
        editor={editor}
        refreshRef={refreshRef()}
        scroller={scroller.element}
        side="left"
      />,
    );
    await flushFrame();
    expect(
      screen
        .getAllByTestId("artifact-heading-minimap-tick")[0]
        .hasAttribute("data-minimap-rail-tick"),
    ).toBe(true);
    const ticks = screen.getAllByTestId("artifact-heading-minimap-tick");
    expect(ticks[0].classList.contains("w-5")).toBe(true);
    expect(ticks[1].classList.contains("w-4")).toBe(true);
    fireEvent.mouseEnter(
      screen.getByRole("group", { name: "Document outline controls" }),
    );

    const card = screen.getByTestId("artifact-heading-minimap-card");
    expect(card.querySelectorAll("[data-minimap-list-row]")).toHaveLength(3);
    const active = card.querySelectorAll('[aria-current="location"]');
    expect(active).toHaveLength(1);
    expect(active[0].textContent).toContain("Title");
  });

  it("uses the same half-height bar window as chat", async () => {
    const editor = makeEditor(headingContent(30));
    const scroller = makeScroller({ clientHeight: 400 });
    stubLayout(editor, undefined);
    render(
      <ArtifactHeadingMinimap
        editor={editor}
        refreshRef={refreshRef()}
        scroller={scroller.element}
        side="left"
      />,
    );
    await flushFrame();

    expect(screen.getAllByTestId("artifact-heading-minimap-tick")).toHaveLength(
      23,
    );
    expect(
      screen.getByTestId("artifact-heading-minimap-hit-strip").className,
    ).toContain("mask-image");
  });

  it("keeps H1 longer while an active H2 uses the default width", async () => {
    const editor = makeEditor(CONTENT);
    const scroller = makeScroller(undefined);
    const refresh = refreshRef();
    stubLayout(editor, undefined);
    render(
      <ArtifactHeadingMinimap
        editor={editor}
        refreshRef={refresh}
        scroller={scroller.element}
        side="right"
      />,
    );
    await flushFrame();
    scroller.element.scrollTop = 300;
    act(() => refresh.current());

    const ticks = screen.getAllByTestId("artifact-heading-minimap-tick");
    expect(ticks[0].classList.contains("w-5")).toBe(true);
    expect(ticks.map((tick) => tick.getAttribute("data-active"))).toEqual([
      "false",
      "true",
      "false",
    ]);
    expect(ticks[1].classList.contains("w-4")).toBe(true);
    expect(ticks[2].classList.contains("w-4")).toBe(true);
  });

  it("uses arrow then Enter without closing the list", async () => {
    const editor = makeEditor(CONTENT);
    const scroller = makeScroller(undefined);
    stubLayout(editor, undefined);
    render(
      <ArtifactHeadingMinimap
        editor={editor}
        refreshRef={refreshRef()}
        scroller={scroller.element}
        side="left"
      />,
    );
    await flushFrame();
    const hitStrip = screen.getByRole("button", { name: "Document outline" });
    fireEvent.focus(hitStrip);
    fireEvent.keyDown(hitStrip, { key: "ArrowDown" });
    expect(scroller.scrollTo).not.toHaveBeenCalled();
    fireEvent.keyDown(hitStrip, { key: "Enter" });

    expect(scroller.scrollTo).toHaveBeenCalledOnce();
    expect(scroller.scrollTo.mock.calls[0][0].top).toBe(
      300 - ARTIFACT_HEADING_SCROLL_PADDING,
    );
    expect(["auto", "smooth"]).toContain(
      scroller.scrollTo.mock.calls[0][0].behavior,
    );
    expect(screen.getByTestId("artifact-heading-minimap-card")).toBeTruthy();
  });

  it("supports the right side and expands inward", async () => {
    const editor = makeEditor(CONTENT);
    const scroller = makeScroller(undefined);
    stubLayout(editor, undefined);
    render(
      <ArtifactHeadingMinimap
        editor={editor}
        refreshRef={refreshRef()}
        scroller={scroller.element}
        side="right"
      />,
    );
    await flushFrame();
    const minimap = screen.getByTestId("artifact-heading-minimap");
    expect(minimap.getAttribute("data-side")).toBe("right");
    fireEvent.mouseEnter(
      screen.getByRole("group", { name: "Document outline controls" }),
    );
    expect(
      screen
        .getByTestId("artifact-heading-minimap-card")
        .classList.contains("right-0"),
    ).toBe(true);
  });

  it("hides completely when neither side has a safe empty gutter", async () => {
    const editor = makeEditor(CONTENT);
    const scroller = makeScroller(undefined);
    stubLayout(editor, { contentLeft: 10, contentRight: 590 });
    render(
      <ArtifactHeadingMinimap
        editor={editor}
        refreshRef={refreshRef()}
        scroller={scroller.element}
        side="right"
      />,
    );
    await flushFrame();
    expect(screen.queryByTestId("artifact-heading-minimap")).toBeNull();
  });
});
