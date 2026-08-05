/**
 * New-conversation modal prompt-stash CAS against the real modal draft
 * store. Uses production `useNewConversationPromptStashSource` — especially
 * the non-nuclear clear fallback (content + selection only;
 * settings/composerMode/workspace untouched).
 *
 * Also covers Ticket 1 source-lifetime: a delayed stash save must not clear
 * a reopened modal patch after close/reopen with an equal numeric revision.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { RefObject } from "react";
import { toast } from "sonner";

import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { createComposerEditorIncarnation } from "@/lib/composer/composer-editor-incarnation";
import {
  useNewConversationPromptStashDestination,
  useNewConversationPromptStashSource,
} from "@/components/epic-canvas/sidebar/use-new-conversation-prompt-stash-adapters";
import { usePromptStash } from "@/hooks/composer/use-prompt-stash";
import {
  createEmptyNewConversationContent,
  useNewConversationModalStore,
} from "@/stores/epics/new-conversation-modal-store";
import { emptyLandingDraftWorkspaceSnapshot } from "@/stores/home/landing-draft-store";
import { usePromptStashStore } from "@/stores/composer/prompt-stash-store";

const storeMocks = vi.hoisted(() => ({
  save: vi.fn(),
  remove: vi.fn(),
  hydrate: vi.fn(() => Promise.resolve(undefined)),
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

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    warning: vi.fn(),
    success: vi.fn(),
  },
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

const SEED_SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "gpt-5-codex",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

function makeEditorHandle(
  options:
    | {
        ready?: boolean;
        onClear?: () => void;
      }
    | undefined,
): ComposerPromptEditorHandle {
  const editorIncarnation = createComposerEditorIncarnation();
  return {
    isReady: () => options?.ready ?? true,
    getEditorIncarnation: () =>
      (options?.ready ?? true) ? editorIncarnation : null,
    hasFocus: () => false,
    focus: () => undefined,
    focusAtEnd: () => undefined,
    getJSON: () => textDoc("live"),
    isEmpty: () => false,
    clear: () => {
      options?.onClear?.();
    },
    setContent: () => undefined,
    syncContent: () => undefined,
    insertImageAttachments: () => undefined,
    insertMentionAttachment: () => false,
    beginPathInsertion: () => null,
    removeImageAttachmentById: () => undefined,
    rewriteImageAttachmentHashById: () => false,
    insertDictatedText: () => undefined,
    dismissActiveSuggestion: () => false,
  };
}

function renderModalSource(args: {
  readonly epicId: string;
  readonly seedContent: JsonContent;
  readonly editorRef: { current: ComposerPromptEditorHandle | null };
}) {
  return renderHook(() =>
    useNewConversationPromptStashSource({
      epicId: args.epicId,
      seedContent: args.seedContent,
      editorRef: args.editorRef,
    }),
  );
}

function useModalPromptStashController(args: {
  readonly epicId: string;
  readonly seedContent: JsonContent;
  readonly editorRef: RefObject<ComposerPromptEditorHandle | null>;
}) {
  const source = useNewConversationPromptStashSource({
    epicId: args.epicId,
    seedContent: args.seedContent,
    editorRef: args.editorRef,
  });
  const destination = useNewConversationPromptStashDestination({
    epicId: args.epicId,
    seedContent: args.seedContent,
    editorRef: args.editorRef,
  });
  return usePromptStash({
    active: true,
    disabled: false,
    editorRef: args.editorRef,
    readHashImage: () => Promise.resolve(null),
    source,
    destination,
  });
}

describe("new-conversation modal prompt-stash source CAS", () => {
  const epicId = "epic-modal-stash-1";
  const seedContent = createEmptyNewConversationContent();
  const workspace = {
    ...emptyLandingDraftWorkspaceSnapshot(),
    folders: ["/tmp/ws"],
    primaryPath: "/tmp/ws",
  };

  beforeEach(() => {
    storeMocks.save.mockReset();
    storeMocks.remove.mockReset();
    storeMocks.hydrate.mockReset();
    storeMocks.hydrate.mockResolvedValue(undefined);
    storeMocks.save.mockResolvedValue(undefined);
    storeMocks.remove.mockResolvedValue(undefined);
    usePromptStashStore.setState({
      rows: [],
    });
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.warning).mockClear();
    vi.mocked(toast.success).mockClear();
    useNewConversationModalStore.getState().resetForTests();
  });

  afterEach(() => {
    cleanup();
    useNewConversationModalStore.getState().resetForTests();
  });

  function seedDraftWithSettings(): void {
    const store = useNewConversationModalStore.getState();
    store.setContent(epicId, textDoc("modal prompt"));
    store.setSelection(epicId, { from: 1, to: 1 });
    store.setSettings(epicId, SEED_SETTINGS);
    store.setComposerMode(epicId, "chat");
    // Workspace is set via addResolvedFolders / setPrimaryFolder; use
    // setState-style merge by writing through setPrimaryFolder with a seed.
    store.setPrimaryFolder(epicId, workspace, "/tmp/ws");
    // Re-assert content after workspace write so we control revision baseline.
    store.setContent(epicId, textDoc("modal prompt"));
  }

  it("keeps newer content when setContent bumps revision during the async gap", () => {
    seedDraftWithSettings();
    const editorRef: { current: ComposerPromptEditorHandle | null } = {
      current: makeEditorHandle(undefined),
    };
    const { result } = renderModalSource({
      epicId,
      seedContent,
      editorRef,
    });

    const snapshot = result.current.capture();
    if (snapshot === null) throw new Error("expected snapshot");
    const capturedRevision = snapshot.token.revision;
    expect(capturedRevision).toBeGreaterThan(0);

    // Keystroke while "save" is in flight.
    useNewConversationModalStore
      .getState()
      .setContent(epicId, textDoc("typed during save"));

    const cleared = result.current.clearIfUnchanged(snapshot.token);
    expect(cleared).toBe(false);

    const patch =
      useNewConversationModalStore.getState().draftPatchesByEpicId[epicId];
    expect(patch?.content).toEqual(textDoc("typed during save"));
    // Non-content fields still intact.
    expect(patch?.settings).toEqual(SEED_SETTINGS);
    expect(patch?.composerMode).toBe("chat");
    expect(patch?.workspace?.primaryPath).toBe("/tmp/ws");
  });

  it("clears content+selection via store fallback when modal closed, without wiping settings/mode/workspace", () => {
    seedDraftWithSettings();
    const before =
      useNewConversationModalStore.getState().draftPatchesByEpicId[epicId];
    expect(before?.settings).toEqual(SEED_SETTINGS);
    expect(before?.composerMode).toBe("chat");
    expect(before?.workspace?.primaryPath).toBe("/tmp/ws");

    // Modal closed: editorRef.current is null / not ready.
    const editorRef: { current: ComposerPromptEditorHandle | null } = {
      current: null,
    };
    const { result } = renderModalSource({
      epicId,
      seedContent,
      editorRef,
    });

    const snapshot = result.current.capture();
    if (snapshot === null) throw new Error("expected snapshot");

    const cleared = result.current.clearIfUnchanged(snapshot.token);
    expect(cleared).toBe(true);

    const after =
      useNewConversationModalStore.getState().draftPatchesByEpicId[epicId];
    expect(after?.content).toEqual(createEmptyNewConversationContent());
    expect(after?.selection).toEqual({ from: 1, to: 1 });
    // Specific fix vs. old clearDraft(epicId): these must survive.
    expect(after?.settings).toEqual(SEED_SETTINGS);
    expect(after?.composerMode).toBe("chat");
    expect(after?.workspace?.primaryPath).toBe("/tmp/ws");
  });

  it("clears via live editor when ready and revision unchanged", () => {
    seedDraftWithSettings();
    const onClear = vi.fn(() => {
      useNewConversationModalStore
        .getState()
        .setContent(epicId, createEmptyNewConversationContent());
      useNewConversationModalStore
        .getState()
        .setSelection(epicId, { from: 1, to: 1 });
    });
    const editorRef: { current: ComposerPromptEditorHandle | null } = {
      current: makeEditorHandle({ onClear }),
    };
    const { result } = renderModalSource({
      epicId,
      seedContent,
      editorRef,
    });

    const snapshot = result.current.capture();
    if (snapshot === null) throw new Error("expected snapshot");
    const cleared = result.current.clearIfUnchanged(snapshot.token);
    expect(cleared).toBe(true);
    expect(onClear).toHaveBeenCalledTimes(1);

    const after =
      useNewConversationModalStore.getState().draftPatchesByEpicId[epicId];
    expect(after?.settings).toEqual(SEED_SETTINGS);
    expect(after?.composerMode).toBe("chat");
  });

  it("delayed save survives close/reopen with an equal numeric revision (retiredRef)", async () => {
    // Modal close deletes the patch entirely (`clearDraft`). Reopen seeds a
    // fresh patch whose revision restarts at 1 for the first real setContent —
    // equal to the capture token's revision. Without retiredRef, the retired
    // hook's clearIfUnchanged would match that ABA pair and wipe the reopen.
    let resolveSave: (() => void) | undefined;
    storeMocks.save.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );

    const original = textDoc("modal prompt before close");
    const reopened = textDoc("modal prompt after reopen");
    useNewConversationModalStore.getState().setContent(epicId, original);
    const captureRevision =
      useNewConversationModalStore.getState().draftPatchesByEpicId[epicId]
        ?.revision;
    expect(captureRevision).toBe(1);

    const editorRef: { current: ComposerPromptEditorHandle | null } = {
      current: makeEditorHandle({ ready: true }),
    };

    const { result, unmount } = renderHook(() =>
      useModalPromptStashController({
        epicId,
        seedContent,
        editorRef,
      }),
    );

    await act(async () => {
      result.current.stashCurrent();
      await Promise.resolve();
    });
    expect(storeMocks.save).toHaveBeenCalledTimes(1);

    // Close: drop the patch and retire the hook instance (modal body unmounts).
    editorRef.current = null;
    unmount();
    useNewConversationModalStore.getState().clearDraft(epicId);
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId[epicId],
    ).toBeUndefined();

    // Reopen same epicId: first setContent lands at revision 1 again (ABA).
    useNewConversationModalStore.getState().setContent(epicId, reopened);
    const reopenedPatch =
      useNewConversationModalStore.getState().draftPatchesByEpicId[epicId];
    expect(reopenedPatch?.revision).toBe(captureRevision);
    expect(reopenedPatch?.content).toEqual(reopened);

    // Remount a fresh hook instance for the reopened modal (does not own the
    // in-flight save — that belongs to the retired instance).
    const reopenEditorRef: { current: ComposerPromptEditorHandle | null } = {
      current: makeEditorHandle({ ready: true }),
    };
    renderHook(() =>
      useModalPromptStashController({
        epicId,
        seedContent,
        editorRef: reopenEditorRef,
      }),
    );

    await act(async () => {
      resolveSave?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const after =
      useNewConversationModalStore.getState().draftPatchesByEpicId[epicId];
    expect(after?.content).toEqual(reopened);
    expect(after?.revision).toBe(captureRevision);
    expect(toast.success).not.toHaveBeenCalled();
  });
});
