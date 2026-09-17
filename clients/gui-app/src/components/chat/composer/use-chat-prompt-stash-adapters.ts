import { useMemo, type RefObject } from "react";

import {
  appendPromptStashContent,
  restorePromptStashAnnotationCrops,
} from "@/lib/composer/prompt-stash-content";
import type {
  PromptStashDestinationAdapter,
  PromptStashDestinationIdentity,
} from "@/lib/composer/prompt-stash-destination";
import type { PromptStashSourceAdapter } from "@/lib/composer/prompt-stash-source";
import {
  readComposerDraftSnapshot,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";

import type { ComposerPromptEditorHandle } from "./composer-prompt-editor";

/**
 * Chat surface prompt-stash source: reads/clears the canonical `taskId`
 * draft in `useComposerDraftStore`. `onCancelQueueEdit` is gated behind the
 * same compare-and-swap as the draft clear - a stale capture must not cancel
 * whatever queue edit is active now (H1).
 */
export function useChatPromptStashSource(
  taskId: string,
  onCancelQueueEdit: (() => void) | null,
): PromptStashSourceAdapter {
  return useMemo<PromptStashSourceAdapter>(
    () => ({
      capture: () => {
        const draft = readComposerDraftSnapshot(taskId);
        return {
          content: draft.content,
          annotations: draft.browserAnnotations,
          token: {
            surface: "chat",
            identity: taskId,
            revision: draft.revision,
          },
        };
      },
      clearIfUnchanged: (token) => {
        const draft = readComposerDraftSnapshot(taskId);
        if (
          token.surface !== "chat" ||
          token.identity !== taskId ||
          token.revision !== draft.revision
        ) {
          return false;
        }
        useComposerDraftStore.getState().clearDraft(taskId);
        onCancelQueueEdit?.();
        return true;
      },
    }),
    [onCancelQueueEdit, taskId],
  );
}

/**
 * Chat surface prompt-stash destination: restore requires the exact ready
 * editor incarnation captured at restore start, and appends against the
 * draft store's latest content at insertion time (not a pre-materialization
 * snapshot). Selection is intentionally reset so the editor applies the
 * replacement with its focus-at-end behavior.
 */
export function useChatPromptStashDestination(
  taskId: string,
  editorRef: RefObject<ComposerPromptEditorHandle | null>,
): PromptStashDestinationAdapter {
  return useMemo<PromptStashDestinationAdapter>(
    () => ({
      captureIdentity: (): PromptStashDestinationIdentity | null => {
        const handle = editorRef.current;
        if (handle === null || !handle.isReady()) return null;
        const editorIncarnation = handle.getEditorIncarnation();
        if (editorIncarnation === null) return null;
        return {
          surface: "chat",
          identity: taskId,
          editorIncarnation,
        };
      },
      importAndInsert: async (args) => {
        const stale = (): boolean => {
          const handle = editorRef.current;
          const editorIncarnation =
            handle !== null && handle.isReady()
              ? handle.getEditorIncarnation()
              : null;
          return (
            args.identity.surface !== "chat" ||
            args.identity.identity !== taskId ||
            handle === null ||
            editorIncarnation === null ||
            args.identity.editorIncarnation !== editorIncarnation
          );
        };
        if (stale()) return { status: "stale" };
        // The crops first, and only then the records that name them: the hook
        // deletes the entry's blobs as soon as this resolves accepted, so this
        // is the last moment those bytes exist anywhere.
        await restorePromptStashAnnotationCrops(args.entry.annotations);
        // Re-checked after the await, because the destination can be switched,
        // remounted or closed while the blobs are read - the same reason the
        // hook re-reads the adapter before calling this at all.
        if (stale()) return { status: "stale" };
        const latest = readComposerDraftSnapshot(taskId);
        const nextContent = appendPromptStashContent(
          latest.content,
          args.content,
        );
        const store = useComposerDraftStore.getState();
        store.replaceDraft(taskId, nextContent, null);
        // Merge semantics, not replace: the user may have attached an
        // annotation of their own while this restore was reading.
        store.restoreBrowserAnnotations(taskId, args.entry.annotations);
        return { status: "accepted" };
      },
    }),
    [editorRef, taskId],
  );
}
