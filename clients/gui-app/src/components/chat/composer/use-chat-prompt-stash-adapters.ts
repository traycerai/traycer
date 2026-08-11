import { useMemo, type RefObject } from "react";

import { appendPromptStashContent } from "@/lib/composer/prompt-stash-content";
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
      importAndInsert: (args) => {
        const handle = editorRef.current;
        const editorIncarnation =
          handle !== null && handle.isReady()
            ? handle.getEditorIncarnation()
            : null;
        if (
          args.identity.surface !== "chat" ||
          args.identity.identity !== taskId ||
          handle === null ||
          editorIncarnation === null ||
          args.identity.editorIncarnation !== editorIncarnation
        ) {
          return Promise.resolve({ status: "stale" });
        }
        const latest = readComposerDraftSnapshot(taskId);
        const nextContent = appendPromptStashContent(
          latest.content,
          args.content,
        );
        useComposerDraftStore
          .getState()
          .replaceDraft(taskId, nextContent, null);
        return Promise.resolve({ status: "accepted" });
      },
    }),
    [editorRef, taskId],
  );
}
