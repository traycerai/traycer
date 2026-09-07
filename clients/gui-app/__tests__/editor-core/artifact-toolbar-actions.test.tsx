import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { EditorContent, EditorContext } from "@tiptap/react";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import {
  ArtifactToolbar,
  buildArtifactExtensions,
  deriveCollabUser,
} from "@/editor-core";

function mountToolbarEditor(): Editor {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("default");
  const awareness = new Awareness(doc);
  const user = deriveCollabUser({ userName: "T", email: "t@x.io" });
  return new Editor({
    extensions: buildArtifactExtensions({
      doc,
      fragment,
      awareness,
      user,
      onCommentShortcut: null,
      placeholderText: "Start writing…",
      titlePlaceholderText: "Untitled",
    }),
  });
}

/**
 * `BubbleMenu` only mounts its children when the editor has a non-empty
 * selection. Wait for the popover to attach before asserting on contents.
 */
async function revealBubbleMenu(): Promise<void> {
  await waitFor(
    () => {
      if (screen.queryByRole("toolbar", { hidden: true }) === null) {
        throw new Error("bubble menu not shown yet");
      }
    },
    { timeout: 1000 },
  );
}

/**
 * The bubble menu's floating wrapper sits under an ancestor the accessible
 * name algorithm treats as hidden (the existing `artifact-toolbar.test.tsx`
 * suite works around the same thing), so `getByRole(..., { name })` can never
 * match a button in here - accessible-name computation returns "" under a
 * hidden ancestor regardless of `hidden: true`, which only widens which
 * elements the query itself is willing to consider. Read the visible label
 * straight off each button instead: `aria-label` when the button sets one
 * (the icon-only formatting toggles), else its own text content (the labeled
 * action buttons).
 */
function toolbarButtons(
  toolbar: HTMLElement,
): ReadonlyArray<{ readonly element: HTMLElement; readonly name: string }> {
  return within(toolbar)
    .getAllByRole("button", { hidden: true })
    .map((element) => ({
      element,
      name: element.getAttribute("aria-label") ?? element.textContent,
    }));
}

