import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  AttachmentStrip,
  NO_SESSION_OBJECT_URL,
} from "@/components/chat/composer/attachments/attachment-strip";
import { MessageEditDraftPill } from "@/components/chat/composer/message-edit-draft-pill";
import { QueueEditDraftPill } from "@/components/chat/composer/queue-edit-draft-pill";
import { useEpicImageFetcher } from "@/lib/attachments/use-attachment-blob-src";

interface ChatComposerAttachmentsStripProps {
  readonly content: JsonContent;
  readonly editingQueueItemId: string | null;
  readonly onCancelQueueEdit: (() => void) | null;
  readonly messageEditActive: boolean;
  readonly onCancelMessageEdit: () => void;
  readonly onRemoveImage: (id: string) => void;
}

export function ChatComposerAttachmentsStrip(
  props: ChatComposerAttachmentsStripProps,
) {
  const fetcher = useEpicImageFetcher();
  return (
    <>
      <QueueEditDraftPill
        editingQueueItemId={props.editingQueueItemId}
        onCancel={props.onCancelQueueEdit}
      />
      <MessageEditDraftPill
        active={props.messageEditActive}
        onCancel={props.onCancelMessageEdit}
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
