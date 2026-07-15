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
import { EditorContent, EditorContext, useEditor } from "@tiptap/react";
import { Profiler, useCallback, useEffect, useState } from "react";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import {
  ArtifactToolbar,
  buildArtifactExtensions,
  deriveCollabUser,
  updateArtifactToolbarPosition,
} from "@/editor-core";
import { createArtifactToolbarOptions } from "@/editor-core/toolbar/artifact-toolbar-position";

function buildToolbarFixture() {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("default");
  const awareness = new Awareness(doc);
  const user = deriveCollabUser({ userName: "T", email: "t@x.io" });
  return {
    doc,
    extensions: buildArtifactExtensions({
      doc,
      fragment,
      awareness,
      user,
      onCommentShortcut: null,
      placeholderText: "Start writing…",
      titlePlaceholderText: "Untitled",
    }),
  };
}

function buildToolbarExtensions() {
  return buildToolbarFixture().extensions;
}

function mountToolbarEditor(): Editor {
  return new Editor({ extensions: buildToolbarExtensions() });
}

function RefOwnedToolbarHarness({
  onScrollTarget,
  onEditorReady,
}: {
  readonly onScrollTarget: (element: HTMLDivElement) => void;
  readonly onEditorReady: (editor: Editor, doc: Y.Doc) => void;
}) {
  const [fixture] = useState(buildToolbarFixture);
  const editor = useEditor({
    extensions: fixture.extensions,
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
  });
  const [scrollTarget, setScrollTarget] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (editor === null) return;
    onEditorReady(editor, fixture.doc);
  }, [editor, fixture.doc, onEditorReady]);
  const setScrollContainerRef = useCallback(
    (element: HTMLDivElement | null): void => {
      if (element !== null) onScrollTarget(element);
      setScrollTarget(element);
    },
    [onScrollTarget],
  );
  const onScroll = useCallback((): void => {
    if (editor === null) return;
    updateArtifactToolbarPosition(editor);
  }, [editor]);

  return (
    <div
      ref={setScrollContainerRef}
      className="overflow-y-auto"
      onScroll={onScroll}
    >
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
      if (screen.queryByRole("toolbar", { hidden: true }) === null) {
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
  it("bounds floating middleware to the tile scroll container", () => {
    const scrollTarget = document.createElement("div");

    expect(createArtifactToolbarOptions(scrollTarget)).toEqual({
      scrollTarget,
      flip: { boundary: scrollTarget, padding: 4 },
      shift: { boundary: scrollTarget, padding: 4 },
      hide: { boundary: scrollTarget },
    });
  });

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
    const toolbar = screen.getByRole("toolbar", { hidden: true });
    const buttonLabels = within(toolbar)
      .getAllByRole("button", { hidden: true })
      .map((button) => button.getAttribute("aria-label"));
    expect(buttonLabels).toContain("Bold");
    expect(buttonLabels).toContain("Heading 1");
    expect(buttonLabels).not.toContain("Undo");
    expect(buttonLabels).not.toContain("Redo");
    expect(toolbar.style.zIndex).toBe("");
    expect(toolbar.parentElement?.style.zIndex).toBe("40");
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
        onEditorReady={() => undefined}
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

  it("repositions synchronously on scroll without a React commit", async () => {
    const editors: Editor[] = [];
    const scrollTargets: HTMLDivElement[] = [];
    const renderCommits: string[] = [];

    const view = render(
      <Profiler
        id="immediate-scroll-toolbar"
        onRender={(_id, phase) => {
          renderCommits.push(phase);
        }}
      >
        <RefOwnedToolbarHarness
          onScrollTarget={(element) => scrollTargets.push(element)}
          onEditorReady={(editor) => editors.push(editor)}
        />
      </Profiler>,
    );

    await waitFor(() => {
      expect(editors).toHaveLength(1);
      expect(scrollTargets).toHaveLength(1);
    });
    const editor = editors[0];
    const scrollTarget = scrollTargets[0];
    await revealBubbleMenu(editor);
    const coordsAtPos = vi.spyOn(editor.view, "coordsAtPos");
    coordsAtPos.mockClear();
    renderCommits.length = 0;

    fireEvent.scroll(scrollTarget);

    // No timer advance or wait: the explicit plugin meta reaches
    // updatePosition synchronously inside the existing scroll handler.
    expect(coordsAtPos).toHaveBeenCalled();
    expect(renderCommits).toHaveLength(0);
    view.unmount();
  });

  it("keeps scroll position transactions out of Yjs and undo history", async () => {
    const editors: Editor[] = [];
    const docs: Y.Doc[] = [];
    const scrollTargets: HTMLDivElement[] = [];

    const view = render(
      <RefOwnedToolbarHarness
        onScrollTarget={(element) => scrollTargets.push(element)}
        onEditorReady={(editor, doc) => {
          editors.push(editor);
          docs.push(doc);
        }}
      />,
    );

    await waitFor(() => {
      expect(editors).toHaveLength(1);
      expect(docs).toHaveLength(1);
      expect(scrollTargets).toHaveLength(1);
    });
    const editor = editors[0];
    const doc = docs[0];
    const scrollTarget = scrollTargets[0];
    await revealBubbleMenu(editor);
    const prosemirrorDocBefore = editor.state.doc;
    let yjsUpdateCount = 0;
    const countYjsUpdate = (): void => {
      yjsUpdateCount += 1;
    };
    doc.on("update", countYjsUpdate);
    expect(editor.state.selection.empty).toBe(false);
    expect(editor.can().undo()).toBe(true);

    fireEvent.scroll(scrollTarget);
    fireEvent.scroll(scrollTarget);
    fireEvent.scroll(scrollTarget);

    expect(editor.state.doc).toBe(prosemirrorDocBefore);
    expect(yjsUpdateCount).toBe(0);
    expect(editor.can().undo()).toBe(true);
    doc.off("update", countYjsUpdate);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.isEmpty).toBe(true);
    expect(editor.can().undo()).toBe(false);
    view.unmount();
  });

  it("does not dispatch a position transaction for a hidden toolbar", async () => {
    const editors: Editor[] = [];
    const scrollTargets: HTMLDivElement[] = [];

    const view = render(
      <RefOwnedToolbarHarness
        onScrollTarget={(element) => scrollTargets.push(element)}
        onEditorReady={(editor) => editors.push(editor)}
      />,
    );

    await waitFor(() => {
      expect(editors).toHaveLength(1);
      expect(scrollTargets).toHaveLength(1);
    });
    const editor = editors[0];
    const dispatch = vi.spyOn(editor.view, "dispatch");
    expect(editor.state.selection.empty).toBe(true);

    fireEvent.scroll(scrollTargets[0]);

    expect(dispatch).not.toHaveBeenCalled();
    view.unmount();
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
    const windowScrollHandler = windowAddEventListener.mock.calls
      .filter(([eventName]) => eventName === "scroll")
      .at(-1)?.[1];
    expect(windowScrollHandler).toEqual(expect.any(Function));

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
        windowScrollHandler,
      );
      expect(containerAddEventListener).toHaveBeenCalledWith(
        "scroll",
        expect.any(Function),
      );
    });
    const containerScrollHandler = containerAddEventListener.mock.calls
      .filter(([eventName]) => eventName === "scroll")
      .at(-1)?.[1];
    expect(containerScrollHandler).toEqual(expect.any(Function));

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
        containerScrollHandler,
      );
      expect(replacementAddEventListener).toHaveBeenCalledWith(
        "scroll",
        expect.any(Function),
      );
    });
    const replacementScrollHandler = replacementAddEventListener.mock.calls
      .filter(([eventName]) => eventName === "scroll")
      .at(-1)?.[1];
    expect(replacementScrollHandler).toEqual(expect.any(Function));

    coordsAtPos.mockClear();
    fireEvent.scroll(replacementScrollContainer);
    await waitFor(() => expect(coordsAtPos).toHaveBeenCalled(), {
      timeout: 500,
    });

    view.unmount();
    expect(replacementRemoveEventListener).toHaveBeenCalledWith(
      "scroll",
      replacementScrollHandler,
    );

    editor.destroy();
    scrollContainer.remove();
    replacementScrollContainer.remove();
  });
});
