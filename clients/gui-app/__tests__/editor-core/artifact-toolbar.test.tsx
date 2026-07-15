import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { EditorContent, EditorContext, useEditor } from "@tiptap/react";
import { useCallback, useState } from "react";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import {
  ArtifactToolbar,
  buildArtifactExtensions,
  deriveCollabUser,
} from "@/editor-core";

function buildToolbarExtensions() {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("default");
  const awareness = new Awareness(doc);
  const user = deriveCollabUser({ userName: "T", email: "t@x.io" });
  return buildArtifactExtensions({
    doc,
    fragment,
    awareness,
    user,
    onCommentShortcut: null,
    placeholderText: "Start writing…",
    titlePlaceholderText: "Untitled",
  });
}

function mountToolbarEditor(): Editor {
  return new Editor({ extensions: buildToolbarExtensions() });
}

function RefOwnedToolbarHarness({
  onScrollTarget,
}: {
  readonly onScrollTarget: (element: HTMLDivElement) => void;
}) {
  const [extensions] = useState(buildToolbarExtensions);
  const editor = useEditor({ extensions, immediatelyRender: false });
  const [scrollTarget, setScrollTarget] = useState<HTMLDivElement | null>(null);
  const setScrollContainerRef = useCallback(
    (element: HTMLDivElement | null): void => {
      if (element !== null) onScrollTarget(element);
      setScrollTarget(element);
    },
    [onScrollTarget],
  );

  return (
    <div ref={setScrollContainerRef} className="overflow-y-auto">
      {editor !== null ? (
        <>
          <EditorContent editor={editor} />
          <ArtifactToolbar
            editor={editor}
            className={undefined}
            scrollTarget={scrollTarget}
            commentAction={null}
            suppressBubbleMenu={false}
          />
        </>
      ) : null}
    </div>
  );
}

/**
 * `BubbleMenu` only mounts its children when the editor has a non-empty
 * selection. Seed a paragraph, select it, and wait for the popover to
 * attach before asserting on toolbar contents.
 */
