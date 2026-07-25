import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { Editor, type Content } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { prosemirrorJSONToYXmlFragment } from "@tiptap/y-tiptap";
import { createMemoryHistory } from "@tanstack/react-router";
import * as floatingUi from "@floating-ui/dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { useLayoutEffect, useState } from "react";
import { artifactDocumentBundle } from "@/editor-core";
import { artifactLinkExtension } from "@/editor-core/artifact-document-bundle";
import { registerDynamicActionHandler } from "@/lib/keybindings/dispatch";
import type { KeybindingRouterSource } from "@/lib/keybindings/router-adapter";
import { KeybindingProvider } from "@/providers/keybinding-provider";
import {
  ArtifactLinkPopover,
  type OpenableArtifactLink,
} from "../artifact-link-popover";
import { ArtifactToolbar } from "../../toolbar/artifact-toolbar";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

vi.mock("@floating-ui/dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@floating-ui/dom")>();
  return { ...actual, computePosition: vi.fn(actual.computePosition) };
});

const editors: Editor[] = [];
const docs: Y.Doc[] = [];
const LINK_CONTENT = '<p><a href="https://example.com">Example</a></p>';

function trackEditor(editor: Editor): Editor {
  vi.spyOn(editor.view, "coordsAtPos").mockImplementation((position) => ({
    left: position * 10,
    right: position * 10 + 5,
    top: 10,
    bottom: 20,
  }));
  editors.push(editor);
  return editor;
}

function makeEditor(content: Content): Editor {
  return trackEditor(
    new Editor({
      extensions: [
        StarterKit.configure({ link: false }),
        artifactLinkExtension,
      ],
      content,
    }),
  );
}

function makeCollaborativeEditors(markdown: string): {
  readonly first: Editor;
  readonly second: Editor;
  readonly doc: Y.Doc;
} {
  const doc = new Y.Doc();
  docs.push(doc);
  const fragment = doc.getXmlFragment("artifact-body");
  prosemirrorJSONToYXmlFragment(
    artifactDocumentBundle.schema,
    artifactDocumentBundle.markdownManager.parse(markdown),
    fragment,
  );
  const make = () =>
    trackEditor(
      new Editor({
        extensions: [
          StarterKit.configure({ undoRedo: false, link: false }),
          artifactLinkExtension,
          Collaboration.configure({ document: doc, fragment }),
        ],
      }),
    );
  return { first: make(), second: make(), doc };
}

function renderPopover(editor: Editor, editable: boolean) {
  const openLink = vi.fn<(link: OpenableArtifactLink) => void>();
  const onOpenChange = vi.fn<(open: boolean) => void>();
  const result = render(
    <>
      <EditorContent editor={editor} />
      <ArtifactLinkPopover
        editor={editor}
        editable={editable}
        scrollContainer={null}
        openLink={openLink}
        openLinkPending={false}
        onOpenChange={onOpenChange}
      />
    </>,
  );
  return { ...result, openLink, onOpenChange };
}

function setCaretAndRender(editor: Editor, editable: boolean) {
  editor.commands.setTextSelection(2);
  return renderPopover(editor, editable);
}

function makeKeybindingRouter(): KeybindingRouterSource {
  const history = createMemoryHistory({ initialEntries: ["/"] });
  const navigate: KeybindingRouterSource["navigate"] = () => Promise.resolve();
  return {
    get state() {
      return { location: { pathname: history.location.pathname } };
    },
    history,
    navigate,
  };
}