function findButton(toolbar: HTMLElement, name: string): HTMLElement {
  const found = toolbarButtons(toolbar).find((button) => button.name === name);
  if (found === undefined) {
    throw new Error(`no toolbar button named "${name}"`);
  }
  return found.element;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ArtifactToolbar actions", () => {
  it("renders Comment and Send to chat with accessible names when both are given", async () => {
    const editor = mountToolbarEditor();
    editor.commands.setContent("hello world");
    editor.commands.selectAll();
    render(
      <EditorContext.Provider value={{ editor }}>
        <EditorContent editor={editor} />
        <ArtifactToolbar
          editor={editor}
          className={undefined}
          scrollTarget={null}
          commentAction={{ onStart: () => {} }}
          quoteAction={{ onStart: () => {} }}
          suppressBubbleMenu={false}
        />
      </EditorContext.Provider>,
    );
    await revealBubbleMenu();
    const toolbar = screen.getByRole("toolbar", { hidden: true });
    const names = toolbarButtons(toolbar).map((button) => button.name);

    expect(names).toContain("Comment");
    expect(names).toContain("Send to chat");
    editor.destroy();
  });

  it("clicking Send to chat starts the quote action without collapsing the selection", async () => {
    const editor = mountToolbarEditor();
    editor.commands.setContent("hello world");
    editor.commands.selectAll();
    const onStart = vi.fn();
    render(
      <EditorContext.Provider value={{ editor }}>
        <EditorContent editor={editor} />
        <ArtifactToolbar
          editor={editor}
          className={undefined}
          scrollTarget={null}
          commentAction={null}
          quoteAction={{ onStart }}
          suppressBubbleMenu={false}
        />
      </EditorContext.Provider>,
    );
    await revealBubbleMenu();
    const toolbar = screen.getByRole("toolbar", { hidden: true });
    const button = findButton(toolbar, "Send to chat");

    expect(editor.state.selection.empty).toBe(false);
    fireEvent.mouseDown(button);
    fireEvent.click(button);

    expect(onStart).toHaveBeenCalledTimes(1);
    // The button's own `onMouseDown` prevents default so it never steals
    // focus, which is what keeps the editor's own selection intact.
    expect(editor.state.selection.empty).toBe(false);
    editor.destroy();
  });

  it("hides formatting for a non-editable editor but still shows both actions", () => {
    const editor = mountToolbarEditor();
    editor.setEditable(false);
    editor.commands.setContent("hello world");
    editor.commands.selectAll();
    render(
      <EditorContext.Provider value={{ editor }}>
        <EditorContent editor={editor} />
        <ArtifactToolbar
          editor={editor}
          className={undefined}
          scrollTarget={null}
          commentAction={{ onStart: () => {} }}
          quoteAction={{ onStart: () => {} }}
          suppressBubbleMenu={false}
        />
      </EditorContext.Provider>,
    );

    const toolbar = screen.getByRole("toolbar", { hidden: true });
    const names = toolbarButtons(toolbar).map((button) => button.name);

    expect(names).not.toContain("Bold");
    expect(names).toContain("Comment");
    expect(names).toContain("Send to chat");
    editor.destroy();
  });

  it("renders actions only for a selection inside a code block", async () => {
    const editor = mountToolbarEditor();
    const text = "const x = 1;";
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          content: [{ type: "text", text }],
        },
      ],
    });
    editor.commands.setTextSelection({ from: 1, to: 1 + text.length });
    render(
      <EditorContext.Provider value={{ editor }}>
        <EditorContent editor={editor} />
        <ArtifactToolbar
          editor={editor}
          className={undefined}
          scrollTarget={null}
          commentAction={{ onStart: () => {} }}
          quoteAction={{ onStart: () => {} }}
          suppressBubbleMenu={false}
        />
      </EditorContext.Provider>,
    );
    await revealBubbleMenu();
    const toolbar = screen.getByRole("toolbar", { hidden: true });
    const names = toolbarButtons(toolbar).map((button) => button.name);

    expect(names).not.toContain("Bold");
    expect(names).toContain("Comment");
    expect(names).toContain("Send to chat");
    editor.destroy();
  });

  it("folds formatting into a Formatting overflow trigger when the tile is too narrow", async () => {
    // jsdom has no layout, so `useCompactToolbar` reads zero for every
    // element's offsetWidth/clientWidth by default. Stub both, keyed off a
    // marker on the scroll container and the toolbar's own `role`, so the
    // hook sees a full bar wider than the available space and folds it.
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get(this: HTMLElement) {
        if (this.getAttribute("role") === "toolbar") return 400;
        if (this.dataset.testScroll === "true") return 60;
        return 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get(this: HTMLElement) {
        if (this.dataset.testScroll === "true") return 60;
        return 0;
      },
    });

    class StubResizeObserver {
      private readonly cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb;
      }
      observe(target: Element): void {
        this.cb([{ target } as unknown as ResizeObserverEntry], this);
      }
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal("ResizeObserver", StubResizeObserver);

    const editor = mountToolbarEditor();
    editor.commands.setContent("hello world");
    editor.commands.selectAll();
    const scrollTarget = document.createElement("div");
    scrollTarget.dataset.testScroll = "true";
    document.body.append(scrollTarget);

    render(
      <EditorContext.Provider value={{ editor }}>
        <EditorContent editor={editor} />
        <ArtifactToolbar
          editor={editor}
          className={undefined}
          scrollTarget={scrollTarget}
          commentAction={null}
          quoteAction={null}
          suppressBubbleMenu={false}
        />
      </EditorContext.Provider>,
      { container: scrollTarget },
    );
    await revealBubbleMenu();

    await waitFor(() => {
      const toolbar = screen.getByRole("toolbar", { hidden: true });
      expect(toolbar.getAttribute("data-compact")).toBe("true");
    });
    const toolbar = screen.getByRole("toolbar", { hidden: true });
    const names = toolbarButtons(toolbar).map((button) => button.name);

    expect(names).not.toContain("Bold");
    expect(names).toContain("Formatting");

    editor.destroy();
    scrollTarget.remove();
    Reflect.deleteProperty(HTMLElement.prototype, "offsetWidth");
    Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
  });
});
