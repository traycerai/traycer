import type { JsonContent } from "@traycer/protocol/common/registry";

import { epicFileName } from "@/lib/epic-files/file-rows";
import {
  createEmptyNewConversationContent,
  useNewConversationModalStore,
} from "@/stores/epics/new-conversation-modal-store";

import { appendBlocks } from "./append-quote-to-draft";

/**
 * The epic path, as ONE line of plain text in the draft.
 *
 * It used to be markdown - `![name](files/...)` for an image, `[name](...)`
 * otherwise - on the reading that the host resolves such a target into
 * `fileResolutions[]` at message time. It does not, for a USER message: user
 * messages are never markdown-rendered, and `fileResolutions` are computed for
 * ASSISTANT messages only. So what the user actually saw in their own composer
 * was the raw string `![2026-...-9cb544e8.png](files/screenshots/...)`.
 *
 * Plain text says the same thing to the agent - the path is epic-root-relative,
 * so it means the same file on whichever host serves the chat, and an agent
 * that wants the bytes reads them off `files/` (D13) - without pretending to be
 * a rendering the surface does not do.
 */
export function buildEpicFilePathBlock(path: string): JsonContent {
  return {
    type: "paragraph",
    content: [{ type: "text", text: path }],
  };
}

/**
 * The composer's own image node, built from bytes rather than pasted.
 *
 * `b64content` is the shape chat / new-conversation paste produces - the host
 * ingests and hashes it at send time - so an epic-file image attached here is
 * indistinguishable downstream from one the user dropped in: the composer shows
 * a thumbnail, and the agent receives an ordinary image attachment (D28 keeps
 * chat images on the chat plane).
 *
 * `imageAttachment` is an INLINE atom, so it rides inside a paragraph; a
 * top-level node would not satisfy the editor's schema.
 */
function buildEpicFileImageBlock(args: {
  readonly path: string;
  readonly mediaType: string;
  readonly b64content: string;
  readonly byteLength: number;
}): JsonContent {
  return {
    type: "paragraph",
    content: [
      {
        type: "imageAttachment",
        attrs: {
          id: `epic-file:${args.path}`,
          fileName: epicFileName(args.path),
          mimeType: args.mediaType,
          size: args.byteLength,
          b64content: args.b64content,
        },
      },
    ],
  };
}

/**
 * Appends blocks to the epic's NEW-conversation draft and nothing else - the
 * modal's own body seeds its composer from this store as it mounts, so the
 * write has to land BEFORE the open request.
 *
 * Why the new-conversation draft rather than "the current chat": a browser tile
 * has no chat of its own, and the canvas has no notion of a chat the user is
 * "in" while a browser tile is the active tile (the active-pane walk returns
 * the browser tile itself). Guessing one would attach a capture to whichever
 * chat happened to be last - so the user picks instead, in a composer that is
 * already carrying the reference. Nothing is created until they send.
 */
function appendToNewConversationDraft(
  epicId: string,
  blocks: ReadonlyArray<JsonContent>,
): void {
  const store = useNewConversationModalStore.getState();
  const current =
    store.draftPatchesByEpicId[epicId]?.content ??
    createEmptyNewConversationContent();
  store.setContent(epicId, appendBlocks(current, blocks));
  store.clearSelection(epicId);
}

/** Path only - what a non-image epic file (a recording, a log) degrades to. */
export function appendEpicFileToNewConversationDraft(args: {
  readonly epicId: string;
  readonly path: string;
}): void {
  appendToNewConversationDraft(args.epicId, [
    buildEpicFilePathBlock(args.path),
  ]);
}

/**
 * An image epic file: the bytes as an ordinary composer attachment, PLUS the
 * path.
 *
 * Both, not either. The attachment is what the user sees and what the model
 * gets as an image; the path line is what lets the agent `cat` (or re-read at
 * full resolution) the original object on disk, which an inlined attachment
 * cannot express.
 */
export function appendEpicFileImageToNewConversationDraft(args: {
  readonly epicId: string;
  readonly path: string;
  readonly mediaType: string;
  readonly b64content: string;
  readonly byteLength: number;
}): void {
  appendToNewConversationDraft(args.epicId, [
    buildEpicFileImageBlock(args),
    buildEpicFilePathBlock(args.path),
  ]);
}
