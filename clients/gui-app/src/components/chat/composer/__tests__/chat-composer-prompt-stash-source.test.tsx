/**
 * Chat surface prompt-stash CAS + destination acknowledgement: exercises the
 * REAL chat production adapters (`useChatPromptStashSource` /
 * `useChatPromptStashDestination`) against `useComposerDraftStore` (not a
 * fake or mirrored token source). Locks H1 (stale capture must not cancel a
 * newer queue edit) and Ticket 2 exact-destination races without mounting
 * the full ChatComposer tree.
 */
import "../../../../../__tests__/test-browser-apis";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { RefObject } from "react";

import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import {
  useChatPromptStashDestination,
  useChatPromptStashSource,
} from "@/components/chat/composer/use-chat-prompt-stash-adapters";
import { usePromptStash } from "@/hooks/composer/use-prompt-stash";
import type { PromptStashEntry } from "@/lib/composer/prompt-stash-codec";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { usePromptStashStore } from "@/stores/composer/prompt-stash-store";

const storeMocks = vi.hoisted(() => ({
  save: vi.fn(),
  remove: vi.fn(),
  hydrate: vi.fn(() => Promise.resolve(undefined)),
}));

const materializeMocks = vi.hoisted(() => ({
  impl: null as null | ((entry: PromptStashEntry) => Promise<JsonContent>),
}));

vi.mock("@/stores/composer/prompt-stash-store", () => {
  const state = {
    rows: [] as unknown[],
    hydrate: storeMocks.hydrate,
    save: storeMocks.save,
    remove: storeMocks.remove,
    markUnavailable: (_id: string) => undefined,
  };
  const usePromptStashStoreMock = Object.assign(
    (selector: (s: typeof state) => unknown) => selector(state),
    {
      getState: () => state,
      setState: (partial: Partial<typeof state>) => {
        Object.assign(state, partial);
      },
    },
  );
  return { usePromptStashStore: usePromptStashStoreMock };
});

vi.mock("@/lib/composer/prompt-stash-content", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/composer/prompt-stash-content")
    >();
  return {
    ...actual,
    materializePromptStashEntry: (entry: PromptStashEntry) => {
      if (materializeMocks.impl !== null) {
        return materializeMocks.impl(entry);
      }
      return actual.materializePromptStashEntry(entry);
    },
  };
});

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    warning: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("uuid", () => ({
  v4: vi.fn(() => "chat-stash-entry-id"),
}));

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

function makeEditorHandle(
  content: JsonContent,
  options:
    | {
        ready?: boolean;
        onFocus?: () => void;
      }
    | undefined,
): ComposerPromptEditorHandle {
  const ready = options?.ready ?? true;
  return {
    isReady: () => ready,
    hasFocus: () => false,
    focus: () => {
      options?.onFocus?.();
    },
    focusAtEnd: () => undefined,
    getJSON: () => content,
    isEmpty: () => false,
    clear: () => undefined,
    setContent: () => undefined,
    syncContent: () => undefined,
    insertImageAttachments: () => undefined,
    beginPathInsertion: () => null,
    removeImageAttachmentById: () => undefined,
    rewriteImageAttachmentHashById: () => false,
    insertDictatedText: () => undefined,
    dismissActiveSuggestion: () => false,
  };
}

function makeEditor(content: JsonContent): {
  readonly editorRef: RefObject<ComposerPromptEditorHandle | null>;
  readonly focuses: number[];
  readonly handle: ComposerPromptEditorHandle;
  /**
   * Simulates remount: new ready handle object under the same task id.
   */
  remount: () => ComposerPromptEditorHandle;
} {
  const focuses: number[] = [];
  const editorRef: { current: ComposerPromptEditorHandle | null } = {
    current: null,
  };

  const create = (): ComposerPromptEditorHandle => {
    const handle = makeEditorHandle(content, {
      onFocus: () => {
        focuses.push(1);
      },
    });
    editorRef.current = handle;
    return handle;
  };

  const initial = create();

  return {
    editorRef,
    focuses,
    handle: initial,
    remount: () => create(),
  };
}

