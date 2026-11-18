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
  collectImages,
  useComposerPasteAdapter,
  type ComposerFilePathIngestArgs,
  type HeldFileTransfer,
  type HeldTransferOutcome,
  type ImageAttachmentPlace,
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

function refuseOverCount(): void {
  refuse(
    `A message carries at most ${String(BOT_CONVERSATION_ATTACHMENTS_MAX)} images.`,
  );
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
  if (images.length > room) refuseOverCount();
  return images.slice(0, Math.max(0, room));
}

/**
 * What a box still reading its draft may hold of a drop or a pick (T386),
 * checked as the box checks it before reading a byte: a file of a type a
 * message never carries, a folder among them, gets the box's type refusal,
 * and an image above the source ceiling the preparation's too-large one. File
 * references are held as they are, for the box's own file route to take once
 * it is there; preparation and the prepared-size limit wait for the box too.
 */
export function admitHeldTransfer(
  transfer: HeldFileTransfer,
): HeldFileTransfer {
  const carried = transfer.files.filter((file) => isCarriedType(file.type));
  if (carried.length < transfer.files.length) refuseAsNoImage();
  return {
    files: collectImages(carried, noop),
    fileUrlPaths: transfer.fileUrlPaths,
  };
}

/** The count refusal, for entries a box's hold has no room for. */
export function refuseHeldOverflow(): void {
  refuseOverCount();
}

function noop(): void {}

/** The box's entry for what was dropped or picked on it while it read its draft (T386). */
export interface BotBoxHeldTransferIngest {
  /**
   * Takes `transfer` as a drop of it would be taken, its images after
   * everything the box holds, only while `stillOwned` says the box owns them.
   */
  readonly attachHeldTransfer: (
    transfer: HeldFileTransfer,
    stillOwned: () => boolean,
  ) => Promise<HeldTransferOutcome>;
}

/**
 * Puts into the box's editor, at `at`, the prepared images a message can
 * carry; how many it took.
 */
function placeMessageImages(
  editor: ComposerPromptEditorHandle | null,
  attrs: ReadonlyArray<ImageAttachmentAttrs>,
  at: ImageAttachmentPlace,
): number {
  if (editor === null) return 0;
  const accepted = attrs.filter((image) => {
    if (image.b64content === undefined) {
      refuseAsNoImage();
      return false;
    }
    return validMessageImage(image);
  });
  const taken = takeImages(accepted, editor);
  if (taken.length > 0) editor.insertImageAttachments(taken, at);
  return taken.length;
}

/**
 * The agent composer's paste, drop and pick adapter for a message box: the
 * same preparation and the same size refusal. An image lands in the editor; an
 * image a message cannot carry is refused before it is read, and a file that
 * is no image is refused, where the agent composer would write its path or
 * upload it. Files held for the box while it read its draft land after what
 * it loaded (`attachHeldTransfer`).
 */
export function useBotBoxImageIngest(
  editorRef: RefObject<ComposerPromptEditorHandle | null>,
): UseComposerPasteResult & BotBoxHeldTransferIngest {
  const runnerHost = useRunnerHost();
  const insert = useCallback(
    (attrs: ReadonlyArray<ImageAttachmentAttrs>): number =>
      placeMessageImages(editorRef.current, attrs, "caret"),
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
  const adapter = useComposerPasteAdapter(insert, filePaths, carriedImages);
  const { attachHeldTransfer: attachHeld } = adapter;
  const attachHeldTransfer = useCallback(
    (transfer: HeldFileTransfer, stillOwned: () => boolean) =>
      attachHeld(transfer, {
        insert: (attrs) => placeMessageImages(editorRef.current, attrs, "end"),
        // An editor gone as the batch lands takes none of it: the batch waits
        // for the next box, never counted as landed.
        stillOwned: () => stillOwned() && editorRef.current !== null,
      }),
    [attachHeld, editorRef],
  );
  return { ...adapter, attachFiles: refuseFiles, attachHeldTransfer };
}

function refuseFiles(files: ReadonlyArray<File>): void {
  if (files.length > 0) refuseAsNoImage();
}

/**
 * What the box lets the image adapter read: the images a message can carry.
 * Any other image a paste, a drop or a pick brings is refused here, whatever
 * its size: a picker's `accept` is only a hint the person can lift.
 */
function carriedImages(files: ReadonlyArray<File>): ReadonlyArray<File> {
  const carried = files.filter((file) => isCarriedType(file.type));
  if (carried.length < files.length) refuseAsNoImage();
  return carried;
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
