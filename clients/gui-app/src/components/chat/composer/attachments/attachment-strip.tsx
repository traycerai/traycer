import { useMemo, useRef, useState, type ReactNode } from "react";
import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  ExpandedImageDialogContent,
  type ImageSetViewerState,
} from "@/components/chat/expanded-image-dialog";
import { Dialog } from "@/components/ui/dialog";
import { type ScopedImageBytesFetcher } from "@/lib/attachments/image-blob-cache";
import { collectImageAtoms } from "@/lib/composer/image-atoms";
import {
  buildImageAttachmentDisplayLabels,
  fallbackImageAttachmentDisplayLabel,
} from "@/lib/composer/image-attachment-labels";

import {
  ExpandedComposerImage,
  ImageAttachmentChip,
} from "./image-attachment-chip";

export interface AttachmentStripProps {
  content: JsonContent;
  onRemoveImage: (id: string) => void;
  /**
   * Byte source for hash-only chips (epic doc for chat, IndexedDB for landing),
   * bundled with the subject its bytes are authorized against - the blob cache
   * keys on both, so a bare function is deliberately not accepted here.
   */
  fetcher: ScopedImageBytesFetcher;
  /** Same-session synchronous object-URL lookup; chat passes a no-op. */
  sessionObjectUrl: (hash: string) => string | null;
  /** Non-image chips sharing the same one-row scroller. */
  leadingAttachments?: ReactNode;
}

export function AttachmentStrip(props: AttachmentStripProps) {
  const { content, onRemoveImage, fetcher, sessionObjectUrl } = props;
  const atoms = useMemo(() => collectImageAtoms(content), [content]);
  const labelsByImageId = useMemo(
    () => buildImageAttachmentDisplayLabels(atoms),
    [atoms],
  );
  const [viewer, setViewer] = useState<ImageSetViewerState>({
    open: false,
    index: 0,
  });
  const stripRef = useRef<HTMLDivElement>(null);
  if (atoms.length === 0 && props.leadingAttachments === undefined) return null;
  const shown = atoms.at(viewer.index);
  return (
    <Dialog
      open={viewer.open}
      onOpenChange={(open) => setViewer((current) => ({ ...current, open }))}
    >
      <div
        ref={stripRef}
        data-composer-attachment-strip=""
        className="min-w-0 flex-1 overflow-x-auto overscroll-x-contain"
      >
        <div className="flex w-max gap-2">
          {props.leadingAttachments}
          {atoms.map((atom, index) => (
            <ImageAttachmentChip
              key={atom.id}
              atom={atom}
              displayLabel={labelsByImageId.get(atom.id)}
              onRemove={onRemoveImage}
              onOpen={() => setViewer({ open: true, index })}
              fetcher={fetcher}
              sessionObjectUrl={sessionObjectUrl}
            />
          ))}
        </div>
      </div>
      {shown === undefined ? null : (
        <ExpandedImageDialogContent
          title={
            (
              labelsByImageId.get(shown.id) ??
              fallbackImageAttachmentDisplayLabel({
                id: shown.id,
                fileName: shown.fileName,
              })
            ).title
          }
          navigation={{
            index: viewer.index,
            count: atoms.length,
            onNavigate: (index) => setViewer({ open: true, index }),
          }}
          // Closing the viewer hands the caret back to the draft.
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            stripRef.current
              ?.closest<HTMLElement>("[data-composer-shell]")
              ?.querySelector<HTMLElement>("[data-composer-editor]")
              ?.focus();
          }}
        >
          {/* Keyed so each image opens fitted, never at its neighbour's zoom. */}
          <ExpandedComposerImage
            key={shown.id}
            atom={shown}
            fetcher={fetcher}
            sessionObjectUrl={sessionObjectUrl}
          />
        </ExpandedImageDialogContent>
      )}
    </Dialog>
  );
}

/** Shared stable no-op for surfaces with no same-session object-URL cache. */
export const NO_SESSION_OBJECT_URL = (): string | null => null;
