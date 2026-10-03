import { Profiler, useState, type ProfilerOnRenderCallback } from "react";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import type { BrowserAnnotationRecord } from "@/lib/browser-view/annotation/browser-annotation-record";
import { STUB_ANNOTATION_ELEMENT } from "@/lib/browser-view/annotation/__tests__/browser-annotation-fixtures";
import * as tiptapJsonContent from "@/lib/composer/tiptap-json-content";
import * as imageAtoms from "@/lib/composer/image-atoms";
import {
  buildQuoteBlockquote,
  appendQuoteToDraft,
} from "../../quote/append-quote-to-draft";

import { useChatComposerDraft } from "../use-chat-composer-draft";
import { ComposerPromptEditor } from "../composer-prompt-editor";
import type { ComposerPromptEditorHandle } from "../composer-prompt-editor";
import { createComposerPickerStore } from "../picker/composer-picker-store";
import { createFakeComposerPromptEditorHandle } from "./composer-prompt-editor-handle-fixtures";

afterEach(() => {
  cleanup();
  useComposerDraftStore.setState({ drafts: {} });
});

function doc(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

const EMPTY_DOC: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

const EMPTY_SELECTION = { from: 1, to: 1 } as const;

function fakeHandle(ready: boolean) {
  const { handle, setContent, syncContent, markReady } =
    createFakeComposerPromptEditorHandle({
      ready,
      content: doc(""),
      selection: null,
      isEmpty: true,
      onFocus: null,
      onClear: null,
    });
  return {
    handle,
    setContent,
    syncContent,
    markReady: () => {
      markReady(true);
    },
  };
}

interface BridgeHookProps {
  readonly chatId: string;
  readonly editorRef: { current: ComposerPromptEditorHandle | null };
  readonly editorReadyTick: number;
}

function renderBridgeHook(initial: BridgeHookProps) {
  return renderHook(
    (props: BridgeHookProps) =>
      useChatComposerDraft({
        chatId: props.chatId,
        epicId: "epic-1",
        hostId: "host-1",
        editorRef: props.editorRef,
        editorReadyTick: props.editorReadyTick,
        chatTitle: null,
        epicTitle: null,
      }),
    { initialProps: initial },
  );
}

describe("useChatComposerDraft bridge", () => {
  it("applies a resetEpoch bump immediately when the handle is already ready (normal epoch-change path)", () => {
    const taskId = "task-1";
    const { handle, syncContent } = fakeHandle(true);
    const editorRef = { current: handle as ComposerPromptEditorHandle | null };

    renderBridgeHook({ chatId: taskId, editorRef, editorReadyTick: 1 });

    act(() => {
      useComposerDraftStore
        .getState()
        .replaceDraft(taskId, doc("quoted"), null);
    });

    expect(syncContent).toHaveBeenCalledTimes(1);
    expect(syncContent).toHaveBeenCalledWith(doc("quoted"), null);
  });

  it("defers an external replaceDraft while the handle is null and applies it exactly once on the editor-ready tick", () => {
    const taskId = "task-2";
    const editorRef: { current: ComposerPromptEditorHandle | null } = {
      current: null,
    };

    const { rerender } = renderBridgeHook({
      chatId: taskId,
      editorRef,
      editorReadyTick: 0,
    });

    act(() => {
      useComposerDraftStore
        .getState()
        .replaceDraft(taskId, doc("quoted"), null);
    });

    const { handle, syncContent } = fakeHandle(true);
    expect(syncContent).not.toHaveBeenCalled();

    // The editor finishes construction: ComposerPromptEditor fires
    // onEditorReady, which the owner turns into an editorReadyTick bump.
    editorRef.current = handle;
    rerender({ chatId: taskId, editorRef, editorReadyTick: 1 });

    expect(syncContent).toHaveBeenCalledTimes(1);
    expect(syncContent).toHaveBeenCalledWith(doc("quoted"), null);

    // A further rerender with nothing new must not replay the same epoch.
    rerender({ chatId: taskId, editorRef, editorReadyTick: 1 });
    expect(syncContent).toHaveBeenCalledTimes(1);
  });

  it("does not stamp a pending epoch into a not-yet-ready handle (whose methods silently no-op)", () => {
    const taskId = "task-not-ready";
    const { handle, syncContent, markReady } = fakeHandle(false);
    // The handle EXISTS from the owner's first commit - only the editor
    // behind it is still constructing. Applying now would no-op inside the
    // handle and permanently swallow the reset.
    const editorRef = { current: handle as ComposerPromptEditorHandle | null };

    const { rerender } = renderBridgeHook({
      chatId: taskId,
      editorRef,
      editorReadyTick: 0,
    });

    act(() => {
      useComposerDraftStore
        .getState()
        .replaceDraft(taskId, doc("quoted"), null);
    });
    expect(syncContent).not.toHaveBeenCalled();

    markReady();
    rerender({ chatId: taskId, editorRef, editorReadyTick: 1 });

    expect(syncContent).toHaveBeenCalledTimes(1);
    expect(syncContent).toHaveBeenCalledWith(doc("quoted"), null);
  });

  it("applies exactly once per epoch across repeated external replaceDraft calls (queue-edit / failed-send restore path)", () => {
    const taskId = "task-3";
    const { handle, syncContent } = fakeHandle(true);
    const editorRef = { current: handle as ComposerPromptEditorHandle | null };

    renderBridgeHook({ chatId: taskId, editorRef, editorReadyTick: 1 });

    act(() => {
      useComposerDraftStore
        .getState()
        .replaceDraft(taskId, doc("first restore"), null);
    });
    expect(syncContent).toHaveBeenCalledTimes(1);
    expect(syncContent).toHaveBeenLastCalledWith(doc("first restore"), null);

    act(() => {
      useComposerDraftStore
        .getState()
        .replaceDraft(taskId, doc("second restore"), null);
    });
    expect(syncContent).toHaveBeenCalledTimes(2);
    expect(syncContent).toHaveBeenLastCalledWith(doc("second restore"), null);
  });

  /**
   * clearDraft reuses the resetEpoch broadcast. Old clearDraft deleted the
   * map entry, so a sibling composer's Tiptap document kept the just-
   * submitted text (split panes / keep-alive tabs sharing one taskId).
   */
  it("broadcasts clearDraft empty content into every ready sibling composer for the same taskId", () => {
    const taskId = "task-multi-surface";
    const a = fakeHandle(true);
    const b = fakeHandle(true);
    const editorRefA = {
      current: a.handle as ComposerPromptEditorHandle | null,
    };
    const editorRefB = {
      current: b.handle as ComposerPromptEditorHandle | null,
    };

    act(() => {
      useComposerDraftStore
        .getState()
        .setSnapshot(taskId, doc("queued steer text"), null);
    });

    renderBridgeHook({
      chatId: taskId,
      editorRef: editorRefA,
      editorReadyTick: 1,
    });
    renderBridgeHook({
      chatId: taskId,
      editorRef: editorRefB,
      editorReadyTick: 1,
    });

    act(() => {
      useComposerDraftStore.getState().clearDraft(taskId);
    });

    // Both surfaces must push empty content into their local Tiptap docs.
    // Old clearDraft deleted the map entry and never called syncContent on B.
    expect(a.syncContent).toHaveBeenCalledWith(EMPTY_DOC, EMPTY_SELECTION);
    expect(b.syncContent).toHaveBeenCalledWith(EMPTY_DOC, EMPTY_SELECTION);
  });

  it("defers clearDraft apply until the handle becomes ready (readiness-deferred empty push)", () => {
    const taskId = "task-clear-deferred";
    const { handle, syncContent, markReady } = fakeHandle(false);
    const editorRef = { current: handle as ComposerPromptEditorHandle | null };

    act(() => {
      useComposerDraftStore
        .getState()
        .setSnapshot(taskId, doc("stale text"), null);
    });

    const { rerender } = renderBridgeHook({
      chatId: taskId,
      editorRef,
      editorReadyTick: 0,
    });

    act(() => {
      useComposerDraftStore.getState().clearDraft(taskId);
    });
    // Handle exists but methods no-op until useEditor resolves - must not
    // stamp the epoch yet or the empty content would be swallowed forever.
    expect(syncContent).not.toHaveBeenCalled();

    markReady();
    rerender({ chatId: taskId, editorRef, editorReadyTick: 1 });

    expect(syncContent).toHaveBeenCalledTimes(1);
    expect(syncContent).toHaveBeenCalledWith(EMPTY_DOC, EMPTY_SELECTION);
  });
});

interface QuoteFocusHarnessProps {
  readonly taskId: string;
  readonly editorRef: { current: ComposerPromptEditorHandle | null };
  readonly selectionRef: {
    current: { readonly from: number; readonly to: number } | null;
  };
}

function QuoteFocusHarness(props: QuoteFocusHarnessProps) {
  const { taskId, editorRef, selectionRef } = props;
  // Mirrors ChatComposer's real wiring: onEditorReady bumps a tick the bridge
  // keys its handle-ready catch-up on.
  const [editorReadyTick, setEditorReadyTick] = useState(0);
  const { initialContent, initialSelection } = useChatComposerDraft({
    chatId: taskId,
    epicId: "epic-1",
    hostId: "host-1",
    editorRef,
    editorReadyTick,
    chatTitle: null,
    epicTitle: null,
  });
  const [pickerStore] = useState(() => createComposerPickerStore());
  return (
    <ComposerPromptEditor
      ref={(instance) => {
        editorRef.current = instance;
      }}
      initialContent={initialContent}
      initialSelection={initialSelection}
      pickerStore={pickerStore}
      placeholder="test"
      editorClassName={undefined}
      isActive={false}
      disabled={false}
      slashProviderId="claude"
      hasPastedImageBytes={null}
      ingestPastedComposerImages={null}
      stabilizeImageAttachmentCaret={false}
      onDocumentChange={(_content, selection) => {
        selectionRef.current = selection;
      }}
      onSelectionChange={(selection) => {
        selectionRef.current = selection;
      }}
      onSubmit={() => undefined}
      onPaste={() => undefined}
      onDragOver={() => undefined}
      onDrop={() => undefined}
      onKeyDown={undefined}
      onFocus={() => undefined}
      onBlur={() => undefined}
      onEditorReady={() => setEditorReadyTick((tick) => tick + 1)}
    />
  );
}

function nodeSize(node: JsonContent): number {
  if (node.type === "text") return (node.text ?? "").length;
  const children = node.content;
  if (children === undefined) return 1;
  return 2 + children.reduce((sum, child) => sum + nodeSize(child), 0);
}

function docEndPosition(content: JsonContent): number {
  return (content.content ?? []).reduce(
    (sum, child) => sum + nodeSize(child),
    0,
  );
}

describe("appendQuoteToDraft + useChatComposerDraft integration", () => {
  it("preserves focus in the submitting composer when clearDraft broadcasts to a sibling", async () => {
    const taskId = "task-clear-focus";
    const editorRefA: { current: ComposerPromptEditorHandle | null } = {
      current: null,
    };
    const editorRefB: { current: ComposerPromptEditorHandle | null } = {
      current: null,
    };
    const selectionRefA: {
      current: { readonly from: number; readonly to: number } | null;
    } = { current: null };
    const selectionRefB: {
      current: { readonly from: number; readonly to: number } | null;
    } = { current: null };

    act(() => {
      useComposerDraftStore
        .getState()
        .setSnapshot(taskId, doc("queued steer text"), null);
    });

    render(
      <>
        <QuoteFocusHarness
          taskId={taskId}
          editorRef={editorRefA}
          selectionRef={selectionRefA}
        />
        <QuoteFocusHarness
          taskId={taskId}
          editorRef={editorRefB}
          selectionRef={selectionRefB}
        />
      </>,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const handleA = editorRefA.current;
    const handleB = editorRefB.current;
    expect(handleA).not.toBeNull();
    expect(handleB).not.toBeNull();
    if (handleA === null || handleB === null) {
      throw new Error("editor handle missing");
    }

    act(() => {
      handleA.focus();
    });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    const editorDoms = screen.getAllByRole("textbox", { name: "test" });
    expect(editorDoms).toHaveLength(2);
    expect(document.activeElement).toBe(editorDoms[0]);

    act(() => {
      useComposerDraftStore.getState().clearDraft(taskId);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    expect(handleA.getJSON()).toEqual(EMPTY_DOC);
    expect(handleB.getJSON()).toEqual(EMPTY_DOC);
    expect(document.activeElement).toBe(editorDoms[0]);
  });

  it("focuses the mounted editor with the caret at doc end after appending a quote", async () => {
    const taskId = "task-focus";
    const editorRef: { current: ComposerPromptEditorHandle | null } = {
      current: null,
    };
    const selectionRef: {
      current: { readonly from: number; readonly to: number } | null;
    } = { current: null };

    render(
      <QuoteFocusHarness
        taskId={taskId}
        editorRef={editorRef}
        selectionRef={selectionRef}
      />,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const quote = buildQuoteBlockquote({ text: "quoted", fenceLanguage: null });
    act(() => {
      appendQuoteToDraft(taskId, quote);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // Tiptap's `focus` command dispatches the selection change synchronously
    // but defers the actual DOM `view.focus()` to a `requestAnimationFrame`
    // callback - wait a frame before asserting `document.activeElement`.
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const handle = editorRef.current;
    expect(handle).not.toBeNull();
    if (handle === null) throw new Error("editor handle missing");

    const finalContent = handle.getJSON();
    expect(finalContent).toEqual({
      type: "doc",
      content: [quote, { type: "paragraph" }],
    });

    const editorDom = document.querySelector("[data-composer-editor]");
    expect(editorDom).not.toBeNull();
    expect(document.activeElement).toBe(editorDom);

    const expectedEnd = docEndPosition(finalContent);
    expect(selectionRef.current).toEqual({
      from: expectedEnd,
      to: expectedEnd,
    });
  });
});

function draftAnnotation(annotationId: string): BrowserAnnotationRecord {
  return {
    kind: "browser-annotation",
    annotationId,
    tabId: "t-1",
    sessionId: "s-1",
    origin: "https://example.com",
    pageUrl: "https://example.com/",
    pageTitle: "Example Domain",
    capturedAt: 1_700_000_000_000,
    comment: "annotate",
    counts: { elements: 1, regions: 0, strokes: 0 },
    elements: [STUB_ANNOTATION_ELEMENT],
    imageFileName: `browser-annotation-${annotationId}.png`,
    imageHash: `hash-${annotationId}`,
    droppedElementCount: 0,
  };
}

describe("useChatComposerDraft browser annotation image gating", () => {
  it("sets draftHasImages when the draft has a browser annotation and no editor images", () => {
    const taskId = "task-ann-images";
    const { handle } = fakeHandle(true);
    const editorRef = { current: handle as ComposerPromptEditorHandle | null };

    act(() => {
      useComposerDraftStore
        .getState()
        .addBrowserAnnotation(taskId, draftAnnotation("ann-gate"));
    });

    const { result } = renderBridgeHook({
      chatId: taskId,
      editorRef,
      editorReadyTick: 1,
    });

    expect(result.current.draftHasText).toBe(false);
    expect(result.current.draftHasImages).toBe(true);
  });

  it("clears draftHasImages when the last browser annotation is removed", () => {
    const taskId = "task-ann-remove";
    const { handle } = fakeHandle(true);
    const editorRef = { current: handle as ComposerPromptEditorHandle | null };

    act(() => {
      useComposerDraftStore
        .getState()
        .addBrowserAnnotation(taskId, draftAnnotation("ann-remove"));
    });

    const { result } = renderBridgeHook({
      chatId: taskId,
      editorRef,
      editorReadyTick: 1,
    });
    expect(result.current.draftHasImages).toBe(true);

    act(() => {
      useComposerDraftStore
        .getState()
        .removeBrowserAnnotation(taskId, "ann-remove");
    });
    expect(result.current.draftHasImages).toBe(false);
  });
});

function mentionDoc(attrs: Record<string, unknown>): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "mention", attrs }] }],
  };
}

function slashCommandDoc(attrs: Record<string, unknown>): JsonContent {
  return {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "slashCommand", attrs }] },
    ],
  };
}

