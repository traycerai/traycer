import { useCallback, useMemo, type RefObject } from "react";
import {
  BOT_CONVERSATION_ATTACHMENT_MEDIA_TYPES,
  BOT_CONVERSATION_ATTACHMENTS_MAX,
  BOT_CONVERSATION_ATTACHMENT_MAX_BYTES,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import type { ImageAttachmentAttrs } from "@/components/chat/composer/editor/extensions/image-attachment-extension";
import type {
  PastedComposerImage,
  PastedComposerImageOutcome,
} from "@/components/chat/composer/editor/extensions/chat-paste-handler";
import {
  useComposerPasteAdapter,
  type ComposerFilePathIngestArgs,
  type UseComposerPasteResult,
} from "@/hooks/composer/use-composer-paste";
import { collectImageAtoms } from "@/lib/composer/image-atoms";
import { base64ToBytes } from "@/lib/composer/image-base64";
import { showImageTooLargeToast } from "@/lib/composer/composer-image-preparation";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import { useRunnerHost } from "@/providers/use-runner-host";

function refuse(title: string): void {
  reportableErrorToast(
    title,
    { id: `bot-composer-refusal:${title}` },
    { title, message: null, code: null, source: "Bot composer" },
  );
}

function refuseAsNoImage(): void {
  refuse("Only PNG, JPEG, GIF and WebP images can be sent here.");
}

function isCarriedType(mimeType: string): boolean {
  return BOT_CONVERSATION_ATTACHMENT_MEDIA_TYPES.some(
    (type) => type === mimeType,
  );
}

function validMessageImage(image: PastedComposerImage): boolean {
  if (!isCarriedType(image.mimeType)) {
    refuseAsNoImage();
    return false;
  }
  // A copied node has not gone through file preparation. Check its decoded
  // payload before it can enter the draft or the 1.4 request.
  if (
    image.b64content.length >
    Math.ceil(BOT_CONVERSATION_ATTACHMENT_MAX_BYTES / 3) * 4
  ) {
    showImageTooLargeToast(image.fileName);
    return false;
  }
  const bytes = base64ToBytes(image.b64content);
  if (bytes === null || bytes.byteLength === 0) {
    refuse("This copied image could not be read.");
    return false;
  }
  if (bytes.byteLength > BOT_CONVERSATION_ATTACHMENT_MAX_BYTES) {
    showImageTooLargeToast(image.fileName);
    return false;
  }
  return true;
}

/**
 * Keeps a message to what it can carry. Read from the editor as each batch
 * lands, because two pastes can be preparing at once.
 */
function takeImages<Image>(
  images: ReadonlyArray<Image>,
  editor: ComposerPromptEditorHandle,
): ReadonlyArray<Image> {
  const room =
    BOT_CONVERSATION_ATTACHMENTS_MAX -
    collectImageAtoms(editor.getJSON()).length;
  if (images.length > room) {
    refuse(
      `A message carries at most ${String(BOT_CONVERSATION_ATTACHMENTS_MAX)} images.`,
    );
  }
  return images.slice(0, Math.max(0, room));
}

/**
 * The agent composer's paste and drop adapter for a message box: the same
 * preparation and the same size refusal. An image lands in the editor; a file
 * that is no image is refused, where the agent composer would write its path.
 */
export function useBotBoxImageIngest(
  editorRef: RefObject<ComposerPromptEditorHandle | null>,
): UseComposerPasteResult {
  const runnerHost = useRunnerHost();
  const insert = useCallback(
    (attrs: ReadonlyArray<ImageAttachmentAttrs>): number => {
      const editor = editorRef.current;
      if (editor === null) return 0;
      const accepted = attrs.filter((image) => {
        if (image.b64content === undefined) {
          refuseAsNoImage();
          return false;
        }
        return validMessageImage(image);
      });
      const taken = takeImages(accepted, editor);
      if (taken.length > 0) editor.insertImageAttachments(taken);
      return taken.length;
    },
    [editorRef],
  );
  const filePaths = useMemo(
    (): ComposerFilePathIngestArgs => ({
      fileDrops: runnerHost.fileDrops,
      mentionRoots: [],
      beginPathInsertion: () => (paths) => {
        if (paths.length > 0) refuseAsNoImage();
        return true;
      },
      // Every resolved file is refused above, so where it would land never
      // matters here.
      pathsReachTarget: true,
    }),
    [runnerHost.fileDrops],
  );
  return useComposerPasteAdapter(insert, filePaths);
}

/**
 * The editor's verdict on image nodes pasted whole (copied from another
 * composer): the box keeps what a message can carry, and none where it takes
 * no images.
 */
export function pastedImagesVerdict(input: {
  readonly takesImages: boolean;
  readonly editor: ComposerPromptEditorHandle | null;
  readonly images: ReadonlyArray<PastedComposerImage>;
}): ReadonlyArray<PastedComposerImageOutcome> {
  const { editor, images, takesImages } = input;
  if (!takesImages || editor === null) {
    return images.map(() => ({ kind: "rejected" }));
  }
  const taken = new Set(takeImages(images.filter(validMessageImage), editor));
  return images.map((image) =>
    taken.has(image)
      ? { kind: "accepted", id: crypto.randomUUID() }
      : { kind: "rejected" },
  );
}
