import type { JsonContent } from "@traycer/protocol/common/registry";
import type { EpicArtifactKind } from "@traycer/protocol/common/registry";
import { epicArtifactMentionToken } from "@traycer/protocol/host/epic/unary-schemas";

import { mentionAttrsFromAttachment } from "@/lib/composer/tiptap-json-content";
import type { EntityMentionAttachment } from "@/lib/composer/types";
import {
  readComposerDraftSnapshot,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";
import {
  createEmptyNewConversationContent,
  useNewConversationModalStore,
} from "@/stores/epics/new-conversation-modal-store";

import { appendBlocks } from "./append-quote-to-draft";

export interface ArtifactQuote {
  readonly epicId: string;
  readonly artifactId: string;
  readonly artifactKind: EpicArtifactKind;
  /** Artifact title, as the sidebar and the mention picker both show it. */
  readonly artifactTitle: string;
  /** Ticket/story status code, `null` for kinds that have none. */
  readonly artifactStatus: number | null;
  /**
   * The excerpt, already shaped for the composer schema: paragraphs per line,
   * or one `codeBlock` for a selection wholly inside a code block. Frozen when
   * the user clicked Send to chat, not when they picked a target - the
   * artifact is collaborative and may have changed in between.
   */
  readonly blocks: ReadonlyArray<JsonContent>;
}

/**
 * The two blocks an artifact quote adds to a chat draft:
 *
 * 1. a `sourcedQuote` wrapping the excerpt - which the protocol serializer
 *    renders as `<quoted_artifact artifact_type=… artifact_id=… epic_id=…>`, the
 *    tag that node was built for;
 * 2. a paragraph holding the artifact's mention chip - the same pointer the
 *    `@`-picker inserts, which the host resolves to the artifact's `index.md`
 *    path, so the agent can open the file and find the excerpt in it.
 *
 * The chip follows the quote rather than leading it because the quote is what
 * the user selected and the chip is the citation for it.
 */
export function buildArtifactQuoteBlocks(
  quote: ArtifactQuote,
): ReadonlyArray<JsonContent> {
  return [
    {
      type: "sourcedQuote",
      attrs: {
        sourceType: quote.artifactKind,
        sourceId: quote.artifactId,
        sourceEpicId: quote.epicId,
      },
      content: [...quote.blocks],
    },
    {
      type: "paragraph",
      content: [
        {
          type: "mention",
          attrs: mentionAttrsFromAttachment(artifactMention(quote)),
        },
        { type: "text", text: " " },
      ],
    },
  ];
}

/**
 * Appends an artifact quote to a chat's composer draft. Never replaces the
 * draft and never sends: the user reviews and submits. See
 * `appendTerminalQuoteToDraft` for why the store bump is enough to land the
 * caret after the chip.
 */
export function appendArtifactQuoteToDraft(
  chatId: string,
  quote: ArtifactQuote,
): void {
  const draft = readComposerDraftSnapshot(chatId);
  const next = appendBlocks(draft.content, buildArtifactQuoteBlocks(quote));
  useComposerDraftStore.getState().replaceDraft(chatId, next, null);
}

/**
 * The same two blocks, appended to the new-conversation modal's per-epic draft
 * - the quote path for a chat that does not exist yet. Must be written BEFORE
 * the open request or the composer opens empty; the caret is dropped so the
 * composer's `autofocus: "end"` lands after the chip.
 */
export function appendArtifactQuoteToNewConversationDraft(
  quote: ArtifactQuote,
): void {
  const store = useNewConversationModalStore.getState();
  const current =
    store.draftPatchesByEpicId[quote.epicId]?.content ??
    createEmptyNewConversationContent();
  store.setContent(
    quote.epicId,
    appendBlocks(current, buildArtifactQuoteBlocks(quote)),
  );
  store.clearSelection(quote.epicId);
}

function artifactMention(quote: ArtifactQuote): EntityMentionAttachment {
  return {
    kind: "mention",
    contextType: quote.artifactKind,
    // Same token the picker builds, so a quoted reference and a typed one are
    // indistinguishable downstream.
    path: epicArtifactMentionToken(
      quote.artifactKind,
      quote.epicId,
      quote.artifactId,
    ),
    pathKind: null,
    relPath: null,
    absolutePath: null,
    workspacePath: null,
    label: quote.artifactTitle,
    description: "",
    epicId: quote.epicId,
    artifactId: quote.artifactId,
    artifactType: quote.artifactKind,
    chatId: null,
    terminalAgentId: null,
    terminalId: null,
    status: quote.artifactStatus,
  };
}