function blockquoteDoc(content: JsonContent[]): JsonContent {
  return {
    type: "doc",
    content: [{ type: "blockquote", content }],
  };
}

function sourcedQuoteDoc(content: JsonContent[]): JsonContent {
  return {
    type: "doc",
    content: [{ type: "sourcedQuote", content }],
  };
}

function imageOnlyDoc(): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "imageAttachment",
        attrs: {
          id: "img-1",
          fileName: "img-1.png",
          mimeType: "image/png",
          size: 10,
          byHashEligible: false,
          hash: "hash-1",
        },
      },
    ],
  };
}

describe("draftHasText: early-exit predicate matches the real full plain-text projection", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly content: JsonContent;
  }> = [
    { name: "plain non-whitespace text", content: doc("hello") },
    { name: "whitespace-only text", content: doc("   \n\t") },
    { name: "empty doc", content: EMPTY_DOC },
    {
      name: "mention chip alone with valid attrs",
      content: mentionDoc({ contextType: "file", path: "src/foo.ts" }),
    },
    {
      name: "mention chip alone with malformed attrs",
      content: mentionDoc({ contextType: "not-a-real-type" }),
    },
    {
      name: "slash command chip alone with valid attrs",
      content: slashCommandDoc({ commandName: "review" }),
    },
    {
      name: "slash command chip alone with malformed attrs",
      content: slashCommandDoc({}),
    },
    { name: "empty blockquote", content: blockquoteDoc([]) },
    {
      name: "blockquote wrapping real text",
      content: blockquoteDoc([
        { type: "paragraph", content: [{ type: "text", text: "quoted" }] },
      ]),
    },
    { name: "empty sourcedQuote", content: sourcedQuoteDoc([]) },
    { name: "image attachment alone, no text", content: imageOnlyDoc() },
  ];

  for (const { name, content } of cases) {
    it(`matches the full projection for: ${name}`, () => {
      const taskId = `task-parity-${name}`;
      act(() => {
        useComposerDraftStore.getState().setSnapshot(taskId, content, null);
      });
      const { handle } = fakeHandle(true);
      const editorRef = {
        current: handle as ComposerPromptEditorHandle | null,
      };

      const { result } = renderBridgeHook({
        chatId: taskId,
        editorRef,
        editorReadyTick: 1,
      });

      const expected =
        tiptapJsonContent
          .extractPlainTextFromComposerJSONContent(content)
          .trim().length > 0;
      expect(result.current.draftHasText).toBe(expected);
    });
  }
});

