import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { ArtifactFindExtension, getArtifactFindState } from "@/editor-core";
import type { TileKindId } from "@/stores/epics/canvas/tile-kinds";
import {
  useTileFindStore,
  type TileFindAdapter,
  type TileFindReplace,
} from "@/stores/tile-find";
import { createArtifactEditorFindAdapter } from "../artifact-editor-find-adapter";

const editors: Editor[] = [];

function requireReplace(adapter: TileFindAdapter): TileFindReplace {
  if (adapter.replace === null) {
    throw new Error("Expected a replace-capable artifact editor adapter.");
  }
  return adapter.replace;
}

function makeEditor(content: string, editable: boolean): Editor {
  const editor = new Editor({
    extensions: [StarterKit, ArtifactFindExtension],
    content,
    editable,
  });
  editors.push(editor);
  return editor;
}

function makeAdapter(
  editor: Editor,
  tileKind: TileKindId,
  tileInstanceId: string,
) {
  return createArtifactEditorFindAdapter({
    editor,
    tileInstanceId,
    tileKind,
    activeUnitId: `${tileInstanceId}-artifact`,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  editors.splice(0).forEach((editor) => editor.destroy());
  useTileFindStore.getState().resetForTests();
});

describe("createArtifactEditorFindAdapter", () => {
  it("exposes find-only capabilities for read-only editors and replace for editable editors", () => {
    const readOnly = makeAdapter(
      makeEditor("<p>alpha</p>", false),
      "spec",
      "spec-readonly",
    );
    expect([...readOnly.getSnapshot().capabilities]).toEqual(["find"]);
    // The replace boundary must agree with capabilities: a read-only artifact
    // exposes no replace surface, so the store refuses replace structurally.
    expect(readOnly.replace).toBeNull();

    const editable = makeAdapter(
      makeEditor("<p>alpha</p>", true),
      "spec",
      "spec-editable",
    );
    expect([...editable.getSnapshot().capabilities]).toEqual([
      "find",
      "replace",
      "replaceAll",
    ]);
    expect(editable.replace).not.toBeNull();
  });

  it("tracks editability changes on the live replace boundary", () => {
    const editor = makeEditor("<p>alpha</p>", true);
    const adapter = makeAdapter(editor, "spec", "spec-toggle");
    expect(adapter.replace).not.toBeNull();

    editor.setEditable(false);
    expect(adapter.replace).toBeNull();

    editor.setEditable(true);
    expect(adapter.replace).not.toBeNull();
  });

  it("refuses read-only artifact replace through the store without mutating request state", () => {
    const editor = makeEditor("<p>alpha beta</p>", false);
    const adapter = makeAdapter(editor, "spec", "readonly-store");
    useTileFindStore.getState().registerTarget({
      tileInstanceId: adapter.tileInstanceId,
      contentId: "readonly-content",
      viewTabId: "view-1",
      tileId: "readonly-tile",
      epicId: "epic-1",
      tileKind: adapter.tileKind,
      isEligible: true,
      adapter,
    });
    useTileFindStore.getState().setQuery(adapter.tileInstanceId, "alpha");
    const before =
      useTileFindStore.getState().uiByTileInstanceId[adapter.tileInstanceId];

    expect(adapter.replace).toBeNull();
    useTileFindStore.getState().replaceCurrent(adapter.tileInstanceId);
    useTileFindStore.getState().replaceAll(adapter.tileInstanceId);

    const after =
      useTileFindStore.getState().uiByTileInstanceId[adapter.tileInstanceId];
    expect(after?.currentRequestId).toBe(before?.currentRequestId);
    expect(after?.lastSnapshot.status).toBe(before?.lastSnapshot.status);
    expect(editor.getText()).toBe("alpha beta");
  });

  it.each(["spec", "ticket", "story", "review"] as const)(
    "uses the same artifact adapter path for %s tiles",
    (tileKind) => {
      const adapter = makeAdapter(
        makeEditor("<p>shared artifact body</p>", true),
        tileKind,
        `${tileKind}-tile`,
      );

      void adapter.search({
        requestId: 1,
        query: "artifact",
        matchCase: false,
      });

      const snapshot = adapter.getSnapshot();
      expect(adapter.tileKind).toBe(tileKind);
      expect(snapshot.total).toBe(1);
      expect(snapshot.activeUnitId).toBe(`${tileKind}-tile-artifact`);
      expect(snapshot.exactHighlight).toBe("painted");
    },
  );

  it("scrolls the current artifact match after search", () => {
    const frames = installAnimationFrameQueue();
    const scrollIntoView = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);
    const editor = makeEditor("<p>alpha beta alpha</p>", true);
    const adapter = makeAdapter(editor, "spec", "search-scroll");

    void adapter.search({ requestId: 1, query: "beta", matchCase: false });

    expect(scrollIntoView).not.toHaveBeenCalled();
    frames.runNextFrame();

    const current = editor.view.dom.querySelector<HTMLElement>(
      "[data-artifact-find-current]",
    );
    expect(current?.textContent).toBe("beta");
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "center",
      inline: "nearest",
    });
  });

  it("keeps selection unchanged while next and previous mark and scroll the current match", () => {
    const frames = installAnimationFrameQueue();
    const scrollIntoView = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);
    const editor = makeEditor("<p>alpha beta alpha beta</p>", true);
    const adapter = makeAdapter(editor, "ticket", "navigation-scroll");

    void adapter.search({ requestId: 1, query: "alpha", matchCase: false });
    frames.runNextFrame();
    expect(editor.commands.setTextSelection(7)).toBe(true);
    const selectionBefore = JSON.stringify(editor.state.selection.toJSON());
    scrollIntoView.mockClear();

    void adapter.next();
    expect(getArtifactFindState(editor).currentIndex).toBe(1);
    expect(JSON.stringify(editor.state.selection.toJSON())).toEqual(
      selectionBefore,
    );
    expectCurrentElementToBeMatch(editor, 1);
    frames.runNextFrame();
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "center",
      inline: "nearest",
    });

    scrollIntoView.mockClear();
    void adapter.previous();
    expect(getArtifactFindState(editor).currentIndex).toBe(0);
    expect(JSON.stringify(editor.state.selection.toJSON())).toEqual(
      selectionBefore,
    );
    expectCurrentElementToBeMatch(editor, 0);
    frames.runNextFrame();
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "center",
      inline: "nearest",
    });
  });

  it("retries current match scrolling when the decoration is not rendered on the first frame", () => {
    const frames = installAnimationFrameQueue();
    const scrollIntoView = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);
    const editor = makeEditor("<p>alpha beta alpha</p>", true);
    const adapter = makeAdapter(editor, "review", "scroll-retry");
    void adapter.search({ requestId: 1, query: "alpha", matchCase: false });
    frames.runNextFrame();
    scrollIntoView.mockClear();
    // Return null on the first lookup (decoration not yet rendered) to exercise
    // the retry; vi.spyOn calls through to the real querySelector afterwards.
    vi.spyOn(editor.view.dom, "querySelector").mockImplementationOnce(
      () => null,
    );

    void adapter.next();
    frames.runNextFrame();
    expect(scrollIntoView).not.toHaveBeenCalled();

    frames.runNextFrame();
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "center",
      inline: "nearest",
    });
  });

  it("recomputes highlights without scrolling on passive document changes, but still scrolls on explicit navigation", () => {
    vi.useFakeTimers();
    const frames = installAnimationFrameQueue();
    const scrollIntoView = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);
    const editor = makeEditor("<p>alpha beta alpha beta</p>", true);
    const adapter = makeAdapter(editor, "spec", "rescan-scroll-guard");
    // The doc-change rescan path only runs while the editor listener is
    // attached, which happens on subscribe.
    const unsubscribe = adapter.subscribe(() => undefined);

    // Explicit search scrolls the current match into view.
    void adapter.search({ requestId: 1, query: "beta", matchCase: false });
    frames.flushFrames();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(getArtifactFindState(editor).matches.length).toBe(2);
    scrollIntoView.mockClear();

    // A passive document edit (e.g. a streamed / collaborative Y.Doc change)
    // dispatches a docChanged transaction with no find meta, triggering the
    // debounced rescan.
    editor.view.dispatch(editor.state.tr.insertText("z", 1));
    vi.runOnlyPendingTimers();
    frames.flushFrames();

    // Highlights are recomputed (current decoration still present) but the
    // viewport is NOT yanked. Reintroducing scheduleCurrentScroll() in the
    // rescan path makes this assertion fail.
    expect(getArtifactFindState(editor).matches.length).toBe(2);
    expect(
      editor.view.dom.querySelector("[data-artifact-find-current]"),
    ).not.toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();

    // Explicit navigation still scrolls the current match into view.
    void adapter.next();
    frames.flushFrames();
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "center",
      inline: "nearest",
    });

    unsubscribe();
  });

  it("recomputes replace-current against the latest document before editing", () => {
    vi.useFakeTimers();
    const editor = makeEditor("<p>beta gamma beta</p>", true);
    const adapter = makeAdapter(editor, "spec", "stale-current");
    const unsubscribe = adapter.subscribe(() => undefined);
    void adapter.search({ requestId: 1, query: "beta", matchCase: false });
    const firstMatch = getArtifactFindState(editor).matches.at(0);
    if (firstMatch === undefined) {
      throw new Error("Expected an initial beta match.");
    }

    editor.view.dispatch(
      editor.state.tr.insertText("beto", firstMatch.from, firstMatch.to),
    );
    void requireReplace(adapter).replaceCurrent({
      requestId: 2,
      query: "beta",
      matchCase: false,
      replaceText: "XXX",
    });

    expect(editor.getText()).toBe("beto gamma XXX");
    unsubscribe();
  });

  it("scrolls the newly current match after replace-current", () => {
    const frames = installAnimationFrameQueue();
    const scrollIntoView = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);
    const editor = makeEditor(
      "<p>one needle two needle three needle four needle</p>",
      true,
    );
    const adapter = makeAdapter(editor, "spec", "replace-current-scroll");

    void adapter.search({ requestId: 1, query: "needle", matchCase: false });
    void adapter.next();
    void adapter.next();
    frames.flushFrames();
    scrollIntoView.mockClear();
    expectCurrentElementToBeMatch(editor, 2);

    void requireReplace(adapter).replaceCurrent({
      requestId: 2,
      query: "needle",
      matchCase: false,
      replaceText: "done",
    });

    expect(editor.getText()).toBe(
      "one needle two needle three done four needle",
    );
    expect(getArtifactFindState(editor).currentIndex).toBe(2);
    expectCurrentElementToBeMatch(editor, 2);
    expect(scrollIntoView).not.toHaveBeenCalled();

    frames.runNextFrame();
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "center",
      inline: "nearest",
    });
  });

  it("dispatches replace-all as one undoable editor transaction", () => {
    const editor = makeEditor("<p>foo foo foo</p>", true);
    const adapter = makeAdapter(editor, "review", "replace-all");
    const docTransactions: Transaction[] = [];
    const handleTransaction = (props: {
      readonly transaction: Transaction;
    }) => {
      if (props.transaction.docChanged) docTransactions.push(props.transaction);
    };
    editor.on("transaction", handleTransaction);

    void requireReplace(adapter).replaceAll({
      requestId: 1,
      query: "foo",
      matchCase: false,
      replaceText: "bar",
    });

    expect(editor.getText()).toBe("bar bar bar");
    expect(docTransactions).toHaveLength(1);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getText()).toBe("foo foo foo");
    editor.off("transaction", handleTransaction);
  });
});

