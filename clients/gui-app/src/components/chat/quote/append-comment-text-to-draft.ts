import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  readComposerDraftSnapshot,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";
import {
  createEmptyNewConversationContent,
  useNewConversationModalStore,
} from "@/stores/epics/new-conversation-modal-store";

import { appendBlocks } from "./append-quote-to-draft";

/**
 * The paragraphs a comment draft becomes in a chat composer. The two editors
 * share Tiptap but not a schema: the comment box's `@` chips name
 * collaborators, which mean nothing to an agent, and its lists have no chat
 * counterpart worth preserving. So each block flattens to the text a reader
 * saw, one paragraph per block, and an empty draft yields nothing.
 */
export function commentDraftParagraphs(
  doc: JsonContent,
): ReadonlyArray<JsonContent> {
  return (doc.content ?? [])
    .flatMap(flattenToLines)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => ({
      type: "paragraph",
      content: [{ type: "text", text: line }],
    }));
}

function flattenToLines(node: JsonContent): ReadonlyArray<string> {
  if (node.type === "paragraph" || node.type === "heading")
    return [inlineText(node)];
  if (node.type === "text") return [node.text ?? ""];
  return (node.content ?? []).flatMap(flattenToLines);
}

function inlineText(node: JsonContent): string {
  return (node.content ?? [])
    .map((child) => {
      if (child.type === "text") return child.text ?? "";
      if (child.type === "mention") return `@${mentionLabel(child)}`;
      if (child.type === "hardBreak") return "\n";
      return inlineText(child);
    })
    .join("");
}

function mentionLabel(node: JsonContent): string {
  const attrs: Record<string, unknown> = { ...node.attrs };
  const label = attrs.label;
  if (typeof label === "string" && label.length > 0) return label;
  const id = attrs.id;
  return typeof id === "string" ? id : "";
}

/**
 * Appends a comment draft's text to a chat's composer draft, below anything
 * already typed there with a blank line between, so nothing the user drafted
 * is lost and the moved text reads as its own paragraph. Never sends. An
 * empty draft leaves the composer untouched: the card alone is the message.
 */
export function appendCommentTextToDraft(
  chatId: string,
  commentDraft: JsonContent,
): void {
  const paragraphs = commentDraftParagraphs(commentDraft);
  if (paragraphs.length === 0) return;
  const draft = readComposerDraftSnapshot(chatId);
  useComposerDraftStore
    .getState()
    .replaceDraft(chatId, appendBelow(draft.content, paragraphs), null);
}

/**
 * The same append, into the new-conversation modal's per-epic draft: the
 * text half of a draft sent to a chat that does not exist yet. Written before
 * the modal opens, since its composer seeds itself from this store on mount.
 */
export function appendCommentTextToNewConversationDraft(
  epicId: string,
  commentDraft: JsonContent,
): void {
  const paragraphs = commentDraftParagraphs(commentDraft);
  if (paragraphs.length === 0) return;
  const store = useNewConversationModalStore.getState();
  const current =
    store.draftPatchesByEpicId[epicId]?.content ??
    createEmptyNewConversationContent();
  store.setContent(epicId, appendBelow(current, paragraphs));
  store.clearSelection(epicId);
}

/** Below anything already typed, with a blank line between. */
function appendBelow(
  content: JsonContent,
  paragraphs: ReadonlyArray<JsonContent>,
): JsonContent {
  const existing = (content.content ?? []).filter(
    (block) => !(block.type === "paragraph" && (block.content ?? []).length === 0),
  );
  const separator: ReadonlyArray<JsonContent> =
    existing.length === 0 ? [] : [{ type: "paragraph" }];
  return appendBlocks(content, [...separator, ...paragraphs]);
}