describe("50k-character prompt: no full-text extraction, no extra hook re-render, exact snapshot per edit", () => {
  it("repeated edits keep hasText stable, store the exact content/selection, and never call the full plain-text extractor", () => {
    const taskId = "task-50k";
    const { handle } = fakeHandle(true);
    const editorRef = { current: handle as ComposerPromptEditorHandle | null };

    const renders = { count: 0 };
    const onRenderProbe: ProfilerOnRenderCallback = () => {
      renders.count += 1;
    };

    const longText = "a".repeat(50_000);
    const { result } = renderHook(
      (props: BridgeHookProps) =>
        useChatComposerDraft({
          chatId: props.chatId,
          epicId: "epic-1",
          hostId: "host-1",
          editorRef: props.editorRef,
          editorReadyTick: props.editorReadyTick,
          chatTitle: null,
          epicTitle: null,
        }),
      {
        initialProps: { chatId: taskId, editorRef, editorReadyTick: 1 },
        wrapper: ({ children }) => (
          <Profiler id="probe" onRender={onRenderProbe}>
            {children}
          </Profiler>
        ),
      },
    );

    // Establish the draft row (mints `draftId`) the way the owner's first
    // keystroke does - this edit is expected to re-render.
    act(() => {
      result.current.handleDocumentChange(doc(longText), { from: 1, to: 1 });
    });
    expect(
      useComposerDraftStore.getState().drafts[taskId]?.draftId,
    ).not.toBeNull();

    const extractSpy = vi.spyOn(
      tiptapJsonContent,
      "extractPlainTextFromComposerJSONContent",
    );
    extractSpy.mockClear();
    renders.count = 0;

    for (let i = 0; i < 20; i += 1) {
      const content = doc(`${longText}${i}`);
      const selection = { from: i + 1, to: i + 1 };
      act(() => {
        result.current.handleDocumentChange(content, selection);
      });
      const stored = useComposerDraftStore.getState().drafts[taskId];
      expect(stored?.content).toEqual(content);
      expect(stored?.selection).toEqual(selection);
    }

    expect(extractSpy).not.toHaveBeenCalled();
    expect(renders.count).toBe(0);

    extractSpy.mockRestore();
  });
});