function useChatPromptStashController(args: {
  readonly taskId: string;
  readonly onCancelQueueEdit: (() => void) | null;
  readonly editorRef: RefObject<ComposerPromptEditorHandle | null>;
}) {
  const source = useChatPromptStashSource(args.taskId, args.onCancelQueueEdit);
  const destination = useChatPromptStashDestination(
    args.taskId,
    args.editorRef,
  );
  return usePromptStash({
    active: true,
    disabled: false,
    editorRef: args.editorRef,
    readHashImage: () => Promise.resolve(null),
    source,
    destination,
  });
}

describe("chat composer prompt-stash source CAS", () => {
  const taskId = "task-stash-cas-1";

  beforeEach(() => {
    storeMocks.save.mockReset();
    storeMocks.remove.mockReset();
    storeMocks.hydrate.mockReset();
    storeMocks.hydrate.mockResolvedValue(undefined);
    storeMocks.save.mockResolvedValue(undefined);
    storeMocks.remove.mockResolvedValue(undefined);
    materializeMocks.impl = null;
    usePromptStashStore.setState({
      rows: [],
    });
    useComposerDraftStore.setState({ drafts: {} });
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    materializeMocks.impl = null;
    useComposerDraftStore.setState({ drafts: {} });
    window.localStorage.clear();
  });

  it("keeps newer content and does NOT cancel queue edit when draft mutates during save (H1)", async () => {
    let resolveSave: (() => void) | undefined;
    storeMocks.save.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );

    const original = textDoc("stashed original");
    const newer = textDoc("typed while saving");
    useComposerDraftStore
      .getState()
      .setSnapshot(taskId, original, { from: 1, to: 1 });
    const captureRevision =
      useComposerDraftStore.getState().drafts[taskId]?.revision;
    expect(captureRevision).toBe(1);

    const onCancelQueueEdit = vi.fn();
    const editor = makeEditor(original);

    const { result } = renderHook(() =>
      useChatPromptStashController({
        taskId,
        onCancelQueueEdit,
        editorRef: editor.editorRef,
      }),
    );

    await act(async () => {
      result.current.stashCurrent();
      await Promise.resolve();
    });
    expect(storeMocks.save).toHaveBeenCalledTimes(1);

    // Simulate typing (or a queue-edit swap via replaceDraft) for the same taskId.
    act(() => {
      useComposerDraftStore.getState().setSnapshot(taskId, newer, {
        from: 2,
        to: 2,
      });
    });
    expect(useComposerDraftStore.getState().drafts[taskId]?.revision).toBe(2);
    expect(useComposerDraftStore.getState().drafts[taskId]?.content).toEqual(
      newer,
    );

    await act(async () => {
      resolveSave?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.pulseEpoch).toBe(1);
    });
    // Newer content survives; queue edit was NOT cancelled by the stale capture.
    expect(useComposerDraftStore.getState().drafts[taskId]?.content).toEqual(
      newer,
    );
    expect(onCancelQueueEdit).not.toHaveBeenCalled();
  });

  it("clears draft and cancels queue edit when nothing changed before resolve", async () => {
    let resolveSave: (() => void) | undefined;
    storeMocks.save.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );

    const original = textDoc("unchanged stash");
    useComposerDraftStore
      .getState()
      .setSnapshot(taskId, original, { from: 1, to: 1 });

    const onCancelQueueEdit = vi.fn();
    const editor = makeEditor(original);

    const { result } = renderHook(() =>
      useChatPromptStashController({
        taskId,
        onCancelQueueEdit,
        editorRef: editor.editorRef,
      }),
    );

    await act(async () => {
      result.current.stashCurrent();
      await Promise.resolve();
    });

    await act(async () => {
      resolveSave?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.pulseEpoch).toBe(1);
    });
    const draft = useComposerDraftStore.getState().drafts[taskId];
    expect(draft?.content).toEqual(emptyDoc());
    expect(onCancelQueueEdit).toHaveBeenCalledTimes(1);
  });

  it("does not cancel queue edit after replaceDraft (queue-edit swap) during save", async () => {
    let resolveSave: (() => void) | undefined;
    storeMocks.save.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );

    const original = textDoc("before queue edit");
    const queueRestored = textDoc("queue item restored into composer");
    useComposerDraftStore.getState().setSnapshot(taskId, original, null);

    const onCancelQueueEdit = vi.fn();
    const editor = makeEditor(original);

    const { result } = renderHook(() =>
      useChatPromptStashController({
        taskId,
        onCancelQueueEdit,
        editorRef: editor.editorRef,
      }),
    );

    await act(async () => {
      result.current.stashCurrent();
      await Promise.resolve();
    });

    // editQueuedItem pattern: replaceDraft bumps revision unconditionally.
    act(() => {
      useComposerDraftStore
        .getState()
        .replaceDraft(taskId, queueRestored, { from: 1, to: 1 });
    });

    await act(async () => {
      resolveSave?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.pulseEpoch).toBe(1);
    });
    expect(useComposerDraftStore.getState().drafts[taskId]?.content).toEqual(
      queueRestored,
    );
    expect(onCancelQueueEdit).not.toHaveBeenCalled();
  });

  it("delayed save survives composer unmount/reopen for the same task without cancelling the new queue edit", async () => {
    // Composer unmount retires the usePromptStash instance mid-save. A later
    // remount for the same taskId binds a different onCancelQueueEdit (user
    // moved on to queue edit B). Without retiredRef, the retired instance's
    // clearIfUnchanged would clear the reopened draft and cancel queue edit A
    // even though A is no longer active — and with an equal revision ABA,
    // would also wipe content that legitimately matches the capture token.
    let resolveSave: (() => void) | undefined;
    storeMocks.save.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );

    const original = textDoc("stashed before unmount");
    useComposerDraftStore
      .getState()
      .setSnapshot(taskId, original, { from: 1, to: 1 });
    const captureRevision =
      useComposerDraftStore.getState().drafts[taskId]?.revision;
    expect(captureRevision).toBe(1);

    const onCancelQueueEditA = vi.fn();
    const onCancelQueueEditB = vi.fn();
    const editorA = makeEditor(original);

    const { result, unmount } = renderHook(() =>
      useChatPromptStashController({
        taskId,
        onCancelQueueEdit: onCancelQueueEditA,
        editorRef: editorA.editorRef,
      }),
    );

    await act(async () => {
      result.current.stashCurrent();
      await Promise.resolve();
    });
    expect(storeMocks.save).toHaveBeenCalledTimes(1);

    unmount();

    // Reopen: same taskId, equal revision (content restored as-is), new queue
    // edit association. Do not bump revision — this is the ABA case.
    const editorB = makeEditor(original);
    renderHook(() =>
      useChatPromptStashController({
        taskId,
        onCancelQueueEdit: onCancelQueueEditB,
        editorRef: editorB.editorRef,
      }),
    );
    expect(useComposerDraftStore.getState().drafts[taskId]?.revision).toBe(
      captureRevision,
    );
    expect(useComposerDraftStore.getState().drafts[taskId]?.content).toEqual(
      original,
    );

    await act(async () => {
      resolveSave?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Retired instance never cancelled queue edit A; B's association survives;
    // reopened draft content is untouched.
    expect(onCancelQueueEditA).not.toHaveBeenCalled();
    expect(onCancelQueueEditB).not.toHaveBeenCalled();
    expect(useComposerDraftStore.getState().drafts[taskId]?.content).toEqual(
      original,
    );
    expect(useComposerDraftStore.getState().drafts[taskId]?.revision).toBe(
      captureRevision,
    );
  });
});

