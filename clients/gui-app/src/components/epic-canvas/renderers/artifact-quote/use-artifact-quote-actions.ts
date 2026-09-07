import { useCallback } from "react";
import type { EpicArtifactKind } from "@traycer/protocol/common/registry";

import {
  appendArtifactQuoteToDraft,
  appendArtifactQuoteToNewConversationDraft,
  type ArtifactQuote,
} from "@/components/chat/quote/append-artifact-quote-to-draft";
import { useRevealChatInTab } from "@/components/epic-canvas/renderers/use-reveal-chat-in-tab";
import { ACTIVE_TILE_PLACEMENT } from "@/lib/canvas/conversation-tile-placement";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";

import type { ArtifactQuoteSnapshot } from "./artifact-quote-snapshot";

interface UseArtifactQuoteActionsArgs {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly artifactId: string;
  readonly artifactKind: EpicArtifactKind;
}

export interface ArtifactQuoteActions {
  /** Quotes into an existing chat, then brings that chat forward. */
  readonly quoteToChat: (
    chatId: string,
    snapshot: ArtifactQuoteSnapshot,
  ) => void;
  /**
   * Opens the New Conversation modal with the quote already in its composer.
   * Nothing is created until the user sends.
   */
  readonly quoteToNewChat: (snapshot: ArtifactQuoteSnapshot) => void;
}

/**
 * Sends a frozen artifact excerpt into a chat's composer draft and puts that
 * chat in front of the user. Never submits.
 *
 * The artifact's title and status are read at send time from the open-epic
 * projection: the chip is a citation of the artifact as it is now, and the
 * title may have changed since the tile was opened.
 */
export function useArtifactQuoteActions(
  args: UseArtifactQuoteActionsArgs,
): ArtifactQuoteActions {
  const { epicId, viewTabId, artifactId, artifactKind } = args;
  const handle = useOpenEpicHandle();
  const openNewConversationModal = useNewConversationModalOpenStore(
    (state) => state.open,
  );
  const revealChat = useRevealChatInTab({ epicId, viewTabId });

  const buildQuote = useCallback(
    (snapshot: ArtifactQuoteSnapshot): ArtifactQuote => {
      const artifacts = handle.store.getState().artifacts;
      const artifact = Object.hasOwn(artifacts.byId, artifactId)
        ? artifacts.byId[artifactId]
        : null;
      return {
        epicId,
        artifactId,
        artifactKind,
        artifactTitle: artifact?.title ?? "Untitled",
        artifactStatus: artifact?.status ?? null,
        blocks: snapshot.blocks,
      };
    },
    [artifactId, artifactKind, epicId, handle],
  );

  const quoteToChat = useCallback(
    (chatId: string, snapshot: ArtifactQuoteSnapshot) => {
      // Draft first: a composer that is not mounted yet reads this as its
      // initial content, and one that is already mounted syncs and focuses on
      // the store bump. Either way the quote is there before the tile lands.
      appendArtifactQuoteToDraft(chatId, buildQuote(snapshot));
      revealChat(chatId);
    },
    [buildQuote, revealChat],
  );

  const quoteToNewChat = useCallback(
    (snapshot: ArtifactQuoteSnapshot) => {
      appendArtifactQuoteToNewConversationDraft(buildQuote(snapshot));
      openNewConversationModal({
        epicId,
        tabId: viewTabId,
        placement: ACTIVE_TILE_PLACEMENT,
        parentId: null,
        // An artifact does not live on one machine - its file is projected onto
        // every host serving the epic - so the new chat gets the epic's normal
        // placement rather than a named host. Only a source that exists on
        // exactly one host (a terminal) names one.
        hostId: null,
      });
    },
    [buildQuote, epicId, openNewConversationModal, viewTabId],
  );

  return { quoteToChat, quoteToNewChat };
}
