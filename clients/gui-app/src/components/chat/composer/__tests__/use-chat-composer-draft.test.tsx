import "../../../../../__tests__/test-browser-apis";
import { useState } from "react";
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
import {
  buildQuoteBlockquote,
  appendQuoteToDraft,
} from "../../quote/append-quote-to-draft";

import { useChatComposerDraft } from "../use-chat-composer-draft";
import { ComposerPromptEditor } from "../composer-prompt-editor";
import type { ComposerPromptEditorHandle } from "../composer-prompt-editor";
import { createComposerPickerStore } from "../picker/composer-picker-store";

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
  const setContent = vi.fn();
  let isReady = ready;
  const handle: ComposerPromptEditorHandle = {
    isReady: () => isReady,
    focus: () => undefined,
    focusAtEnd: () => undefined,
    getJSON: () => doc(""),
    isEmpty: () => true,
    clear: () => undefined,
    setContent,
    insertImageAttachments: () => undefined,
    beginPathInsertion: () => null,
    rewriteImageAttachmentHashById: () => false,
    removeImageAttachmentById: () => undefined,
    insertDictatedText: () => undefined,
    dismissActiveSuggestion: () => false,
  };
  return {
    handle,
    setContent,
    markReady: () => {
      isReady = true;
    },
  };
}

interface BridgeHookProps {
  readonly taskId: string;
  readonly editorRef: { current: ComposerPromptEditorHandle | null };
  readonly editorReadyTick: number;
}

function renderBridgeHook(initial: BridgeHookProps) {
  return renderHook((props: BridgeHookProps) => useChatComposerDraft(props), {
    initialProps: initial,
  });
}

describe("useChatComposerDraft bridge", () => {
  it("applies a resetEpoch bump immediately when the handle is already ready (normal epoch-change path)", () => {
    const taskId = "task-1";
    const { handle, setContent } = fakeHandle(true);
    const editorRef = { current: handle as ComposerPromptEditorHandle | null };

    renderBridgeHook({ taskId, editorRef, editorReadyTick: 1 });

    act(() => {
      useComposerDraftStore
        .getState()
        .replaceDraft(taskId, doc("quoted"), null);
    });

    expect(setContent).toHaveBeenCalledTimes(1);
    expect(setContent).toHaveBeenCalledWith(doc("quoted"), null);
  });

  it("defers an external replaceDraft while the handle is null and applies it exactly once on the editor-ready tick", () => {
    const taskId = "task-2";
    const editorRef: { current: ComposerPromptEditorHandle | null } = {
      current: null,
    };

    const { rerender } = renderBridgeHook({
      taskId,
      editorRef,
      editorReadyTick: 0,
    });

    act(() => {
      useComposerDraftStore
        .getState()
        .replaceDraft(taskId, doc("quoted"), null);
    });

    const { handle, setContent } = fakeHandle(true);
    expect(setContent).not.toHaveBeenCalled();

    // The editor finishes construction: ComposerPromptEditor fires
    // onEditorReady, which the owner turns into an editorReadyTick bump.
    editorRef.current = handle;
    rerender({ taskId, editorRef, editorReadyTick: 1 });

    expect(setContent).toHaveBeenCalledTimes(1);
    expect(setContent).toHaveBeenCalledWith(doc("quoted"), null);

    // A further rerender with nothing new must not replay the same epoch.
    rerender({ taskId, editorRef, editorReadyTick: 1 });
    expect(setContent).toHaveBeenCalledTimes(1);
  });

  it("does not stamp a pending epoch into a not-yet-ready handle (whose methods silently no-op)", () => {
    const taskId = "task-not-ready";
    const { handle, setContent, markReady } = fakeHandle(false);
    // The handle EXISTS from the owner's first commit - only the editor
    // behind it is still constructing. Applying now would no-op inside the
    // handle and permanently swallow the reset.
    const editorRef = { current: handle as ComposerPromptEditorHandle | null };

    const { rerender } = renderBridgeHook({
      taskId,
      editorRef,
      editorReadyTick: 0,
    });

    act(() => {
      useComposerDraftStore
        .getState()
        .replaceDraft(taskId, doc("quoted"), null);
    });
    expect(setContent).not.toHaveBeenCalled();

    markReady();
    rerender({ taskId, editorRef, editorReadyTick: 1 });

    expect(setContent).toHaveBeenCalledTimes(1);
    expect(setContent).toHaveBeenCalledWith(doc("quoted"), null);
  });

  it("applies exactly once per epoch across repeated external replaceDraft calls (queue-edit / failed-send restore path)", () => {
    const taskId = "task-3";
    const { handle, setContent } = fakeHandle(true);
    const editorRef = { current: handle as ComposerPromptEditorHandle | null };

    renderBridgeHook({ taskId, editorRef, editorReadyTick: 1 });

    act(() => {
      useComposerDraftStore
        .getState()
        .replaceDraft(taskId, doc("first restore"), null);
    });
    expect(setContent).toHaveBeenCalledTimes(1);
    expect(setContent).toHaveBeenLastCalledWith(doc("first restore"), null);

    act(() => {
      useComposerDraftStore
        .getState()
        .replaceDraft(taskId, doc("second restore"), null);
    });
    expect(setContent).toHaveBeenCalledTimes(2);
    expect(setContent).toHaveBeenLastCalledWith(doc("second restore"), null);
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
      taskId,
      editorRef: editorRefA,
      editorReadyTick: 1,
    });
    renderBridgeHook({
      taskId,
      editorRef: editorRefB,
      editorReadyTick: 1,
    });

    act(() => {
      useComposerDraftStore.getState().clearDraft(taskId);
    });

    // Both surfaces must push empty content into their local Tiptap docs.
    // Old clearDraft deleted the map entry and never called setContent on B.
    expect(a.setContent).toHaveBeenCalledWith(EMPTY_DOC, EMPTY_SELECTION);
    expect(b.setContent).toHaveBeenCalledWith(EMPTY_DOC, EMPTY_SELECTION);
  });

  it("defers clearDraft apply until the handle becomes ready (readiness-deferred empty push)", () => {
    const taskId = "task-clear-deferred";
    const { handle, setContent, markReady } = fakeHandle(false);
    const editorRef = { current: handle as ComposerPromptEditorHandle | null };

    act(() => {
      useComposerDraftStore
        .getState()
        .setSnapshot(taskId, doc("stale text"), null);
    });

    const { rerender } = renderBridgeHook({
      taskId,
      editorRef,
      editorReadyTick: 0,
    });

    act(() => {
      useComposerDraftStore.getState().clearDraft(taskId);
    });
    // Handle exists but methods no-op until useEditor resolves - must not
    // stamp the epoch yet or the empty content would be swallowed forever.
    expect(setContent).not.toHaveBeenCalled();

    markReady();
    rerender({ taskId, editorRef, editorReadyTick: 1 });

    expect(setContent).toHaveBeenCalledTimes(1);
    expect(setContent).toHaveBeenCalledWith(EMPTY_DOC, EMPTY_SELECTION);
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
    taskId,
    editorRef,
    editorReadyTick,
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
      onSnapshot={(_content, selection) => {
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
