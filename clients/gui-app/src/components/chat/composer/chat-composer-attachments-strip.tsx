import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  AttachmentStrip,
  NO_SESSION_OBJECT_URL,
} from "@/components/chat/composer/attachments/attachment-strip";
import { QueueEditDraftPill } from "@/components/chat/composer/queue-edit-draft-pill";
import { useChatImageFetcher } from "@/lib/attachments/use-chat-image-fetcher";

interface ChatComposerAttachmentsStripProps {
  readonly content: JsonContent;
  readonly editingQueueItemId: string | null;
  readonly onCancelQueueEdit: (() => void) | null;
  readonly onRemoveImage: (id: string) => void;
}

export function ChatComposerAttachmentsStrip(
  props: ChatComposerAttachmentsStripProps,
) {
  // Chat-plane bytes for hash-only chips, scoped by the surrounding tile's
  // `ChatAttachmentScopeContext` - the same chat the composer posts into.
  const fetcher = useChatImageFetcher();
  return (
    <>
      <QueueEditDraftPill
        editingQueueItemId={props.editingQueueItemId}
        onCancel={props.onCancelQueueEdit}
      />
      <AttachmentStrip
        content={props.content}
        onRemoveImage={props.onRemoveImage}
        fetcher={fetcher}
        sessionObjectUrl={NO_SESSION_OBJECT_URL}
      />
    </>
  );
}
