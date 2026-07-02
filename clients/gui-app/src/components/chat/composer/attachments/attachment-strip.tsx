import { useMemo } from "react";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { type ImageBytesFetcher } from "@/lib/attachments/image-blob-cache";
import { collectImageAtoms } from "@/lib/composer/image-atoms";
import { buildImageAttachmentDisplayLabels } from "@/lib/composer/image-attachment-labels";

import { ImageAttachmentChip } from "./image-attachment-chip";

export interface AttachmentStripProps {
  content: JsonContent;
  onRemoveImage: (id: string) => void;
  /** Byte source for hash-only chips (epic doc for chat, IndexedDB for landing). */
  fetcher: ImageBytesFetcher;
  /** Same-session synchronous object-URL lookup; chat passes a no-op. */
  sessionObjectUrl: (hash: string) => string | null;
}

export function AttachmentStrip(props: AttachmentStripProps) {
  const { content, onRemoveImage, fetcher, sessionObjectUrl } = props;
  const atoms = useMemo(() => collectImageAtoms(content), [content]);
  const labelsByImageId = useMemo(
    () => buildImageAttachmentDisplayLabels(atoms),
    [atoms],
  );
  if (atoms.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-1 pb-2">
      {atoms.map((atom) => (
        <ImageAttachmentChip
          key={atom.id}
          atom={atom}
          displayLabel={labelsByImageId.get(atom.id)}
          onRemove={onRemoveImage}
          fetcher={fetcher}
          sessionObjectUrl={sessionObjectUrl}
        />
      ))}
    </div>
  );
}

/** Shared stable no-op for surfaces with no same-session object-URL cache. */
export const NO_SESSION_OBJECT_URL = (): string | null => null;
