import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  AttachmentStrip,
  NO_SESSION_OBJECT_URL,
} from "@/components/chat/composer/attachments/attachment-strip";
import { BrowserAnnotationCard } from "@/components/chat/composer/browser-annotation-card";
import { QueueEditDraftPill } from "@/components/chat/composer/queue-edit-draft-pill";
import { useLandingImageFetcher } from "@/hooks/composer/use-landing-image-fetcher";
import { useChatImageFetcher } from "@/lib/attachments/use-chat-image-fetcher";
import { scheduleLandingImageReconcile } from "@/lib/composer/landing-image-gc";
import { sessionObjectUrl } from "@/lib/composer/landing-image-store";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";

interface ChatComposerAttachmentsStripProps {
  readonly content: JsonContent;
  readonly taskId: string | null;
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
  const annotationImageFetcher = useLandingImageFetcher();
  const taskId = props.taskId;
  const browserAnnotations = useComposerDraftStore(
    (state) =>
      (taskId === null ? null : state.drafts[taskId]?.browserAnnotations) ??
      EMPTY_ANNOTATIONS,
  );
  const removeBrowserAnnotation = (annotationId: string) => {
    if (taskId === null) return;
    useComposerDraftStore
      .getState()
      .removeBrowserAnnotation(taskId, annotationId);
    scheduleLandingImageReconcile();
  };
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
        leadingAttachments={
          browserAnnotations.length > 0 ? (
            <div data-testid="browser-annotation-cards" className="contents">
              {browserAnnotations.map((record) => (
                <BrowserAnnotationCard
                  key={record.annotationId}
                  record={record}
                  onRemove={removeBrowserAnnotation}
                  imageFetcher={annotationImageFetcher}
                  sessionObjectUrl={sessionObjectUrl}
                />
              ))}
            </div>
          ) : undefined
        }
      />
    </>
  );
}

const EMPTY_ANNOTATIONS: readonly never[] = [];
