/**
 * New-conversation modal prompt-stash destination acknowledgement. Uses
 * production `useNewConversationPromptStashDestination` without mounting the
 * full modal tree. Materialization is owned by the restore hook.
 */
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { useNewConversationPromptStashDestination } from "@/components/epic-canvas/sidebar/use-new-conversation-prompt-stash-adapters";
import type { DraftSelection } from "@/stores/composer/composer-draft-store";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";

function textDoc(text: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}

function emptyDoc(): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph" }],
  };
}

function renderModalDestination(args: {
  readonly epicId: string;
  readonly seedContent: JsonContent;
  readonly editorRef: { current: ComposerPromptEditorHandle | null };
}) {
  return renderHook(() =>
    useNewConversationPromptStashDestination({
      epicId: args.epicId,
      seedContent: args.seedContent,
      editorRef: args.editorRef,
    }),
  );
}

function makeEditorHandle(options: {
  ready?: boolean;
  content?: JsonContent;
}): {
  readonly handle: ComposerPromptEditorHandle;
  readonly editorRef: { current: ComposerPromptEditorHandle | null };
  readonly setContents: Array<{
    content: JsonContent;
    selection: DraftSelection | null;
  }>;
  setReady: (ready: boolean) => void;
  unmount: () => void;
  remount: () => ComposerPromptEditorHandle;
} {
  let ready = options.ready ?? true;
  let content = options.content ?? emptyDoc();
  const setContents: Array<{
    content: JsonContent;
    selection: DraftSelection | null;
  }> = [];

  const buildHandle = (): ComposerPromptEditorHandle => ({
    isReady: () => ready,
    hasFocus: () => false,
    focus: () => undefined,
    focusAtEnd: () => undefined,
    getJSON: () => content,
    isEmpty: () => false,
    clear: () => {
      content = emptyDoc();
    },
    setContent: (next, nextSelection) => {
      content = next;
      setContents.push({ content: next, selection: nextSelection });
    },
    syncContent: (next, nextSelection) => {
      content = next;
      setContents.push({ content: next, selection: nextSelection });
    },
    insertImageAttachments: () => undefined,
    insertMentionAttachment: () => false,
    beginPathInsertion: () => null,
    removeImageAttachmentById: () => undefined,
    rewriteImageAttachmentHashById: () => false,
    insertDictatedText: () => undefined,
    dismissActiveSuggestion: () => false,
  });

  const handle = buildHandle();
  const editorRef: { current: ComposerPromptEditorHandle | null } = {
    current: handle,
  };

  return {
    handle,
    editorRef,
    setContents,
    setReady: (next) => {
      ready = next;
    },
    unmount: () => {
      editorRef.current = null;
    },
    remount: () => {
      ready = true;
      const next = buildHandle();
      editorRef.current = next;
      return next;
    },
  };
}

