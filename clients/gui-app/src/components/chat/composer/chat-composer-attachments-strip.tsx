import type { RefObject } from "react";
import type { BrowserSandboxCancelPreview } from "./use-browser-sandbox-cancel-install";
import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  AttachmentStrip,
  NO_SESSION_OBJECT_URL,
} from "@/components/chat/composer/attachments/attachment-strip";
import { BrowserAnnotationCard } from "@/components/chat/composer/browser-annotation-card";
import { AppMessageDraftPill } from "@/components/chat/composer/app-message-draft-pill";
import { QueueEditDraftPill } from "@/components/chat/composer/queue-edit-draft-pill";
import { useLandingImageFetcher } from "@/hooks/composer/use-landing-image-fetcher";
import { useChatImageFetcher } from "@/lib/attachments/use-chat-image-fetcher";
import { scheduleLandingImageReconcile } from "@/lib/composer/landing-image-gc";
import { sessionObjectUrl } from "@/lib/composer/landing-image-store";
import type { ScopedImageBytesFetcher } from "@/lib/attachments/image-blob-cache";
import { sniffImageMimeType } from "@/lib/attachments/image-mime-signature";
import { captureDraftAuthorityActor } from "@/lib/drafts/draft-authority-session";
import {
  protectedChatCanvasCaptureIsCurrent,
  readProtectedChatCanvasImages,
} from "@/lib/drafts/protected-chat-canvas-images";
import { captureNativeChatCanvasAssets, useComposerDraftStore } from "@/stores/composer/composer-draft-store";

interface ChatComposerAttachmentsStripProps {
  readonly content: JsonContent;
  readonly taskId: string | null;
  readonly hideAnnotations?: boolean;
  readonly activeCanvasPreview?: boolean;
  readonly cancelPreview?: BrowserSandboxCancelPreview;
  readonly cancelCardsRef?: RefObject<HTMLDivElement | null>;
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
  const ordinaryAnnotations = useComposerDraftStore(
    (state) =>
      (taskId === null || props.hideAnnotations === true
        ? null
        : state.drafts[taskId]?.browserAnnotations) ??
      EMPTY_ANNOTATIONS,
  );
  const preview = props.cancelPreview;
  const browserAnnotations = preview?.snapshot.browserAnnotations ?? ordinaryAnnotations;
  const previewUrl = (digest: string): string | null => preview?.urls.get(digest) ?? null;
  const previewFetcher: ScopedImageBytesFetcher = {
    scopeKey: JSON.stringify(["browser-cancel-preview", preview?.snapshot.returnId]),
    fetch: async (digest, signal) => {
      const blob = preview?.snapshot.bytes.get(digest);
      if (blob === undefined) throw new Error("Draft image is unavailable");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      signal.throwIfAborted();
      return { bytes, mediaType: sniffImageMimeType(bytes) ?? blob.type };
    },
  };
  const actor = captureDraftAuthorityActor();
  const native = taskId !== null && browserAnnotations.some((record) => record.source.kind === "canvas")
    ? captureNativeChatCanvasAssets(taskId, actor)
    : { kind: "ordinary" as const };
  const protectedFetcher: ScopedImageBytesFetcher = {
    scopeKey: JSON.stringify(
      native.kind === "protected" && actor !== null && props.activeCanvasPreview === true
        ? [
            "native-canvas",
            actor.accountId,
            actor.sessionGeneration,
            native.draft,
            native.scope,
            native.sidecarVersion,
          ]
        : ["native-canvas-held", taskId, actor?.sessionGeneration],
    ),
    fetch: async (hash, signal) => {
      if (native.kind !== "protected" || actor === null || props.activeCanvasPreview !== true)
        throw new Error("Draft image is unavailable");
      const assets = await readProtectedChatCanvasImages(actor, native);
      const blob = assets?.get(hash);
      if (blob === undefined) throw new Error("Draft image is unavailable");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      signal.throwIfAborted();
      if (!protectedChatCanvasCaptureIsCurrent(actor, native))
        throw new Error("Draft image is unavailable");
      return { bytes, mediaType: sniffImageMimeType(bytes) ?? blob.type };
    },
  };
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
      {taskId === null ? null : <AppMessageDraftPill chatId={taskId} />}
      <AttachmentStrip
        content={preview?.snapshot.content ?? props.content}
        onRemoveImage={props.onRemoveImage}
        fetcher={preview === undefined ? fetcher : previewFetcher}
        sessionObjectUrl={preview === undefined ? NO_SESSION_OBJECT_URL : previewUrl}
        leadingAttachments={
          browserAnnotations.length > 0 ? (
            <div ref={props.cancelCardsRef} data-testid="browser-annotation-cards" className="contents">
              {browserAnnotations.map((record) => {
                const scoped = record.source.kind === "canvas" && native.kind !== "ordinary";
                let imageFetcher = annotationImageFetcher;
                let getSessionObjectUrl = sessionObjectUrl;
                if (preview !== undefined) {
                  imageFetcher = previewFetcher;
                  getSessionObjectUrl = previewUrl;
                } else if (scoped) {
                  imageFetcher = protectedFetcher;
                  getSessionObjectUrl = NO_SESSION_OBJECT_URL;
                }
                return (
                  <BrowserAnnotationCard
                    key={record.annotationId}
                    record={record}
                    onRemove={preview === undefined ? removeBrowserAnnotation : null}
                    imageFetcher={imageFetcher}
                    sessionObjectUrl={getSessionObjectUrl}
                  />
                );
              })}
            </div>
          ) : undefined
        }
      />
    </>
  );
}

const EMPTY_ANNOTATIONS: readonly never[] = [];