function manyParagraphs(count: number): JsonContent[] {
  return Array.from({ length: count }, (_, i) => ({
    type: "paragraph",
    content: [{ type: "text", text: `line ${i}` }],
  }));
}

/**
 * A `JsonContent` whose `content` array is behind a counted getter, installed
 * from the TEST side (`Object.defineProperty`) rather than a production seam.
 * `composerNodeHasText` reads `(...).content?.some(...)` and
 * `containsImageAtoms` walks the same array - either one re-running over an
 * UNCHANGED draft counts as a read here.
 */
function contentWithCountedGetter(
  paragraphs: JsonContent[],
  onRead: () => void,
): JsonContent {
  const target = { type: "doc" } as JsonContent;
  Object.defineProperty(target, "content", {
    enumerable: true,
    get() {
      onRead();
      return paragraphs;
    },
  });
  return target;
}

describe("P2 regression: an unrelated store write must not re-traverse an untouched chat's content", () => {
  it("chatA's edit and chatB's own selection move do not re-run chatB's text/image predicates over chatB's content", () => {
    const taskA = "task-p2-a";
    const taskB = "task-p2-b";

    let bContentReads = 0;
    const bParagraphs = manyParagraphs(500);
    const bDoc = contentWithCountedGetter(bParagraphs, () => {
      bContentReads += 1;
    });

    act(() => {
      useComposerDraftStore.getState().setSnapshot(taskB, bDoc, null);
    });

    const imageSpy = vi.spyOn(imageAtoms, "containsImageAtoms");

    const { handle: handleA } = fakeHandle(true);
    const editorRefA = {
      current: handleA as ComposerPromptEditorHandle | null,
    };
    const { handle: handleB } = fakeHandle(true);
    const editorRefB = {
      current: handleB as ComposerPromptEditorHandle | null,
    };

    const { result: resultA } = renderBridgeHook({
      chatId: taskA,
      editorRef: editorRefA,
      editorReadyTick: 1,
    });
    const { result: resultB } = renderBridgeHook({
      chatId: taskB,
      editorRef: editorRefB,
      editorReadyTick: 1,
    });

    // Both hooks have mounted and settled - count only what the two
    // isolated, synchronous actions below cause. No `await` anywhere in this
    // test, so a persist/mirror timer cannot fire and muddy either count.
    bContentReads = 0;
    imageSpy.mockClear();

    act(() => {
      resultA.current.handleDocumentChange(doc("hello from A"), {
        from: 1,
        to: 1,
      });
    });
    act(() => {
      resultB.current.handleSelectionChange({ from: 1, to: 1 });
    });

    const bImageCalls = imageSpy.mock.calls.filter(
      ([content]) => content === bDoc,
    );
    expect(bContentReads).toBe(0);
    expect(bImageCalls).toHaveLength(0);

    imageSpy.mockRestore();
  });
});