function installAnimationFrameQueue(): {
  readonly runNextFrame: () => void;
  readonly flushFrames: () => void;
} {
  let nextHandle = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
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
    runNextFrame: () => {
      const entry = Array.from(callbacks.entries()).at(0);
      if (entry === undefined) {
        throw new Error("Expected a pending animation frame.");
      }
      const [handle, callback] = entry;
      callbacks.delete(handle);
      callback(0);
    },
    // Drain every pending frame, including frames re-scheduled while draining
    // (e.g. the scroll retry loop), so a test can assert that NO scroll frame
    // ever ran. Guarded against runaway re-scheduling.
    flushFrames: () => {
      let guard = 0;
      while (callbacks.size > 0) {
        guard += 1;
        if (guard > 50) {
          throw new Error("Too many pending animation frames.");
        }
        const entry = Array.from(callbacks.entries()).at(0);
        if (entry === undefined) return;
        const [handle, callback] = entry;
        callbacks.delete(handle);
        callback(0);
      }
    },
  };
}

function expectCurrentElementToBeMatch(editor: Editor, index: number): void {
  const highlighted = Array.from(
    editor.view.dom.querySelectorAll<HTMLElement>(
      "[data-artifact-find-match='true']",
    ),
  );
  const current = editor.view.dom.querySelector<HTMLElement>(
    "[data-artifact-find-current]",
  );
  expect(current).toBe(highlighted[index]);
}