async function revealBubbleMenu(editor: Editor): Promise<void> {
  editor.commands.setContent("hello world");
  editor.commands.selectAll();
  await waitFor(
    () => {
      if (
        screen.queryByRole("toolbar", { name: /editor formatting/i }) === null
      ) {
        throw new Error("bubble menu not shown yet");
      }
    },
    { timeout: 1000 },
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ArtifactToolbar", () => {
  it("exposes a toolbar region with formatting buttons when selection active", async () => {
    const editor = mountToolbarEditor();
    render(
      <EditorContext.Provider value={{ editor }}>
        <EditorContent editor={editor} />
        <ArtifactToolbar
          editor={editor}
          className={undefined}
          scrollTarget={null}
          commentAction={null}
          suppressBubbleMenu={false}
        />
      </EditorContext.Provider>,
    );
    await revealBubbleMenu(editor);
    expect(screen.getByRole("button", { name: /bold/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /heading 1/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^undo$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^redo$/i })).toBeNull();
    editor.destroy();
  });

  it("stays hidden while the editor is not editable", () => {
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
          commentAction={null}
          suppressBubbleMenu={false}
        />
      </EditorContext.Provider>,
    );
    // The shouldShow callback on the bubble menu short-circuits on
    // `!editor.isEditable`, so the popover is never mounted.
    expect(
      screen.queryByRole("toolbar", { name: /editor formatting/i }),
    ).toBeNull();
    editor.destroy();
  });

  it("stays hidden while the comment draft composer owns the selection", () => {
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
          suppressBubbleMenu
        />
      </EditorContext.Provider>,
    );

    expect(
      screen.queryByRole("toolbar", { name: /editor formatting/i }),
    ).toBeNull();
    editor.destroy();
  });

  it("repositions from scroll events on the tile scroll container", async () => {
    const editor = mountToolbarEditor();
    const scrollContainer = document.createElement("div");
    scrollContainer.className = "overflow-y-auto";
    document.body.append(scrollContainer);
    const containerAddEventListener = vi.spyOn(
      scrollContainer,
      "addEventListener",
    );
    const windowAddEventListener = vi.spyOn(window, "addEventListener");
    const coordsAtPos = vi.spyOn(editor.view, "coordsAtPos");

    render(
      <EditorContext.Provider value={{ editor }}>
        <EditorContent editor={editor} />
        <ArtifactToolbar
          editor={editor}
          className={undefined}
          scrollTarget={scrollContainer}
          commentAction={null}
          suppressBubbleMenu={false}
        />
      </EditorContext.Provider>,
      { container: scrollContainer },
    );
    await revealBubbleMenu(editor);

    expect(containerAddEventListener).toHaveBeenCalledWith(
      "scroll",
      expect.any(Function),
    );
    expect(windowAddEventListener).not.toHaveBeenCalledWith(
      "scroll",
      expect.any(Function),
    );

    coordsAtPos.mockClear();
    fireEvent.scroll(scrollContainer);
    await waitFor(() => expect(coordsAtPos).toHaveBeenCalled(), {
      timeout: 500,
    });

    editor.destroy();
    scrollContainer.remove();
  });

  it("attaches to the ref-owned target when the editor arrives after mount", async () => {
    const scrollTargetListenerAssertions: Array<() => void> = [];
    const windowAddEventListener = vi.spyOn(window, "addEventListener");

    render(
      <RefOwnedToolbarHarness
        onScrollTarget={(element) => {
          const addEventListener = vi.spyOn(element, "addEventListener");
          scrollTargetListenerAssertions.push(() => {
            expect(addEventListener).toHaveBeenCalledWith(
              "scroll",
              expect.any(Function),
            );
          });
        }}
      />,
    );

    await waitFor(() => {
      expect(scrollTargetListenerAssertions).toHaveLength(1);
      scrollTargetListenerAssertions[0]();
    });
    expect(windowAddEventListener).not.toHaveBeenCalledWith(
      "scroll",
      expect.any(Function),
    );
  });

  it("moves the listener across target identities and removes it on unmount", async () => {
    const editor = mountToolbarEditor();
    const scrollContainer = document.createElement("div");
    scrollContainer.className = "overflow-y-auto";
    document.body.append(scrollContainer);
    const replacementScrollContainer = document.createElement("div");
    replacementScrollContainer.className = "overflow-y-auto";
    document.body.append(replacementScrollContainer);
    const containerAddEventListener = vi.spyOn(
      scrollContainer,
      "addEventListener",
    );
    const containerRemoveEventListener = vi.spyOn(
      scrollContainer,
      "removeEventListener",
    );
    const replacementAddEventListener = vi.spyOn(
      replacementScrollContainer,
      "addEventListener",
    );
    const replacementRemoveEventListener = vi.spyOn(
      replacementScrollContainer,
      "removeEventListener",
    );
    const windowAddEventListener = vi.spyOn(window, "addEventListener");
    const windowRemoveEventListener = vi.spyOn(window, "removeEventListener");
    const coordsAtPos = vi.spyOn(editor.view, "coordsAtPos");

    const view = render(
      <EditorContext.Provider value={{ editor }}>
        <EditorContent editor={editor} />
        <ArtifactToolbar
          editor={editor}
          className={undefined}
          scrollTarget={null}
          commentAction={null}
          suppressBubbleMenu={false}
        />
      </EditorContext.Provider>,
      { container: scrollContainer },
    );
    await revealBubbleMenu(editor);
    expect(windowAddEventListener).toHaveBeenCalledWith(
      "scroll",
      expect.any(Function),
    );

    view.rerender(
      <EditorContext.Provider value={{ editor }}>
        <EditorContent editor={editor} />
        <ArtifactToolbar
          editor={editor}
          className={undefined}
          scrollTarget={scrollContainer}
          commentAction={null}
          suppressBubbleMenu={false}
        />
      </EditorContext.Provider>,
    );

    await waitFor(() => {
      expect(windowRemoveEventListener).toHaveBeenCalledWith(
        "scroll",
        expect.any(Function),
      );
      expect(containerAddEventListener).toHaveBeenCalledWith(
        "scroll",
        expect.any(Function),
      );
    });

    view.rerender(
      <EditorContext.Provider value={{ editor }}>
        <EditorContent editor={editor} />
        <ArtifactToolbar
          editor={editor}
          className={undefined}
          scrollTarget={replacementScrollContainer}
          commentAction={null}
          suppressBubbleMenu={false}
        />
      </EditorContext.Provider>,
    );

    await waitFor(() => {
      expect(containerRemoveEventListener).toHaveBeenCalledWith(
        "scroll",
        expect.any(Function),
      );
      expect(replacementAddEventListener).toHaveBeenCalledWith(
        "scroll",
        expect.any(Function),
      );
    });

    coordsAtPos.mockClear();
    fireEvent.scroll(replacementScrollContainer);
    await waitFor(() => expect(coordsAtPos).toHaveBeenCalled(), {
      timeout: 500,
    });

    const activeScrollHandler = replacementAddEventListener.mock.calls.find(
      ([eventName]) => eventName === "scroll",
    )?.[1];
    expect(activeScrollHandler).toEqual(expect.any(Function));
    view.unmount();
    expect(replacementRemoveEventListener).toHaveBeenCalledWith(
      "scroll",
      activeScrollHandler,
    );

    editor.destroy();
    scrollContainer.remove();
    replacementScrollContainer.remove();
  });
});