describe("chat composer prompt-stash destination acknowledgement", () => {
  const taskId = "task-dest-ack-1";

  beforeEach(() => {
    storeMocks.save.mockReset();
    storeMocks.remove.mockReset();
    storeMocks.hydrate.mockReset();
    storeMocks.hydrate.mockResolvedValue(undefined);
    storeMocks.save.mockResolvedValue(undefined);
    storeMocks.remove.mockResolvedValue(undefined);
    materializeMocks.impl = null;
    usePromptStashStore.setState({
      rows: [],
    });
    useComposerDraftStore.setState({ drafts: {} });
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    materializeMocks.impl = null;
    useComposerDraftStore.setState({ drafts: {} });
    window.localStorage.clear();
  });

  it("consumes immediately and focuses after accepted chat insert", async () => {
    useComposerDraftStore
      .getState()
      .setSnapshot(taskId, emptyDoc(), { from: 1, to: 1 });
    const entry: PromptStashEntry = {
      id: "chat-entry-ok",
      createdAt: 1,
      content: textDoc("restored into chat"),
      blobHashes: [],
    };
    const editor = makeEditor(emptyDoc());
    const { result } = renderHook(() =>
      useChatPromptStashController({
        taskId,
        onCancelQueueEdit: null,
        editorRef: editor.editorRef,
      }),
    );

    let ok = false;
    await act(async () => {
      ok = await result.current.restore(entry);
    });

    expect(ok).toBe(true);
    expect(useComposerDraftStore.getState().drafts[taskId]?.content).toEqual(
      textDoc("restored into chat"),
    );
    // Selection is transient editor state; restoring always places the caret
    // at the end instead of re-selecting old content.
    expect(
      useComposerDraftStore.getState().drafts[taskId]?.selection,
    ).toBeNull();
    expect(storeMocks.remove).toHaveBeenCalledWith("chat-entry-ok");
    expect(editor.focuses).toHaveLength(1);
  });

  it("does not insert or consume when taskId changes during delayed materialize", async () => {
    // Hook materializes, then re-reads destinationRef for importAndInsert —
    // so a task rebind mid-materialize must leave both drafts untouched.
    const taskA = "task-a";
    const taskB = "task-b";
    useComposerDraftStore.getState().setSnapshot(taskA, emptyDoc(), null);
    useComposerDraftStore
      .getState()
      .setSnapshot(taskB, textDoc("other task draft"), null);

    let resolveMaterialize: ((content: JsonContent) => void) | undefined;
    materializeMocks.impl = () =>
      new Promise((resolve) => {
        resolveMaterialize = resolve;
      });

    const entry: PromptStashEntry = {
      id: "chat-entry-switch",
      createdAt: 1,
      content: textDoc("should not land"),
      blobHashes: [],
    };
    const editor = makeEditor(emptyDoc());

    const { result, rerender } = renderHook(
      ({ activeTaskId }: { activeTaskId: string }) =>
        useChatPromptStashController({
          taskId: activeTaskId,
          onCancelQueueEdit: null,
          editorRef: editor.editorRef,
        }),
      { initialProps: { activeTaskId: taskA } },
    );

    let restorePromise: Promise<boolean> | undefined;
    await act(async () => {
      restorePromise = result.current.restore(entry);
      await Promise.resolve();
    });
    expect(resolveMaterialize).toBeTypeOf("function");

    rerender({ activeTaskId: taskB });

    let ok = true;
    await act(async () => {
      resolveMaterialize?.(textDoc("should not land"));
      ok = await (restorePromise as Promise<boolean>);
    });

    expect(ok).toBe(false);
    expect(useComposerDraftStore.getState().drafts[taskA]?.content).toEqual(
      emptyDoc(),
    );
    expect(useComposerDraftStore.getState().drafts[taskB]?.content).toEqual(
      textDoc("other task draft"),
    );
    expect(storeMocks.remove).not.toHaveBeenCalled();
    expect(editor.focuses).toHaveLength(0);
  });

  it("appends to latest draft content mutated during materialize", async () => {
    useComposerDraftStore
      .getState()
      .setSnapshot(taskId, textDoc("before restore"), null);

    let resolveMaterialize: ((content: JsonContent) => void) | undefined;
    materializeMocks.impl = () =>
      new Promise((resolve) => {
        resolveMaterialize = resolve;
      });

    const entry: PromptStashEntry = {
      id: "chat-entry-append",
      createdAt: 1,
      content: textDoc("stashed body"),
      blobHashes: [],
    };
    const editor = makeEditor(textDoc("before restore"));
    const { result } = renderHook(() =>
      useChatPromptStashController({
        taskId,
        onCancelQueueEdit: null,
        editorRef: editor.editorRef,
      }),
    );

    await act(async () => {
      const pending = result.current.restore(entry);
      await Promise.resolve();
      useComposerDraftStore
        .getState()
        .setSnapshot(taskId, textDoc("typed during materialize"), {
          from: 3,
          to: 3,
        });
      resolveMaterialize?.(textDoc("stashed body"));
      await pending;
    });

    expect(useComposerDraftStore.getState().drafts[taskId]?.content).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "typed during materialize" }],
        },
        { type: "paragraph" },
        {
          type: "paragraph",
          content: [{ type: "text", text: "stashed body" }],
        },
      ],
    });
    // Restore always places the caret after the resulting document.
    expect(
      useComposerDraftStore.getState().drafts[taskId]?.selection,
    ).toBeNull();
    expect(storeMocks.remove).toHaveBeenCalledWith("chat-entry-append");
  });

  it("returns null captureIdentity when editor is missing or unready", () => {
    const { result: missing } = renderHook(() =>
      useChatPromptStashDestination(taskId, { current: null }),
    );
    expect(missing.current.captureIdentity()).toBeNull();

    const unready = makeEditorHandle(emptyDoc(), { ready: false });
    const { result: unreadyDest } = renderHook(() =>
      useChatPromptStashDestination(taskId, { current: unready }),
    );
    expect(unreadyDest.current.captureIdentity()).toBeNull();
  });

  it("does not insert or consume when ready handle remounts under the same taskId", async () => {
    useComposerDraftStore.getState().setSnapshot(taskId, emptyDoc(), null);

    let resolveMaterialize: ((content: JsonContent) => void) | undefined;
    materializeMocks.impl = () =>
      new Promise((resolve) => {
        resolveMaterialize = resolve;
      });

    const entry: PromptStashEntry = {
      id: "chat-entry-remount",
      createdAt: 1,
      content: textDoc("should not land after remount"),
      blobHashes: [],
    };
    const editor = makeEditor(emptyDoc());
    const capturedHandle = editor.handle;

    const { result } = renderHook(() =>
      useChatPromptStashController({
        taskId,
        onCancelQueueEdit: null,
        editorRef: editor.editorRef,
      }),
    );

    let restorePromise: Promise<boolean> | undefined;
    await act(async () => {
      restorePromise = result.current.restore(entry);
      await Promise.resolve();
    });
    expect(resolveMaterialize).toBeTypeOf("function");

    // Same taskId, new ready handle object (editor remount).
    const remounted = editor.remount();
    expect(remounted).not.toBe(capturedHandle);
    expect(editor.editorRef.current).toBe(remounted);

    let ok = true;
    await act(async () => {
      resolveMaterialize?.(textDoc("should not land after remount"));
      ok = await (restorePromise as Promise<boolean>);
    });

    expect(ok).toBe(false);
    expect(useComposerDraftStore.getState().drafts[taskId]?.content).toEqual(
      emptyDoc(),
    );
    expect(storeMocks.remove).not.toHaveBeenCalled();
    expect(editor.focuses).toHaveLength(0);
  });
});
