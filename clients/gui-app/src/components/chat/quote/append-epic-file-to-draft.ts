import type { JsonContent } from "@traycer/protocol/common/registry";

import { epicFileName } from "@/lib/epic-files/file-rows";
import {
  createEmptyNewConversationContent,
  useNewConversationModalStore,
} from "@/stores/epics/new-conversation-modal-store";

import { appendBlocks } from "./append-quote-to-draft";

/**
 * Seeds a chat draft with a reference to one epic file (D28).
 *
 * The reference is ORDINARY MARKDOWN whose target is the manifest path - the
 * same shape an agent writes, and the same shape the host resolves at message
 * time into `fileResolutions[]`. Nothing about the bytes travels: the path is
 * epic-root-relative, so it means the same thing to whichever host serves the
 * chat, and an agent that wants the bytes reads them off `files/` (D13).
 *
 * A screenshot is an image, so the `!` prefix is right for it; a caller
 * embedding something that is not renderable passes `image: false` and gets a
 * plain link, which is what an unrenderable target should degrade to.
 */
export function buildEpicFileMarkdownBlock(args: {
  readonly path: string;
  readonly image: boolean;
}): JsonContent {
  const marker = args.image ? "!" : "";
  return {
    type: "paragraph",
    content: [
      {
        type: "text",
        text: `${marker}[${epicFileName(args.path)}](${args.path}) `,
      },
    ],
  };
}

/**
 * Appends that reference to the epic's NEW-conversation draft and nothing
 * else - the modal's own body seeds its composer from this store as it mounts,
 * so the write has to land before the open request.
 *
 * Why the new-conversation draft rather than "the current chat": a browser tile
 * has no chat of its own, and the canvas has no notion of a chat the user is
 * "in" while a browser tile is the active tile (the active-pane walk returns
 * the browser tile itself). Guessing one would attach a capture to whichever
 * chat happened to be last - so the user picks instead, in a composer that is
 * already carrying the reference. Nothing is created until they send.
 */
export function appendEpicFileToNewConversationDraft(args: {
  readonly epicId: string;
  readonly path: string;
  readonly image: boolean;
}): void {
  const store = useNewConversationModalStore.getState();
  const current =
    store.draftPatchesByEpicId[args.epicId]?.content ??
    createEmptyNewConversationContent();
  store.setContent(
    args.epicId,
    appendBlocks(current, [
      buildEpicFileMarkdownBlock({ path: args.path, image: args.image }),
    ]),
  );
  store.clearSelection(args.epicId);
}