function transformY(element: HTMLElement): number {
  const match = /translate3d\([^,]+,\s*(-?[\d.]+)px/.exec(
    element.style.transform,
  );
  if (match === null) throw new Error("Expected a translate3d transform");
  return Number(match[1]);
}

function ToolbarPopoverHarness(props: { readonly editor: Editor }) {
  const [linkOpen, setLinkOpen] = useState(false);
  return (
    <>
      <EditorContent editor={props.editor} />
      <ArtifactToolbar
        editor={props.editor}
        className={undefined}
        scrollTarget={null}
        commentAction={null}
        suppressBubbleMenu={linkOpen}
      />
      <ArtifactLinkPopover
        editor={props.editor}
        editable
        scrollContainer={null}
        openLink={() => undefined}
        openLinkPending={false}
        onOpenChange={setLinkOpen}
      />
    </>
  );
}

function KeyboardPopoverHarness(props: {
  readonly content: string;
  readonly editable: boolean;
  readonly openLink: (link: OpenableArtifactLink) => void;
  readonly onEditor: (editor: Editor) => void;
  readonly selection: { readonly from: number; readonly to: number } | null;
}) {
  const { content, editable, onEditor, openLink, selection } = props;
  const editor = useEditor({
    extensions: [StarterKit.configure({ link: false }), artifactLinkExtension],
    content,
    editable,
    immediatelyRender: false,
  });
  useLayoutEffect(() => {
    if (editor === null) return;
    onEditor(editor);
    if (selection !== null) {
      editor.commands.setTextSelection(selection);
    }
  }, [editor, onEditor, selection]);
  if (editor === null) return null;
  return (
    <>
      <EditorContent editor={editor} />
      <ArtifactLinkPopover
        editor={editor}
        editable={editable}
        scrollContainer={null}
        openLink={openLink}
        openLinkPending={false}
        onOpenChange={() => undefined}
      />
      <button type="button">Outside</button>
    </>
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  editors.splice(0).forEach((editor) => editor.destroy());
  docs.splice(0).forEach((doc) => doc.destroy());
  vi.mocked(floatingUi.computePosition).mockRestore();
  vi.restoreAllMocks();
});

describe("ArtifactLinkPopover", () => {
  it("hides the visible mounted BubbleMenu while the link card owns the selection", async () => {
    const { first } = makeCollaborativeEditors(
      "[Example](https://example.com)",
    );
    const before = first.getHTML();
    render(<ToolbarPopoverHarness editor={first} />);
    act(() => {
      first.view.focus();
      first.commands.setTextSelection({ from: 1, to: 8 });
    });
    const toolbar = await screen.findByRole("toolbar", {
      name: "Editor formatting",
      hidden: true,
    });
    const toolbarWrapper = toolbar.parentElement;
    if (toolbarWrapper === null) throw new Error("Expected toolbar wrapper");
    // JSDOM gives the selected text a zero rect, so Floating UI's hide
    // middleware marks the otherwise-live wrapper hidden. Restore the browser
    // state this regression exercises: a positioned, currently visible menu.
    toolbarWrapper.style.visibility = "visible";
    const linkButton = within(toolbar).getByRole("button", {
      name: /^Link \((?:⌘K|Ctrl\+K)\)$/,
    });

    fireEvent.mouseDown(linkButton);
    fireEvent.click(linkButton);

    await screen.findByRole("dialog", { name: "Edit link" });
    await waitFor(() => expect(toolbar.isConnected).toBe(false));
    expect(first.getHTML()).toBe(before);

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Link URL" }), {
      key: "Escape",
    });
    await waitFor(() =>
      expect(
        screen.getByRole("toolbar", {
          name: "Editor formatting",
          hidden: true,
        }),
      ).not.toBeNull(),
    );
  });

  it("opens at a collapsed caret in read state, then prefills both fields on Edit", async () => {
    const editor = makeEditor(LINK_CONTENT);
    setCaretAndRender(editor, true);

    await screen.findByRole("dialog", { name: "Link preview" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const url = await screen.findByRole<HTMLInputElement>("textbox", {
      name: "Link URL",
    });
    const displayText = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Link display text",
    });
    expect(url.value).toBe("https://example.com");
    expect(displayText.value).toBe("Example");
  });

  it("keeps the portaled card below the shared modal layer", async () => {
    const editor = makeEditor(LINK_CONTENT);
    setCaretAndRender(editor, true);
    const card = await screen.findByRole("dialog", { name: "Link preview" });

    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Modal surface</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    const overlay = document.querySelector<HTMLElement>(
      '[data-slot="dialog-overlay"]',
    );
    if (overlay === null) throw new Error("Expected dialog overlay");

    expect(card.classList.contains("z-40")).toBe(true);
    expect(overlay.classList.contains("z-50")).toBe(true);
  });

  it("commits Enter followed by blur exactly once without duplicating text", async () => {
    const editor = makeEditor(LINK_CONTENT);
    setCaretAndRender(editor, true);
    await screen.findByRole("dialog", { name: "Link preview" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const url = await screen.findByRole("textbox", { name: "Link URL" });
    const text = screen.getByRole("textbox", { name: "Link display text" });
    const documentTransaction = vi.fn();
    editor.on("transaction", ({ transaction }) => {
      if (transaction.docChanged) documentTransaction();
    });

    fireEvent.change(url, { target: { value: "https://traycer.ai" } });
    fireEvent.change(text, { target: { value: "Changed Label" } });
    fireEvent.submit(screen.getByRole("form", { name: "Edit link" }));
    fireEvent.blur(text, { relatedTarget: editor.view.dom });

    expect(documentTransaction).toHaveBeenCalledTimes(1);
    expect(editor.getText()).toBe("Changed Label");
    expect(editor.view.dom.querySelector("a")?.dataset.linkHref).toBe(
      "https://traycer.ai",
    );
    expect(screen.queryByRole("dialog", { name: "Edit link" })).toBeNull();
  });

  it("reverts Escape to the read state without committing when editing", async () => {
    const editor = makeEditor(LINK_CONTENT);
    setCaretAndRender(editor, true);
    await screen.findByRole("dialog", { name: "Link preview" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const url = await screen.findByRole("textbox", { name: "Link URL" });
    const before = editor.getHTML();
    const documentTransaction = vi.fn();
    editor.on("transaction", ({ transaction }) => {
      if (transaction.docChanged) documentTransaction();
    });

    fireEvent.change(url, { target: { value: "https://changed.example" } });
    fireEvent.keyDown(url, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Edit link" })).toBeNull();
    expect(
      await screen.findByRole("button", {
        name: "Open link: https://example.com",
      }),
    ).not.toBeNull();
    expect(editor.getHTML()).toBe(before);
    expect(documentTransaction).not.toHaveBeenCalled();
  });

  it("does not commit a discarded draft when Escape unmount blur fires after revert", async () => {
    const editor = makeEditor(LINK_CONTENT);
    setCaretAndRender(editor, true);
    await screen.findByRole("dialog", { name: "Link preview" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const url = await screen.findByRole("textbox", { name: "Link URL" });
    const form = screen.getByRole("form", { name: "Edit link" });
    const before = editor.getHTML();
    const documentTransaction = vi.fn();
    editor.on("transaction", ({ transaction }) => {
      if (transaction.docChanged) documentTransaction();
    });

    fireEvent.change(url, { target: { value: "https://changed.example" } });
    fireEvent.keyDown(url, { key: "Escape" });
    // Unmount focus cascade: the form can still emit blur after revertDraft
    // restored the read preview and cleared editing.
    fireEvent.blur(form, { relatedTarget: editor.view.dom });

    expect(editor.getHTML()).toBe(before);
    expect(documentTransaction).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("button", {
        name: "Open link: https://example.com",
      }),
    ).not.toBeNull();
  });

  it("reverts read-state Escape even when the closing focus cascade blurs the field", async () => {
    const editor = makeEditor(LINK_CONTENT);
    setCaretAndRender(editor, true);
    const preview = await screen.findByRole("dialog", {
      name: "Link preview",
    });
    const before = editor.getHTML();
    const documentTransaction = vi.fn();
    editor.on("transaction", ({ transaction }) => {
      if (transaction.docChanged) documentTransaction();
    });

    fireEvent.keyDown(preview, { key: "Escape" });
    fireEvent.blur(preview, { relatedTarget: editor.view.dom });

    expect(screen.queryByRole("dialog", { name: "Link preview" })).toBeNull();
    expect(editor.getHTML()).toBe(before);
    expect(documentTransaction).not.toHaveBeenCalled();
  });

  it("does not swallow a later caret move to the escaped link end", async () => {
    const editor = makeEditor(LINK_CONTENT);
    setCaretAndRender(editor, true);
    const preview = await screen.findByRole("dialog", {
      name: "Link preview",
    });
    await act(() => new Promise((resolve) => window.setTimeout(resolve, 0)));

    fireEvent.keyDown(preview, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Link preview" })).toBeNull(),
    );
    act(() => {
      editor.commands.setTextSelection(8);
    });

    expect(
      await screen.findByRole("dialog", { name: "Link preview" }),
    ).not.toBeNull();
  });

  it("removes the mark for an empty URL and restores empty text from the URL", async () => {
    const unlinkEditor = makeEditor(LINK_CONTENT);
    setCaretAndRender(unlinkEditor, true);
    await screen.findByRole("dialog", { name: "Link preview" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const url = await screen.findByRole("textbox", { name: "Link URL" });
    fireEvent.change(url, { target: { value: "" } });
    fireEvent.submit(screen.getByRole("form", { name: "Edit link" }));
    expect(unlinkEditor.getHTML()).toBe("<p>Example</p>");
    cleanup();

    const restoreEditor = makeEditor(LINK_CONTENT);
    setCaretAndRender(restoreEditor, true);
    await screen.findByRole("dialog", { name: "Link preview" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const displayText = await screen.findByRole("textbox", {
      name: "Link display text",
    });
    fireEvent.change(displayText, { target: { value: "" } });
    fireEvent.submit(screen.getByRole("form", { name: "Edit link" }));
    expect(restoreEditor.getText()).toBe("https://example.com");
  });

  it("unwraps with Remove and renders a compact viewer preview", async () => {
    const editor = makeEditor(LINK_CONTENT);
    setCaretAndRender(editor, true);
    await screen.findByRole("dialog", { name: "Link preview" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove link" }));
    expect(editor.getHTML()).toBe("<p>Example</p>");
    cleanup();

    const viewerEditor = makeEditor(LINK_CONTENT);
    setCaretAndRender(viewerEditor, false);
    expect(
      await screen.findByRole("dialog", { name: "Link preview" }),
    ).not.toBeNull();
    expect(screen.getByLabelText("External link")).not.toBeNull();
    expect(
      screen.getByRole("button", {
        name: "Open link: https://example.com",
      }),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "Copy link" })).not.toBeNull();
    expect(screen.queryByRole("textbox", { name: "Link URL" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove link" })).toBeNull();
  });

  it("keeps a compact hover preview open across unrelated transactions and closes when its link is deleted", async () => {
    vi.useFakeTimers();
    const editor = makeEditor(`${LINK_CONTENT}<p>Elsewhere</p>`);
    editor.commands.setTextSelection(editor.state.doc.content.size - 2);
    renderPopover(editor, true);
    await act(() => vi.advanceTimersByTimeAsync(0));
    const anchor = editor.view.dom.querySelector("a");
    if (anchor === null) throw new Error("Expected anchor");

    fireEvent.pointerOver(anchor);
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(screen.getByRole("dialog", { name: "Link preview" })).not.toBeNull();

    editor.commands.insertContentAt(editor.state.doc.content.size - 1, "!");
    expect(screen.getByRole("dialog", { name: "Link preview" })).not.toBeNull();

    act(() => {
      editor.view.dispatch(
        editor.state.tr.removeMark(1, 8, editor.schema.marks.link),
      );
    });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.queryByRole("dialog", { name: "Link preview" })).toBeNull();
  });

  function lastAnchorRect() {
    const computePosition = vi.mocked(floatingUi.computePosition);
    const call = computePosition.mock.calls.at(-1);
    if (call === undefined) throw new Error("Expected a computePosition call");
    const [anchorArg] = call;
    if (
      typeof anchorArg === "function" ||
      !("getBoundingClientRect" in anchorArg)
    ) {
      throw new Error("Expected a virtual element reference");
    }
    return anchorArg.getBoundingClientRect();
  }

  it("anchors the hover card to the document position the pointer resolves to, not the link's start", async () => {
    vi.useFakeTimers();
    const editor = makeEditor(`${LINK_CONTENT}<p>Elsewhere</p>`);
    editor.commands.setTextSelection(editor.state.doc.content.size - 2);
    renderPopover(editor, true);
    await act(() => vi.advanceTimersByTimeAsync(0));
    const anchor = editor.view.dom.querySelector("a");
    if (anchor === null) throw new Error("Expected anchor");

    // "Example" spans positions 1-8; the pointer enters mid-word, resolving
    // (via posAtCoords) to position 5 - distinct from the link's range.from
    // (1) that the pre-fix implementation always anchored to.
    vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: 5, inside: 5 });
    fireEvent.pointerOver(anchor, { clientX: 15, clientY: 140 });
    await act(() => vi.advanceTimersByTimeAsync(300));

    expect(screen.getByRole("dialog", { name: "Link preview" })).not.toBeNull();
    // trackEditor's coordsAtPos stub returns `left: position * 10`, so
    // anchoring to the resolved pointer position (5) yields left = 50.
    expect(lastAnchorRect().left).toBe(50);
  });

  it("anchors a wrapped link's hover card to the specific visual line the pointer resolves to, not a box spanning both lines", async () => {
    vi.useFakeTimers();
    const editor = makeEditor(`${LINK_CONTENT}<p>Elsewhere</p>`);
    // JSDOM has no real layout engine, so a genuine line-wrap can't be
    // rendered; this pins two divergent coordsAtPos rects for positions
    // within the SAME link the way a real wrapped line would, so the test
    // still exercises the position-resolution codepath (posAtCoords ->
    // coordsAtPos) rather than an array-matching shortcut.
    vi.spyOn(editor.view, "coordsAtPos").mockImplementation((position) => ({
      left: position < 5 ? position * 10 : (position - 5) * 10,
      right: position < 5 ? position * 10 + 5 : (position - 5) * 10 + 5,
      top: position < 5 ? 100 : 130,
      bottom: position < 5 ? 120 : 150,
    }));
    editor.commands.setTextSelection(editor.state.doc.content.size - 2);
    renderPopover(editor, true);
    await act(() => vi.advanceTimersByTimeAsync(0));
    const anchor = editor.view.dom.querySelector("a");
    if (anchor === null) throw new Error("Expected anchor");

    vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: 6, inside: 6 });
    fireEvent.pointerOver(anchor, { clientX: 15, clientY: 140 });
    await act(() => vi.advanceTimersByTimeAsync(300));

    expect(screen.getByRole("dialog", { name: "Link preview" })).not.toBeNull();
    const rect = lastAnchorRect();
    expect(rect.top).toBe(130);
    expect(rect.bottom).toBe(150);
  });

  it("keeps the hover anchor live across a scroll that happens during the show delay", async () => {
    vi.useFakeTimers();
    const editor = makeEditor(`${LINK_CONTENT}<p>Elsewhere</p>`);
    let scrollOffset = 0;
    vi.spyOn(editor.view, "coordsAtPos").mockImplementation((position) => ({
      left: position * 10,
      right: position * 10 + 5,
      top: 160 - scrollOffset,
      bottom: 170 - scrollOffset,
    }));
    editor.commands.setTextSelection(editor.state.doc.content.size - 2);
    renderPopover(editor, true);
    await act(() => vi.advanceTimersByTimeAsync(0));
    const anchor = editor.view.dom.querySelector("a");
    if (anchor === null) throw new Error("Expected anchor");

    vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: 4, inside: 4 });
    fireEvent.pointerOver(anchor, { clientX: 15, clientY: 140 });

    // The scroll happens WHILE the 300ms show delay is still pending - a
    // frozen viewport pixel point captured at pointer-over time would still
    // reflect the pre-scroll position once the card finally opens.
    scrollOffset = 30;
    fireEvent.scroll(window);
    await act(() => vi.advanceTimersByTimeAsync(300));

    expect(screen.getByRole("dialog", { name: "Link preview" })).not.toBeNull();
    expect(lastAnchorRect().top).toBe(130);
  });

  it("anchors the caret-triggered card to the caret's own position, not the link's start", async () => {
    const editor = makeEditor(`${LINK_CONTENT}<p>Elsewhere</p>`);
    // "Example" spans positions 1-8; place the caret at 4, distinct from the
    // link's range.from (1) that the pre-fix implementation always anchored
    // to regardless of the caret's actual position within the link.
    editor.commands.setTextSelection(4);
    renderPopover(editor, false);

    await screen.findByRole("dialog", { name: "Link preview" });
    // trackEditor's coordsAtPos stub returns `left: position * 10`, so
    // anchoring to the caret's own position (4) yields left = 40.
    expect(lastAnchorRect().left).toBe(40);
  });

  it("keeps a caret-opened read card following the caret within the same wrapped link, staying on the same open target", async () => {
    const editor = makeEditor(`${LINK_CONTENT}<p>Elsewhere</p>`);
    // "Example" spans positions 1-8; both 2 and 6 are inside that range, so
    // the caret move stays on the SAME target (not a re-open).
    editor.commands.setTextSelection(2);
    const { onOpenChange } = renderPopover(editor, true);

    await screen.findByRole("dialog", { name: "Link preview" });
    expect(lastAnchorRect().left).toBe(20);
    onOpenChange.mockClear();

    act(() => {
      editor.commands.setTextSelection(6);
    });

    // trackEditor's coordsAtPos stub returns `left: position * 10`, so the
    // anchor following the caret to 6 (not staying pinned at 2, the
    // pre-fix behavior) yields left = 60.
    await waitFor(() => expect(lastAnchorRect().left).toBe(60));
    // The card stayed open on the SAME target rather than being closed and
    // reopened: `onOpenChange` doesn't fire again for an in-range move.
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("remaps the caret-triggered anchor after a remote Yjs edit moves its link", async () => {
    const { first, doc } = makeCollaborativeEditors(
      "[Example](https://example.com)",
    );
    first.commands.setTextSelection(2);
    renderPopover(first, true);

    await screen.findByRole("dialog", { name: "Link preview" });
    const initialLeft = lastAnchorRect().left;
    const remoteDoc = new Y.Doc();
    docs.push(remoteDoc);
    Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(doc));
    const remoteFragment = remoteDoc.getXmlFragment("artifact-body");
    const remote = trackEditor(
      new Editor({
        extensions: [
          StarterKit.configure({ undoRedo: false, link: false }),
          artifactLinkExtension,
          Collaboration.configure({
            document: remoteDoc,
            fragment: remoteFragment,
          }),
        ],
      }),
    );

    act(() => {
      remote.commands.insertContentAt(0, "<p>Before</p>");
      Y.applyUpdate(
        doc,
        Y.encodeStateAsUpdate(remoteDoc, Y.encodeStateVector(doc)),
      );
    });

    const precedingParagraph = first.state.doc.firstChild;
    if (precedingParagraph === null) {
      throw new Error("Expected the remote edit to insert a paragraph");
    }
    await waitFor(() =>
      expect(lastAnchorRect().left).toBe(
        (precedingParagraph.nodeSize + 2) * 10,
      ),
    );
    expect(lastAnchorRect().left).not.toBe(initialLeft);
  });

  it("anchors a caret parked exactly at the link's end to the preceding side, not the following line", async () => {
    const editor = makeEditor(`${LINK_CONTENT}<p>Elsewhere</p>`);
    // "Example" spans positions 1-8, so range.to = 8 - the end-EXCLUSIVE
    // boundary. coordsAtPos's default (positive) side there reports
    // whatever follows the mark, which at a wrap boundary is the next
    // visual line; the preceding side (-1) must be requested instead.
    vi.spyOn(editor.view, "coordsAtPos").mockImplementation(
      (position, side) => ({
        left: position * 10,
        right: position * 10 + 5,
        top: position === 8 && side === -1 ? 100 : 200,
        bottom: position === 8 && side === -1 ? 120 : 220,
      }),
    );
    editor.commands.setTextSelection(4);
    renderPopover(editor, true);

    await screen.findByRole("dialog", { name: "Link preview" });
    act(() => {
      editor.commands.setTextSelection(8);
    });

    await waitFor(() => expect(lastAnchorRect().top).toBe(100));
  });

  it("promotes the compact hover preview to an autosaving editor", async () => {
    vi.useFakeTimers();
    const editor = makeEditor(`${LINK_CONTENT}<p>Elsewhere</p>`);
    editor.commands.setTextSelection(editor.state.doc.content.size - 2);
    renderPopover(editor, true);
    await act(() => vi.advanceTimersByTimeAsync(0));
    const anchor = editor.view.dom.querySelector("a");
    if (anchor === null) throw new Error("Expected anchor");

    fireEvent.pointerOver(anchor);
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(screen.getByLabelText("External link")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Copy link" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(screen.queryByRole("dialog", { name: "Link preview" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Edit link" })).not.toBeNull();
    const url = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Link URL",
    });
    expect(document.activeElement).toBe(url);
    fireEvent.change(url, { target: { value: "https://traycer.ai" } });
    fireEvent.blur(url, { relatedTarget: document.body });

    expect(editor.view.dom.querySelector("a")?.dataset.linkHref).toBe(
      "https://traycer.ai",
    );
    expect(screen.queryByRole("dialog", { name: "Edit link" })).toBeNull();
  });

  it("keeps hover ownership when Escape reverts a hover-promoted edit, so pointer leave still hides the card", async () => {
    vi.useFakeTimers();
    const editor = makeEditor(`${LINK_CONTENT}<p>Elsewhere</p>`);
    editor.commands.setTextSelection(editor.state.doc.content.size - 2);
    renderPopover(editor, true);
    await act(() => vi.advanceTimersByTimeAsync(0));
    const anchor = editor.view.dom.querySelector("a");
    if (anchor === null) throw new Error("Expected anchor");

    fireEvent.pointerOver(anchor);
    await act(() => vi.advanceTimersByTimeAsync(300));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Link URL" }), {
      key: "Escape",
    });

    const preview = screen.getByRole("dialog", { name: "Link preview" });
    fireEvent.pointerLeave(preview);
    await act(() => vi.advanceTimersByTimeAsync(100));

    expect(screen.queryByRole("dialog", { name: "Link preview" })).toBeNull();
  });

  it("hides after Escape reverts a hover-promoted edit when the pointer already left", async () => {
    vi.useFakeTimers();
    const editor = makeEditor(`${LINK_CONTENT}<p>Elsewhere</p>`);
    editor.commands.setTextSelection(editor.state.doc.content.size - 2);
    renderPopover(editor, true);
    await act(() => vi.advanceTimersByTimeAsync(0));
    const anchor = editor.view.dom.querySelector("a");
    if (anchor === null) throw new Error("Expected anchor");

    fireEvent.pointerOver(anchor);
    await act(() => vi.advanceTimersByTimeAsync(300));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editCard = screen.getByRole("dialog", { name: "Edit link" });
    fireEvent.pointerLeave(editCard);
    // Caret ownership during edit means leave does not arm hide.
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(screen.getByRole("dialog", { name: "Edit link" })).not.toBeNull();

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Link URL" }), {
      key: "Escape",
    });
    expect(screen.getByRole("dialog", { name: "Link preview" })).not.toBeNull();
    // Revert restores hover ownership and re-arms hide for the prior leave.
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(screen.queryByRole("dialog", { name: "Link preview" })).toBeNull();
  });

  it("keeps the preview open when Escape reverts while the pointer is still over the card", async () => {
    vi.useFakeTimers();
    const editor = makeEditor(`${LINK_CONTENT}<p>Elsewhere</p>`);
    editor.commands.setTextSelection(editor.state.doc.content.size - 2);
    renderPopover(editor, true);
    await act(() => vi.advanceTimersByTimeAsync(0));
    const anchor = editor.view.dom.querySelector("a");
    if (anchor === null) throw new Error("Expected anchor");

    fireEvent.pointerOver(anchor);
    await act(() => vi.advanceTimersByTimeAsync(300));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editCard = screen.getByRole("dialog", { name: "Edit link" });
    fireEvent.pointerEnter(editCard);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Link URL" }), {
      key: "Escape",
    });

    expect(screen.getByRole("dialog", { name: "Link preview" })).not.toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(screen.getByRole("dialog", { name: "Link preview" })).not.toBeNull();
  });

  it("cancels a pending hover when selection changes before the delay", async () => {
    vi.useFakeTimers();
    const editor = makeEditor(`${LINK_CONTENT}<p>Other text</p>`);
    renderPopover(editor, true);
    const anchor = editor.view.dom.querySelector("a");
    if (anchor === null) throw new Error("Expected anchor");

    fireEvent.pointerOver(anchor);
    editor.commands.setTextSelection({ from: 10, to: 14 });
    await act(() => vi.advanceTimersByTimeAsync(300));

    expect(screen.queryByRole("dialog", { name: "Edit link" })).toBeNull();
  });

  it("does not apply hover-hide to a focused create draft", async () => {
    vi.useFakeTimers();
    const editor = makeEditor("<p>Create me</p>");
    editor.commands.setTextSelection({ from: 1, to: 7 });
    renderPopover(editor, true);
    fireEvent.keyDown(editor.view.dom, { key: "k", ctrlKey: true });
    const url = screen.getByRole("textbox", { name: "Link URL" });
    fireEvent.change(url, { target: { value: "https://draft.example" } });

    fireEvent.pointerLeave(screen.getByRole("dialog", { name: "Edit link" }));
    await act(() => vi.advanceTimersByTimeAsync(100));

    expect(
      screen.getByRole<HTMLInputElement>("textbox", { name: "Link URL" }).value,
    ).toBe("https://draft.example");
    expect(editor.getHTML()).toBe("<p>Create me</p>");
  });

  it("does not reset a focused dirty draft when the pointer re-enters its link", async () => {
    vi.useFakeTimers();
    const editor = makeEditor(LINK_CONTENT);
    setCaretAndRender(editor, true);
    await act(() => vi.advanceTimersByTimeAsync(0));
    screen.getByRole("dialog", { name: "Link preview" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const url = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Link URL",
    });
    fireEvent.focus(url);
    fireEvent.change(url, { target: { value: "https://draft.example" } });
    const anchor = editor.view.dom.querySelector("a");
    if (anchor === null) throw new Error("Expected anchor");

    fireEvent.pointerOver(anchor);
    await act(() => vi.advanceTimersByTimeAsync(300));

    expect(url.value).toBe("https://draft.example");
  });

  it("reopens from a caret click after a create commit", async () => {
    const editor = makeEditor("<p>Create me</p>");
    editor.commands.setTextSelection({ from: 1, to: 7 });
    renderPopover(editor, true);
    fireEvent.keyDown(editor.view.dom, { key: "k", ctrlKey: true });
    fireEvent.change(screen.getByRole("textbox", { name: "Link URL" }), {
      target: { value: "https://example.com" },
    });

    fireEvent.submit(screen.getByRole("form", { name: "Edit link" }));

    expect(editor.view.dom.querySelector("a")?.dataset.linkHref).toBe(
      "https://example.com",
    );
    expect(screen.queryByRole("dialog", { name: "Edit link" })).toBeNull();

    editor.commands.setTextSelection(2);

    expect(
      await screen.findByRole("dialog", { name: "Link preview" }),
    ).not.toBeNull();
  });

  it("opens Cmd/Ctrl+K on a caret inside an existing link directly in edit mode", async () => {
    const editor = makeEditor(LINK_CONTENT);
    editor.commands.setTextSelection(2);
    renderPopover(editor, true);
    await screen.findByRole("dialog", { name: "Link preview" });

    fireEvent.keyDown(editor.view.dom, { key: "k", ctrlKey: true });

    const url = await screen.findByRole<HTMLInputElement>("textbox", {
      name: "Link URL",
    });
    expect(url.value).toBe("https://example.com");
    expect(document.activeElement).toBe(url);
    expect(screen.queryByRole("dialog", { name: "Link preview" })).toBeNull();

    fireEvent.keyDown(url, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Edit link" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Link preview" })).toBeNull();
  });

  it("commits once when focus leaves the whole card after visiting both fields", async () => {
    const editor = makeEditor("<p>Create me</p>");
    editor.commands.setTextSelection({ from: 1, to: 7 });
    renderPopover(editor, true);
    fireEvent.keyDown(editor.view.dom, { key: "k", ctrlKey: true });
    const url = screen.getByRole("textbox", { name: "Link URL" });
    fireEvent.change(url, { target: { value: "https://example.com" } });
    const displayText = screen.getByRole("textbox", {
      name: "Link display text",
    });

    fireEvent.blur(url, { relatedTarget: displayText });
    expect(screen.getByRole("dialog", { name: "Edit link" })).not.toBeNull();
    fireEvent.blur(displayText, { relatedTarget: document.body });

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Edit link" })).toBeNull(),
    );
    expect(editor.view.dom.querySelector("a")?.dataset.linkHref).toBe(
      "https://example.com",
    );
  });

  it("maps a collaborative insert through the live link range before commit", async () => {
    const { first, second, doc } = makeCollaborativeEditors(
      "[Example](https://example.com)",
    );
    setCaretAndRender(first, true);
    await screen.findByRole("dialog", { name: "Link preview" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const url = await screen.findByRole("textbox", { name: "Link URL" });
    const updates = vi.fn();
    doc.on("update", updates);

    second.commands.insertContentAt(4, "REMOTE");
    updates.mockClear();
    fireEvent.change(url, { target: { value: "https://traycer.ai" } });
    fireEvent.submit(screen.getByRole("form", { name: "Edit link" }));

    expect(first.getText()).toBe("ExaREMOTEmple");
    expect(first.view.dom.querySelectorAll("a")).toHaveLength(1);
    expect(first.view.dom.querySelector("a")?.dataset.linkHref).toBe(
      "https://traycer.ai",
    );
    expect(updates).toHaveBeenCalledTimes(1);
  });

  it("closes after a boundary insert follows an accepted interior edit", async () => {
    const { first, second } = makeCollaborativeEditors(
      "[Example](https://example.com)",
    );
    setCaretAndRender(first, true);
    await screen.findByRole("dialog", { name: "Link preview" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const display = await screen.findByRole<HTMLInputElement>("textbox", {
      name: "Link display text",
    });
    fireEvent.change(display, { target: { value: "LOCAL TEXT" } });

    second.commands.insertContentAt(4, "REMOTE");
    await waitFor(() => expect(first.getText()).toBe("ExaREMOTEmple"));
    expect(screen.getByRole("dialog", { name: "Edit link" })).not.toBeNull();

    second.commands.insertContentAt(14, {
      type: "text",
      text: "X",
      marks: [{ type: "link", attrs: { href: "https://example.com" } }],
    });

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Edit link" })).toBeNull(),
    );
    expect(first.getText()).toBe("ExaREMOTEmpleX");
    expect(first.getText()).not.toContain("LOCAL TEXT");
  });

  it("invalidates post-commit caret suppression on a remote document change", async () => {
    const { first, second } = makeCollaborativeEditors(
      "[Example](https://example.com)",
    );
    setCaretAndRender(first, true);
    await screen.findByRole("dialog", { name: "Link preview" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const url = await screen.findByRole("textbox", { name: "Link URL" });
    fireEvent.change(url, { target: { value: "https://traycer.ai" } });
    fireEvent.submit(screen.getByRole("form", { name: "Edit link" }));

    second.commands.insertContentAt(1, "X");
    expect(first.state.selection.from).toBe(9);
    act(() => {
      first.commands.setTextSelection(8);
    });

    expect(
      await screen.findByRole("dialog", { name: "Link preview" }),
    ).not.toBeNull();
  });

  it("closes on a remote mid-link href split instead of committing across ambiguous segments", async () => {
    const { first, second } = makeCollaborativeEditors(
      "[Example](https://example.com)",
    );
    setCaretAndRender(first, true);
    await screen.findByRole("dialog", { name: "Link preview" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const url = await screen.findByRole("textbox", { name: "Link URL" });
    fireEvent.change(url, { target: { value: "https://local.example" } });

    second
      .chain()
      .setTextSelection({ from: 4, to: 6 })
      .setLink({ href: "https://remote.example" })
      .run();

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Edit link" })).toBeNull(),
    );
    expect(first.getHTML()).not.toContain("https://local.example");
    expect(first.getHTML()).toContain("https://remote.example");
  });

  it("merges an exact-range remote href update without discarding a local text draft", async () => {
    const { first, second } = makeCollaborativeEditors(
      "[Example](https://example.com)",
    );
    setCaretAndRender(first, true);
    await screen.findByRole("dialog", { name: "Link preview" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const display = await screen.findByRole<HTMLInputElement>("textbox", {
      name: "Link display text",
    });
    fireEvent.change(display, { target: { value: "LOCAL TEXT" } });

    second
      .chain()
      .setTextSelection({ from: 1, to: 8 })
      .setLink({ href: "https://remote.example" })
      .run();

    await waitFor(() =>
      expect(
        screen.getByRole<HTMLInputElement>("textbox", { name: "Link URL" })
          .value,
      ).toBe("https://remote.example"),
    );
    expect(display.value).toBe("LOCAL TEXT");
    expect(screen.getByRole("dialog", { name: "Edit link" })).not.toBeNull();
  });

  it("closes when deleting a separator ambiguously merges adjacent same-href links", async () => {
    const { first, second } = makeCollaborativeEditors(
      "[A](https://same.example) [B](https://same.example)",
    );
    setCaretAndRender(first, true);
    await screen.findByRole("dialog", { name: "Link preview" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const url = await screen.findByRole("textbox", { name: "Link URL" });
    fireEvent.change(url, { target: { value: "https://local.example" } });

    second.commands.deleteRange({ from: 2, to: 3 });

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Edit link" })).toBeNull(),
    );
    expect(first.getText()).toBe("AB");
    expect(first.getHTML()).not.toContain("https://local.example");
  });

  it("closes when a same-href boundary insertion makes identity ambiguous", async () => {
    const { first, second } = makeCollaborativeEditors(
      "[A](https://same.example)B",
    );
    setCaretAndRender(first, true);
    await screen.findByRole("dialog", { name: "Link preview" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const url = await screen.findByRole("textbox", { name: "Link URL" });
    fireEvent.change(url, { target: { value: "https://local.example" } });

    second.commands.insertContentAt(2, {
      type: "text",
      text: "X",
      marks: [{ type: "link", attrs: { href: "https://same.example" } }],
    });

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Edit link" })).toBeNull(),
    );
    expect(first.getText()).toBe("AXB");
    expect(first.getHTML()).not.toContain("https://local.example");
  });

  it("closes gracefully when a collaborator removes the target mark", async () => {
    const { first, second } = makeCollaborativeEditors(
      "[Example](https://example.com)",
    );
    setCaretAndRender(first, true);
    await screen.findByRole("dialog", { name: "Link preview" });

    second.chain().setTextSelection({ from: 1, to: 8 }).unsetLink().run();

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Link preview" })).toBeNull(),
    );
    expect(first.getText()).toBe("Example");
  });

  it("rejects multi-textblock link creation without changing structure", () => {
    const editor = makeEditor("<p>First</p><p>Second</p>");
    const before = editor.getHTML();
    editor.commands.setTextSelection({ from: 2, to: 10 });
    renderPopover(editor, true);

    fireEvent.keyDown(editor.view.dom, { key: "k", ctrlKey: true });

    expect(screen.queryByRole("dialog", { name: "Edit link" })).toBeNull();
    expect(editor.getHTML()).toBe(before);
  });

  it("rejects link creation in a textblock that disallows link marks", () => {
    const editor = makeEditor("<pre><code>const value = 1</code></pre>");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    renderPopover(editor, true);
    const before = editor.getHTML();

    fireEvent.keyDown(editor.view.dom, { key: "k", ctrlKey: true });

    expect(screen.queryByRole("dialog", { name: "Edit link" })).toBeNull();
    expect(editor.getHTML()).toBe(before);
  });

  it("rejects link creation when an inline mark excludes links", () => {
    const editor = makeEditor("<p><code>inline</code></p>");
    editor.commands.setTextSelection({ from: 1, to: 7 });
    renderPopover(editor, true);
    const before = editor.getHTML();

    fireEvent.keyDown(editor.view.dom, { key: "k", ctrlKey: true });

    expect(screen.queryByRole("dialog", { name: "Edit link" })).toBeNull();
    expect(editor.getHTML()).toBe(before);
  });

  it("gives the artifact link shortcut priority over the global palette binding", async () => {
    const editor = makeEditor("<p>Create me</p>");
    editor.view.dom.setAttribute("data-artifact-editor", "");
    editor.commands.setTextSelection({ from: 1, to: 7 });
    const openPalette = vi.fn();
    const unregisterPalette = registerDynamicActionHandler(
      "app.palette.open",
      openPalette,
    );
    try {
      render(
        <KeybindingProvider router={makeKeybindingRouter()}>
          <EditorContent editor={editor} />
          <ArtifactLinkPopover
            editor={editor}
            editable
            scrollContainer={null}
            openLink={() => undefined}
            openLinkPending={false}
            onOpenChange={() => undefined}
          />
        </KeybindingProvider>,
      );

      fireEvent.keyDown(editor.view.dom, { key: "k", ctrlKey: true });

      expect(openPalette).not.toHaveBeenCalled();
      expect(
        await screen.findByRole("dialog", { name: "Edit link" }),
      ).not.toBeNull();
    } finally {
      unregisterPalette();
    }
  });

  it("preserves title metadata and emits no transaction for a no-op blur", async () => {
    const editor = makeEditor(
      '<p><a href="https://example.com" title="Tooltip">Docs</a></p>',
    );
    setCaretAndRender(editor, true);
    await screen.findByRole("dialog", { name: "Link preview" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const url = await screen.findByRole("textbox", { name: "Link URL" });
    const documentTransaction = vi.fn();
    editor.on("transaction", ({ transaction }) => {
      if (transaction.docChanged) documentTransaction();
    });

    fireEvent.blur(url, { relatedTarget: document.body });

    expect(documentTransaction).not.toHaveBeenCalled();
    expect(editor.getHTML()).toContain('title="Tooltip"');
  });

  it("offers link creation from the BubbleMenu with a platform-aware label", async () => {
    const editor = makeEditor("<p>Create me</p>");
    render(
      <>
        <EditorContent editor={editor} />
        <ArtifactToolbar
          editor={editor}
          className={undefined}
          scrollTarget={null}
          commentAction={null}
          suppressBubbleMenu={false}
        />
      </>,
    );
    editor.commands.setTextSelection({ from: 1, to: 7 });

    expect(
      await screen.findByRole("button", { name: /^Link \((?:⌘K|Ctrl\+K)\)$/ }),
    ).not.toBeNull();
  });

  it("disables the BubbleMenu link control for a cross-block linked selection", async () => {
    const editor = makeEditor({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "A",
              marks: [{ type: "link", attrs: { href: "https://one.test" } }],
            },
          ],
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "B",
              marks: [{ type: "link", attrs: { href: "https://two.test" } }],
            },
          ],
        },
      ],
    });
    render(
      <>
        <EditorContent editor={editor} />
        <ArtifactToolbar
          editor={editor}
          className={undefined}
          scrollTarget={null}
          commentAction={null}
          suppressBubbleMenu={false}
        />
      </>,
    );
    editor.commands.setTextSelection({ from: 1, to: 5 });

    expect(
      (
        await screen.findByRole<HTMLButtonElement>("button", {
          name: /^Link \(/,
        })
      ).disabled,
    ).toBe(true);
  });

  it("shows link-kind indicators and disables pending external opening", async () => {
    const hashEditor = makeEditor({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Section",
              marks: [{ type: "link", attrs: { href: "#section" } }],
            },
          ],
        },
      ],
    });
    setCaretAndRender(hashEditor, false);
    await screen.findByRole("dialog", { name: "Link preview" });
    expect(screen.getByLabelText("Section link")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Open link:/ })).toBeNull();
    cleanup();

    const internalEditor = makeEditor({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Source",
              marks: [{ type: "link", attrs: { href: "src/app.tsx:4" } }],
            },
          ],
        },
      ],
    });
    setCaretAndRender(internalEditor, false);
    await screen.findByRole("dialog", { name: "Link preview" });
    expect(screen.getByLabelText("Internal file link")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Open link: src/app.tsx:4" }),
    ).not.toBeNull();
    cleanup();

    const ignoredEditor = makeEditor({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Custom",
              marks: [{ type: "link", attrs: { href: "custom:target" } }],
            },
          ],
        },
      ],
    });
    setCaretAndRender(ignoredEditor, false);
    await screen.findByRole("dialog", { name: "Link preview" });
    expect(screen.getByLabelText("Link")).not.toBeNull();
    expect(screen.getByText("custom:target")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Open link:/ })).toBeNull();
    cleanup();

    const pendingEditor = makeEditor(LINK_CONTENT);
    pendingEditor.commands.setTextSelection(2);
    const openLink = vi.fn<(link: OpenableArtifactLink) => void>();
    render(
      <>
        <EditorContent editor={pendingEditor} />
        <ArtifactLinkPopover
          editor={pendingEditor}
          editable={false}
          scrollContainer={null}
          openLink={openLink}
          openLinkPending
          onOpenChange={() => undefined}
        />
      </>,
    );

    const open = await screen.findByRole<HTMLButtonElement>("button", {
      name: "Open link: https://example.com",
    });
    expect(open.disabled).toBe(true);
    expect(screen.getByTestId("artifact-link-open-pending")).not.toBeNull();
    fireEvent.click(open);
    expect(openLink).not.toHaveBeenCalled();
  });

  it("tracks the mapped anchor one-for-one on ordinary scroll", async () => {
    const editor = makeEditor(LINK_CONTENT);
    let scrollOffset = 0;
    vi.spyOn(editor.view, "coordsAtPos").mockImplementation((position) => ({
      left: position * 10,
      right: position * 10 + 5,
      top: 160 - scrollOffset,
      bottom: 170 - scrollOffset,
    }));
    setCaretAndRender(editor, true);
    const card = await screen.findByRole("dialog", { name: "Link preview" });
    await waitFor(() => expect(card.style.transform).toContain("translate3d"));
    const before = transformY(card);

    scrollOffset = 30;
    fireEvent.scroll(window);

    await waitFor(() => expect(transformY(card)).toBe(before - 30));
  });

  it("bounds positioning to the tile scroller and hides a clipped reference", async () => {
    const boundary = document.createElement("div");
    document.body.append(boundary);
    const computePosition = vi.mocked(floatingUi.computePosition);
    computePosition.mockResolvedValue({
      x: 10,
      y: 20,
      placement: "top-start",
      strategy: "fixed",
      middlewareData: { hide: { referenceHidden: true } },
    });
    const editor = makeEditor(LINK_CONTENT);
    editor.commands.setTextSelection(2);
    render(
      <>
        <EditorContent editor={editor} />
        <ArtifactLinkPopover
          editor={editor}
          editable
          scrollContainer={boundary}
          openLink={() => undefined}
          openLinkPending={false}
          onOpenChange={() => undefined}
        />
      </>,
    );

    const card = await screen.findByRole("dialog", { name: "Link preview" });
    await waitFor(() => expect(card.style.visibility).toBe("hidden"));
    const options = computePosition.mock.calls.at(-1)?.[2];
    const findMiddleware = (name: string) =>
      options?.middleware?.find(
        (candidate) =>
          typeof candidate === "object" &&
          candidate !== null &&
          candidate.name === name,
      );
    expect(findMiddleware("flip")).toMatchObject({
      name: "flip",
      options: { boundary },
    });
    expect(findMiddleware("shift")).toMatchObject({
      name: "shift",
      options: { boundary },
    });
    expect(findMiddleware("hide")).toMatchObject({
      name: "hide",
      options: { boundary },
    });
    boundary.remove();
  });

  it("ignores stale positioning work after unmount and editor teardown", async () => {
    const editor = makeEditor(LINK_CONTENT);
    const rejections: unknown[] = [];
    const handleRejection = (event: PromiseRejectionEvent): void => {
      rejections.push(event.reason);
      event.preventDefault();
    };
    window.addEventListener("unhandledrejection", handleRejection);
    const rendered = setCaretAndRender(editor, true);
    await screen.findByRole("dialog", { name: "Link preview" });

    rendered.unmount();
    editor.destroy();
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    window.removeEventListener("unhandledrejection", handleRejection);

    expect(rejections).toEqual([]);
  });

  it("clears an open target when the editor instance changes", async () => {
    const first = makeEditor(LINK_CONTENT);
    const second = makeEditor("<p>Replacement editor</p>");
    first.commands.setTextSelection(2);
    const { openLink, onOpenChange, rerender } = renderPopover(first, true);
    await screen.findByRole("dialog", { name: "Link preview" });

    rerender(
      <>
        <EditorContent editor={second} />
        <ArtifactLinkPopover
          editor={second}
          editable
          scrollContainer={null}
          openLink={openLink}
          openLinkPending={false}
          onOpenChange={onOpenChange}
        />
      </>,
    );

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Edit link" })).toBeNull(),
    );
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("captures the full modifier and middle-click sequences before ProseMirror/native routing", () => {
    const editor = makeEditor(LINK_CONTENT);
    editor.commands.setTextSelection(2);
    const { openLink, rerender } = renderPopover(editor, true);
    const anchor = editor.view.dom.querySelector("a");
    if (anchor === null) throw new Error("Expected anchor");

    const before = editor.state.selection.from;
    expect(anchor.hasAttribute("href")).toBe(false);
    expect(fireEvent.mouseDown(anchor, { metaKey: true, button: 0 })).toBe(
      false,
    );
    fireEvent.mouseUp(anchor, { metaKey: true, button: 0 });
    fireEvent.click(anchor, { metaKey: true });
    expect(editor.state.selection.from).toBe(before);
    expect(openLink).toHaveBeenCalledWith({
      kind: "external",
      url: "https://example.com",
    });

    rerender(
      <>
        <EditorContent editor={editor} />
        <ArtifactLinkPopover
          editor={editor}
          editable={false}
          scrollContainer={null}
          openLink={openLink}
          openLinkPending={false}
          onOpenChange={() => undefined}
        />
      </>,
    );
    expect(fireEvent.mouseDown(anchor, { button: 1 })).toBe(false);
    expect(anchor.hasAttribute("href")).toBe(false);
    fireEvent.mouseUp(anchor, { button: 1 });
    anchor.dispatchEvent(
      new MouseEvent("auxclick", {
        bubbles: true,
        cancelable: true,
        button: 1,
      }),
    );
    expect(openLink).toHaveBeenCalledTimes(2);
    expect(anchor.hasAttribute("href")).toBe(false);
  });

  it("navigates a plain editable click on an external link without moving the caret or opening the card", () => {
    const editor = makeEditor(LINK_CONTENT);
    editor.commands.setTextSelection(2);
    const { openLink } = renderPopover(editor, true);
    const anchor = editor.view.dom.querySelector("a");
    if (anchor === null) throw new Error("Expected anchor");

    const before = editor.state.selection.from;
    expect(fireEvent.mouseDown(anchor, { button: 0 })).toBe(false);
    fireEvent.mouseUp(anchor, { button: 0 });
    fireEvent.click(anchor);

    expect(editor.state.selection.from).toBe(before);
    expect(openLink).toHaveBeenCalledTimes(1);
    expect(openLink).toHaveBeenCalledWith({
      kind: "external",
      url: "https://example.com",
    });
    expect(screen.queryByRole("dialog", { name: "Link preview" })).toBeNull();
  });

  it("lets Shift+click extend selection on an editable link instead of navigating", () => {
    const editor = makeEditor(LINK_CONTENT);
    editor.commands.setTextSelection(1);
    const { openLink } = renderPopover(editor, true);
    const anchor = editor.view.dom.querySelector("a");
    if (anchor === null) throw new Error("Expected anchor");

    expect(fireEvent.mouseDown(anchor, { button: 0, shiftKey: true })).toBe(
      true,
    );
    fireEvent.mouseUp(anchor, { button: 0, shiftKey: true });
    fireEvent.click(anchor, { shiftKey: true });

    expect(openLink).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Link preview" })).toBeNull();
  });

  it("cancels a pending hover-show when a plain click navigates the link first", async () => {
    vi.useFakeTimers();
    const editor = makeEditor(`${LINK_CONTENT}<p>Elsewhere</p>`);
    editor.commands.setTextSelection(editor.state.doc.content.size - 2);
    const { openLink } = renderPopover(editor, true);
    await act(() => vi.advanceTimersByTimeAsync(0));
    const anchor = editor.view.dom.querySelector("a");
    if (anchor === null) throw new Error("Expected anchor");

    fireEvent.pointerOver(anchor);
    await act(() => vi.advanceTimersByTimeAsync(100));
    fireEvent.mouseDown(anchor, { button: 0 });
    fireEvent.mouseUp(anchor, { button: 0 });
    fireEvent.click(anchor);
    expect(openLink).toHaveBeenCalledTimes(1);

    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(screen.queryByRole("dialog", { name: "Link preview" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Edit link" })).toBeNull();
  });

  it("closes an open card when a plain click navigates a different editable link", async () => {
    vi.useFakeTimers();
    const editor = makeEditor(
      '<p><a href="https://example.com">Example</a> <a href="https://traycer.ai">Traycer</a></p>',
    );
    editor.commands.setTextSelection(editor.state.doc.content.size - 2);
    const { openLink, onOpenChange } = renderPopover(editor, true);
    await act(() => vi.advanceTimersByTimeAsync(0));
    const anchors = editor.view.dom.querySelectorAll("a");
    if (anchors.length < 2) throw new Error("Expected two anchors");
    const [first, second] = anchors;

    fireEvent.pointerOver(first);
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(screen.getByRole("dialog", { name: "Link preview" })).not.toBeNull();
    onOpenChange.mockClear();

    fireEvent.mouseDown(second, { button: 0 });
    fireEvent.mouseUp(second, { button: 0 });
    fireEvent.click(second);

    expect(openLink).toHaveBeenCalledTimes(1);
    expect(openLink).toHaveBeenCalledWith({
      kind: "external",
      url: "https://traycer.ai",
    });
    expect(screen.queryByRole("dialog", { name: "Link preview" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Edit link" })).toBeNull();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("commits a dirty edit before a plain click navigates a different link", async () => {
    const editor = makeEditor(
      '<p><a href="https://example.com">Example</a> <a href="https://traycer.ai">Traycer</a></p>',
    );
    editor.commands.setTextSelection(2);
    const { openLink } = renderPopover(editor, true);
    await screen.findByRole("dialog", { name: "Link preview" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const url = await screen.findByRole("textbox", { name: "Link URL" });
    fireEvent.change(url, { target: { value: "https://changed.example" } });

    const anchors = editor.view.dom.querySelectorAll("a");
    if (anchors.length < 2) throw new Error("Expected two anchors");
    const second = anchors[1];

    fireEvent.mouseDown(second, { button: 0 });
    fireEvent.mouseUp(second, { button: 0 });
    fireEvent.click(second);

    expect(openLink).toHaveBeenCalledWith({
      kind: "external",
      url: "https://traycer.ai",
    });
    expect(editor.view.dom.querySelector("a")?.dataset.linkHref).toBe(
      "https://changed.example",
    );
    expect(screen.queryByRole("dialog", { name: "Edit link" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Link preview" })).toBeNull();
  });

  it("navigates a plain editable click on a file link", () => {
    const editor = makeEditor({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Source",
              marks: [
                {
                  type: "link",
                  attrs: { href: "file:///repo/src/app.ts:12:3" },
                },
              ],
            },
          ],
        },
      ],
    });
    const { openLink } = renderPopover(editor, true);
    const anchor = editor.view.dom.querySelector("a");
    if (anchor === null) throw new Error("Expected anchor");

    fireEvent.mouseDown(anchor, { button: 0 });
    fireEvent.mouseUp(anchor, { button: 0 });
    fireEvent.click(anchor);

    expect(openLink).toHaveBeenCalledWith({
      kind: "file",
      path: "/repo/src/app.ts",
      line: 12,
      col: 3,
    });
    expect(screen.queryByRole("dialog", { name: "Link preview" })).toBeNull();
  });

  it("routes viewer Enter through the raw external mark without mutating the document", async () => {
    const openLink = vi.fn<(link: OpenableArtifactLink) => void>();
    const onEditor = vi.fn<(editor: Editor) => void>();
    render(
      <KeyboardPopoverHarness
        content='<p>Plain</p><p><a href="https://example.com">Example</a></p>'
        editable={false}
        openLink={openLink}
        onEditor={onEditor}
        selection={null}
      />,
    );
    const anchor = screen.getByRole("link", { name: "Example" });
    const editor = onEditor.mock.calls[0][0];
    const before = editor.getText();
    expect(anchor.getAttribute("tabindex")).toBe("0");
    expect(anchor.hasAttribute("href")).toBe(false);

    expect(fireEvent.keyDown(anchor, { key: "Enter" })).toBe(false);
    expect(openLink).toHaveBeenCalledWith({
      kind: "external",
      url: "https://example.com",
    });
    expect(editor.getText()).toBe(before);
    fireEvent.keyDown(anchor, { key: " " });
    expect(openLink).toHaveBeenCalledTimes(1);

    fireEvent.focus(anchor);
    expect(
      await screen.findByRole("dialog", { name: "Link preview" }),
    ).not.toBeNull();
  });

  it("leaves viewer hash Enter native and does not mutate the document", () => {
    const openLink = vi.fn<(link: OpenableArtifactLink) => void>();
    const onEditor = vi.fn<(editor: Editor) => void>();
    render(
      <KeyboardPopoverHarness
        content='<p>Before <a href="#section">Section</a> after</p>'
        editable={false}
        openLink={openLink}
        onEditor={onEditor}
        selection={null}
      />,
    );
    const anchor = screen.getByRole("link", { name: "Section" });
    const editor = onEditor.mock.calls[0][0];
    const before = editor.getHTML();

    expect(anchor.getAttribute("tabindex")).toBe("0");
    expect(anchor.getAttribute("href")).toBe("#section");
    expect(fireEvent.keyDown(anchor, { key: "Enter" })).toBe(true);
    expect(openLink).not.toHaveBeenCalled();
    expect(editor.getHTML()).toBe(before);
  });

  it("uses caret ownership for editable links and leaves caret Enter to ProseMirror", async () => {
    const openLink = vi.fn<(link: OpenableArtifactLink) => void>();
    const onEditor = vi.fn<(editor: Editor) => void>();
    render(
      <KeyboardPopoverHarness
        content='<p>Before <a href="#section">Section</a> after</p>'
        editable
        openLink={openLink}
        onEditor={onEditor}
        selection={{ from: 10, to: 10 }}
      />,
    );
    const anchor = screen.getByRole("link", { name: "Section" });
    const editor = onEditor.mock.calls[0][0];

    expect(anchor.hasAttribute("tabindex")).toBe(false);
    expect(anchor.hasAttribute("href")).toBe(false);
    await screen.findByRole("dialog", { name: "Link preview" });

    expect(fireEvent.keyDown(editor.view.dom, { key: "Enter" })).toBe(false);
    expect(editor.view.dom.querySelectorAll("p")).toHaveLength(2);
    expect(openLink).not.toHaveBeenCalled();
  });

  it("keeps the BubbleMenu focus owner because editable links are not tabbable", async () => {
    const editor = makeEditor(LINK_CONTENT);
    render(<ToolbarPopoverHarness editor={editor} />);
    act(() => {
      editor.view.focus();
      editor.commands.setTextSelection({ from: 1, to: 4 });
    });
    const linkButton = await screen.findByRole("button", { name: /^Link \(/ });
    const anchor = editor.view.dom.querySelector("a");
    if (anchor === null) throw new Error("Expected anchor");

    expect(anchor.hasAttribute("tabindex")).toBe(false);
    act(() => anchor.focus());
    expect(document.activeElement).not.toBe(anchor);
    expect(linkButton.isConnected).toBe(true);
  });

  it("only rescans link interaction attributes while editability is transitioning", () => {
    const alignedEditor = makeEditor(LINK_CONTENT);
    const alignedQuery = vi.spyOn(alignedEditor.view.dom, "querySelectorAll");
    renderPopover(alignedEditor, true);
    const alignedLayoutCalls = alignedQuery.mock.calls.length;

    act(() => {
      alignedEditor.commands.setTextSelection(2);
    });
    expect(alignedQuery).toHaveBeenCalledTimes(alignedLayoutCalls);
    cleanup();

    const transitioningEditor = makeEditor(LINK_CONTENT);
    const transitioningQuery = vi.spyOn(
      transitioningEditor.view.dom,
      "querySelectorAll",
    );
    renderPopover(transitioningEditor, false);
    const transitioningLayoutCalls = transitioningQuery.mock.calls.length;

    act(() => {
      transitioningEditor.commands.setTextSelection(2);
    });
    expect(transitioningQuery.mock.calls.length).toBeGreaterThan(
      transitioningLayoutCalls,
    );
  });

  it("gives non-collapsed selections keyboard priority and closes after focus leaves a viewer link", async () => {
    const openLink = vi.fn<(link: OpenableArtifactLink) => void>();
    const onEditor = vi.fn<(editor: Editor) => void>();
    const rendered = render(
      <KeyboardPopoverHarness
        content='<p>Plain</p><p><a href="https://example.com">Example</a></p>'
        editable={false}
        openLink={openLink}
        onEditor={onEditor}
        selection={{ from: 1, to: 3 }}
      />,
    );
    const anchor = screen.getByRole("link", { name: "Example" });

    act(() => anchor.focus());
    expect(screen.queryByRole("dialog", { name: "Link preview" })).toBeNull();

    rendered.unmount();
    render(
      <KeyboardPopoverHarness
        content='<p>Plain</p><p><a href="https://example.com">Example</a></p>'
        editable={false}
        openLink={openLink}
        onEditor={onEditor}
        selection={null}
      />,
    );
    const viewerAnchor = screen.getByRole("link", { name: "Example" });
    act(() => viewerAnchor.focus());
    await screen.findByRole("dialog", { name: "Link preview" });

    act(() => screen.getByRole("button", { name: "Outside" }).focus());
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Link preview" })).toBeNull(),
    );
  });

  it("closes a viewer popover when focus moves to a link outside its editor", async () => {
    const openLink = vi.fn<(link: OpenableArtifactLink) => void>();
    const onEditor = vi.fn<(editor: Editor) => void>();
    render(
      <>
        <KeyboardPopoverHarness
          content='<p><a href="https://example.com">Example</a></p>'
          editable={false}
          openLink={openLink}
          onEditor={onEditor}
          selection={null}
        />
        <a href="https://outside.example">Outside link</a>
      </>,
    );
    const editorLink = screen.getByRole("link", { name: "Example" });
    act(() => editorLink.focus());
    await screen.findByRole("dialog", { name: "Link preview" });

    act(() => screen.getByRole("link", { name: "Outside link" }).focus());

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Link preview" })).toBeNull(),
    );
  });

  it("classifies raw rendered marks for hashes, file URLs, and javascript", () => {
    const makeLinkedEditor = (href: string) =>
      makeEditor({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "Target",
                marks: [{ type: "link", attrs: { href } }],
              },
            ],
          },
        ],
      });

    const hashEditor = makeLinkedEditor("#section");
    const hash = renderPopover(hashEditor, false);
    const hashAnchor = hashEditor.view.dom.querySelector("a");
    if (hashAnchor === null) throw new Error("Expected hash anchor");
    expect(fireEvent.click(hashAnchor)).toBe(true);
    expect(hash.openLink).not.toHaveBeenCalled();
    cleanup();

    const editorHashEditor = makeLinkedEditor("#editor-section");
    const editorHash = renderPopover(editorHashEditor, true);
    const editorHashAnchor = editorHashEditor.view.dom.querySelector("a");
    if (editorHashAnchor === null)
      throw new Error("Expected editor hash anchor");
    window.location.hash = "";
    // A plain click on an editable hash link stays inert (no navigation
    // target) and is left unprevented so ProseMirror still places the caret.
    expect(fireEvent.mouseDown(editorHashAnchor, { button: 0 })).toBe(true);
    fireEvent.mouseUp(editorHashAnchor, { button: 0 });
    expect(fireEvent.click(editorHashAnchor)).toBe(true);
    expect(window.location.hash).toBe("");
    expect(editorHash.openLink).not.toHaveBeenCalled();
    editorHashEditor.commands.setTextSelection(2);
    const beforeSelection = editorHashEditor.state.selection.from;
    const beforeDocument = editorHashEditor.getHTML();
    expect(
      fireEvent.mouseDown(editorHashAnchor, { metaKey: true, button: 0 }),
    ).toBe(false);
    fireEvent.mouseUp(editorHashAnchor, { metaKey: true, button: 0 });
    expect(fireEvent.click(editorHashAnchor, { metaKey: true })).toBe(false);
    expect(window.location.hash).toBe("");
    expect(editorHashEditor.state.selection.from).toBe(beforeSelection);
    expect(editorHashEditor.getHTML()).toBe(beforeDocument);
    expect(editorHash.openLink).not.toHaveBeenCalled();
    window.location.hash = "";
    cleanup();

    const spacedHashEditor = makeLinkedEditor(" #trimmed-section");
    renderPopover(spacedHashEditor, false);
    expect(
      spacedHashEditor.view.dom.querySelector("a")?.getAttribute("href"),
    ).toBe("#trimmed-section");
    cleanup();

    const fileEditor = makeLinkedEditor("file:///repo/src/app.ts:12:3");
    const file = renderPopover(fileEditor, false);
    const fileAnchor = fileEditor.view.dom.querySelector("a");
    if (fileAnchor === null) throw new Error("Expected file anchor");
    expect(fileAnchor.getAttribute("href")).toBeNull();
    expect(fireEvent.click(fileAnchor)).toBe(false);
    expect(file.openLink).toHaveBeenCalledWith({
      kind: "file",
      path: "/repo/src/app.ts",
      line: 12,
      col: 3,
    });
    cleanup();

    const unsafeEditor = makeLinkedEditor("javascript:alert(1)");
    const unsafe = renderPopover(unsafeEditor, false);
    const unsafeAnchor = unsafeEditor.view.dom.querySelector("a");
    if (unsafeAnchor === null) throw new Error("Expected unsafe anchor");
    expect(unsafeAnchor.getAttribute("href")).toBeNull();
    expect(fireEvent.click(unsafeAnchor)).toBe(false);
    expect(unsafe.openLink).not.toHaveBeenCalled();
  });
});
