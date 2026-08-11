import { useMemo, type RefObject } from "react";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { appendPromptStashContent } from "@/lib/composer/prompt-stash-content";
import type {
  PromptStashDestinationAdapter,
  PromptStashDestinationIdentity,
} from "@/lib/composer/prompt-stash-destination";
import type { PromptStashSourceAdapter } from "@/lib/composer/prompt-stash-source";
import {
  createEmptyNewConversationContent,
  useNewConversationModalStore,
} from "@/stores/epics/new-conversation-modal-store";

import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";

/**
 * New-conversation modal prompt-stash source: reads/clears the modal's own
 * per-epic draft patch. Clearing prefers the live editor (keeps Tiptap's own
 * document in sync via its `onUpdate`); the store fallback resets only
 * content + selection, leaving settings/composerMode/workspace intact.
 */
export function useNewConversationPromptStashSource(args: {
  readonly epicId: string;
  readonly seedContent: JsonContent;
  readonly editorRef: RefObject<ComposerPromptEditorHandle | null>;
}): PromptStashSourceAdapter {
  const { epicId, seedContent, editorRef } = args;
  return useMemo<PromptStashSourceAdapter>(
    () => ({
      capture: () => {
        const patch =
          useNewConversationModalStore.getState().draftPatchesByEpicId[epicId];
        return {
          content: patch?.content ?? seedContent,
          token: {
            surface: "new-conversation",
            identity: epicId,
            revision: patch?.revision ?? 0,
          },
        };
      },
      clearIfUnchanged: (token) => {
        const patch =
          useNewConversationModalStore.getState().draftPatchesByEpicId[epicId];
        if (
          token.surface !== "new-conversation" ||
          token.identity !== epicId ||
          token.revision !== (patch?.revision ?? 0)
        ) {
          return false;
        }
        const handle = editorRef.current;
        if (handle !== null && handle.isReady()) {
          handle.clear();
        } else {
          const { setContent, setSelection } =
            useNewConversationModalStore.getState();
          setContent(epicId, createEmptyNewConversationContent());
          setSelection(epicId, { from: 1, to: 1 });
        }
        return true;
      },
    }),
    [editorRef, epicId, seedContent],
  );
}

/**
 * New-conversation modal prompt-stash destination: restore requires the
 * exact ready editor incarnation captured at restore start, and appends
 * against the modal draft's latest content at insertion time. Materialization
 * is owned by the restore hook's default inline-base64 path. Selection is
 * reset so the next edit starts after the inserted prompt.
 */
export function useNewConversationPromptStashDestination(args: {
  readonly epicId: string;
  readonly seedContent: JsonContent;
  readonly editorRef: RefObject<ComposerPromptEditorHandle | null>;
}): PromptStashDestinationAdapter {
  const { epicId, seedContent, editorRef } = args;
  return useMemo<PromptStashDestinationAdapter>(
    () => ({
      captureIdentity: (): PromptStashDestinationIdentity | null => {
        const handle = editorRef.current;
        if (handle === null || !handle.isReady()) return null;
        const editorIncarnation = handle.getEditorIncarnation();
        if (editorIncarnation === null) return null;
        return {
          surface: "new-conversation",
          identity: epicId,
          editorIncarnation,
        };
      },
      importAndInsert: (importArgs) => {
        const handle = editorRef.current;
        const editorIncarnation =
          handle !== null && handle.isReady()
            ? handle.getEditorIncarnation()
            : null;
        if (
          importArgs.identity.surface !== "new-conversation" ||
          importArgs.identity.identity !== epicId ||
          handle === null ||
          editorIncarnation === null ||
          importArgs.identity.editorIncarnation !== editorIncarnation
        ) {
          return Promise.resolve({ status: "stale" });
        }
        const patch =
          useNewConversationModalStore.getState().draftPatchesByEpicId[epicId];
        const latest = patch?.content ?? seedContent;
        const nextContent = appendPromptStashContent(
          latest,
          importArgs.content,
        );
        handle.setContent(nextContent, null);
        return Promise.resolve({ status: "accepted" });
      },
    }),
    [editorRef, epicId, seedContent],
  );
}
