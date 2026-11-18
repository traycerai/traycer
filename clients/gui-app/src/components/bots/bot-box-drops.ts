import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type DragEvent,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { BOT_CONVERSATION_ATTACHMENT_MEDIA_TYPES } from "@traycer/protocol/host/bot/conversation-schemas";
import { DROP_WITHOUT_IMAGE_HOST } from "@/components/bots/bot-drop-lines";
import {
  REFUSING_DROP_ZONE_PROPS,
  type ComposerDropTarget,
} from "@/components/chat/composer/composer-drop-scope";
import type { BotBoxHeldTransferIngest } from "@/hooks/bots/use-bot-box-images";
import { useComposerAttachPicker } from "@/hooks/composer/use-composer-attach-picker";
import {
  dragIsInZone,
  useComposerDragAffordance,
  type HeldFileTransfer,
} from "@/hooks/composer/use-composer-paste";
import type { ComposerEditorIncarnation } from "@/lib/composer/composer-editor-incarnation";
import {
  collectFileTransferEntries,
  hasClaimableFileTransfer,
} from "@/lib/files/file-transfer-paths";
import type { BotHeldDrop } from "@/stores/bots/bot-drafts-store";

/** The platform picker offers only the images a message can carry. */
export const BOX_PICKER_ACCEPT =
  BOT_CONVERSATION_ATTACHMENT_MEDIA_TYPES.join(",");

/** One id for what a pane says about files dropped on it, so a second drop replaces the first's notice. */
export function botDropNoticeId(botId: string, key: string): string {
  return `bot-drop:${botId}:${key}`;
}

/** A held batch a box took, while it prepares and inserts it (T386). */
export interface BotHeldDropClaim {
  readonly transfer: HeldFileTransfer;
  /**
   * Whether the batch is still held under this take: the account and the bot
   * as they were, and the batch neither settled nor released since.
   */
  readonly holds: () => boolean;
  /** It landed or was refused: it is held no more. */
  readonly settle: () => void;
  /** None of it landed: it waits, first, for the next take. */
  readonly release: () => void;
}

/**
 * What a box holds of the files dropped or picked on it while it read its
 * draft's images (T386, `boxDrops`), for its editor to take once it is
 * there.
 */
export interface BotBoxHold {
  /** The held batches, in drop order. */
  readonly batches: ReadonlyArray<BotHeldDrop>;
  /**
   * Starts a drop or a pick under the account and the bot as they are now.
   * What it returns holds that gesture's entries, as the box would admit
   * them, and takes nothing once either has changed.
   */
  readonly begin: () => (transfer: HeldFileTransfer) => void;
  /** Takes the first batch, where nothing holds it. */
  readonly claim: () => BotHeldDropClaim | null;
  /** The id the pane's notices about drops go under. */
  readonly noticeId: string;
}

/**
 * A pane's target that takes no files: a file dropped is refused as the zone
 * with no box refuses it, with `notice` said under `noticeId`. A dragged file
 * shows no overlay, and a link or text is left alone.
 */
export function refusingDropTarget(
  notice: string,
  noticeId: string,
): ComposerDropTarget {
  return {
    ...REFUSING_DROP_ZONE_PROPS,
    onDrop: (event) => {
      REFUSING_DROP_ZONE_PROPS.onDrop(event);
      if (!dragIsInZone(event.currentTarget, event.target)) return;
      if (!hasClaimableFileTransfer(event.dataTransfer)) return;
      toast.info(notice, { id: noticeId });
    },
    overlayVariant: null,
  };
}

/**
 * A box still reading its draft's images, as a drop target: a file dragged
 * over it shows the overlay the box would, and a dropped file or file
 * reference is held for the box (`hold`). Where the bot's host takes no
 * images, it refuses as the box does.
 */