describe("new-conversation modal prompt-stash destination acknowledgement", () => {
  const epicId = "epic-modal-dest-1";

  beforeEach(() => {
    useNewConversationModalStore.getState().resetForTests();
  });

  afterEach(() => {
    cleanup();
    useNewConversationModalStore.getState().resetForTests();
  });

  it("returns null captureIdentity when modal editor is missing or unready", () => {
    const { result: missing } = renderModalDestination({
      epicId,
      seedContent: emptyDoc(),
      editorRef: { current: null },
    });
    expect(missing.current.captureIdentity()).toBeNull();

    const unready = makeEditorHandle({ ready: false });
    const { result: dest } = renderModalDestination({
      epicId,
      seedContent: emptyDoc(),
      editorRef: unready.editorRef,
    });
    expect(dest.current.captureIdentity()).toBeNull();
  });

  it("returns stale when modal closes (editor null) after identity capture", async () => {
    const editor = makeEditorHandle({ content: emptyDoc() });
    const { result } = renderModalDestination({
      epicId,
      seedContent: emptyDoc(),
      editorRef: editor.editorRef,
    });
    const captured = result.current.captureIdentity();
    if (captured === null) throw new Error("expected capture");
    expect(captured).toEqual({
      surface: "new-conversation",
      identity: epicId,
      editorGeneration: editor.handle,
    });

    editor.unmount();
    const insertResult = await result.current.importAndInsert({
      identity: captured,
      content: textDoc("should not insert"),
    });
    expect(insertResult).toEqual({ status: "stale" });
    expect(editor.setContents).toHaveLength(0);
  });

  it("returns stale when ready handle remounts under the same epic id", async () => {
    const editor = makeEditorHandle({ content: emptyDoc() });
    const { result } = renderModalDestination({
      epicId,
      seedContent: emptyDoc(),
      editorRef: editor.editorRef,
    });
    const captured = result.current.captureIdentity();
    if (captured === null) throw new Error("expected capture");
    expect(captured.editorGeneration).toBe(editor.handle);

    const remounted = editor.remount();
    expect(remounted).not.toBe(editor.handle);
    expect(editor.editorRef.current).toBe(remounted);

    const insertResult = await result.current.importAndInsert({
      identity: captured,
      content: textDoc("should not insert after remount"),
    });
    expect(insertResult).toEqual({ status: "stale" });
    expect(editor.setContents).toHaveLength(0);
  });

  it("returns stale when epic identity changes after capture", async () => {
    const editor = makeEditorHandle({ content: emptyDoc() });
    const { result: destA } = renderModalDestination({
      epicId: "epic-a",
      seedContent: emptyDoc(),
      editorRef: editor.editorRef,
    });
    const captured = destA.current.captureIdentity();
    if (captured === null) throw new Error("expected capture");

    const { result: destB } = renderModalDestination({
      epicId: "epic-b",
      seedContent: emptyDoc(),
      editorRef: editor.editorRef,
    });
    const insertResult = await destB.current.importAndInsert({
      identity: captured,
      content: textDoc("wrong epic"),
    });
    expect(insertResult).toEqual({ status: "stale" });
    expect(editor.setContents).toHaveLength(0);
  });

  it("appends against latest modal draft content and accepts", async () => {
    useNewConversationModalStore
      .getState()
      .setContent(epicId, textDoc("typed in modal during materialize"));
    const editor = makeEditorHandle({
      content: textDoc("typed in modal during materialize"),
    });
    const { result } = renderModalDestination({
      epicId,
      seedContent: emptyDoc(),
      editorRef: editor.editorRef,
    });
    const captured = result.current.captureIdentity();
    if (captured === null) throw new Error("expected capture");

    const insertResult = await result.current.importAndInsert({
      identity: captured,
      content: textDoc("stashed prompt"),
    });

    expect(insertResult).toEqual({ status: "accepted" });
    expect(editor.setContents).toHaveLength(1);
    expect(editor.setContents[0]?.content).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "typed in modal during materialize" },
          ],
        },
        { type: "paragraph" },
        {
          type: "paragraph",
          content: [{ type: "text", text: "stashed prompt" }],
        },
      ],
    });
    expect(editor.setContents[0]?.selection).toBeNull();
  });

  it("uses seed content when no draft patch exists and places the caret at the end", async () => {
    const editor = makeEditorHandle({ content: emptyDoc() });
    const { result } = renderModalDestination({
      epicId,
      seedContent: emptyDoc(),
      editorRef: editor.editorRef,
    });
    const captured = result.current.captureIdentity();
    if (captured === null) throw new Error("expected capture");

    const insertResult = await result.current.importAndInsert({
      identity: captured,
      content: textDoc("from seed path"),
    });

    expect(insertResult).toEqual({ status: "accepted" });
    expect(editor.setContents[0]?.content).toEqual(textDoc("from seed path"));
    expect(editor.setContents[0]?.selection).toBeNull();
  });
});