export function useHoldingDropTarget(
  hold: BotBoxHold,
  takesImages: boolean,
): ComposerDropTarget {
  const drag = useComposerDragAffordance();
  const { begin, noticeId } = hold;
  const { endDrag } = drag;
  const onDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!dragIsInZone(event.currentTarget, event.target)) return;
      endDrag();
      if (!hasClaimableFileTransfer(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      // Taken at the event: the transfer is empty once it returns.
      const { files, fileUrlPaths } = collectFileTransferEntries(
        event.dataTransfer,
      );
      begin()({ files, fileUrlPaths });
    },
    [begin, endDrag],
  );
  return useMemo(
    () =>
      takesImages
        ? {
            onDragEnter: drag.onDragEnter,
            onDragLeave: drag.onDragLeave,
            onDragOver: drag.onDragOver,
            onDrop,
            overlayVariant: drag.overlayVariant,
          }
        : refusingDropTarget(DROP_WITHOUT_IMAGE_HOST, noticeId),
    [
      drag.onDragEnter,
      drag.onDragLeave,
      drag.onDragOver,
      drag.overlayVariant,
      noticeId,
      onDrop,
      takesImages,
    ],
  );
}

/**
 * The hidden file input of a box's slot, which draws either the box or its
 * reading view, and the function that opens it: so a pick made while the
 * draft was read still lands once the box replaced the reading view. Its
 * selection is held under the authority taken when it opened.
 */
export function useHeldDropPicker(hold: BotBoxHold | null): {
  readonly input: ReactNode;
  readonly open: () => void;
} {
  const takeRef = useRef<((transfer: HeldFileTransfer) => void) | null>(null);
  const take = useCallback((files: ReadonlyArray<File>) => {
    takeRef.current?.({ files, fileUrlPaths: [] });
  }, []);
  const picker = useComposerAttachPicker({
    accept: BOX_PICKER_ACCEPT,
    onAttachImages: take,
    onAttachFiles: take,
  });
  const begin = hold?.begin ?? null;
  const { open: openPicker } = picker;
  const open = useCallback(() => {
    if (begin === null) return;
    takeRef.current = begin();
    openPicker();
  }, [begin, openPicker]);
  return { input: picker.input, open };
}

/**
 * A box takes what is held for it into its editor, one batch at a time and
 * in drop order, once the editor is there and holds what the box loaded
 * (`ready`): it watches the hold for as long as it is mounted, so a batch
 * held later is taken too. A batch lands only while the box still holds it
 * and is mounted; one that does not land waits for the next box. Where the
 * bot's host takes no images, each batch is refused as a drop would be.
 */
export function useHeldDropDrain(args: {
  readonly hold: BotBoxHold | null;
  /**
   * The editor that took the box's load, `null` until one has: the drain
   * runs again each time a new one has.
   */
  readonly loadedEditor: ComposerEditorIncarnation | null;
  /** Whether that editor is the one in the box now. */
  readonly holdsLoad: () => boolean;
  readonly takesImages: boolean;
  readonly attachHeldTransfer: BotBoxHeldTransferIngest["attachHeldTransfer"];
}): void {
  const { hold, loadedEditor, holdsLoad, takesImages, attachHeldTransfer } =
    args;
  // Read as a batch lands: a host that stops taking images while a batch
  // prepares takes none of it, and the batch is refused as the next one is.
  const takesImagesRef = useRef(takesImages);
  useLayoutEffect(() => {
    takesImagesRef.current = takesImages;
  }, [takesImages]);
  useEffect(() => {
    // An editor gone, as a call takes the field, or not yet holding the
    // box's load takes nothing: the batch waits for the one that comes back.
    if (
      loadedEditor === null ||
      hold === null ||
      hold.batches.length === 0 ||
      !holdsLoad()
    ) {
      return;
    }
    const taken = hold.claim();
    if (taken === null) return;
    if (!takesImages) {
      taken.settle();
      toast.info(DROP_WITHOUT_IMAGE_HOST, { id: hold.noticeId });
      return;
    }
    void attachHeldTransfer(
      taken.transfer,
      () => taken.holds() && holdsLoad() && takesImagesRef.current,
    ).then((outcome) => {
      if (outcome === "settled") taken.settle();
      else taken.release();
    });
  }, [attachHeldTransfer, hold, holdsLoad, loadedEditor, takesImages]);
}
