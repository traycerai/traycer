import { useDroppable } from "@dnd-kit/core";
import { Paperclip } from "lucide-react";
import { useId, useMemo, type ReactNode, type RefObject } from "react";

import { mentionAttachmentFromDragSource } from "@/components/chat/composer/composer-drag-attachment";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import {
  COMPOSER_ATTACHMENT_DROP_TARGET_TYPE,
  type ComposerAttachmentDropTargetData,
} from "@/components/epic-canvas/dnd/dnd";
import { ComposerDropOverlay } from "@/components/home/composer/composer-shell";

export function ComposerAttachmentDropZone(props: {
  readonly viewTabId: string | null;
  readonly hostId: string;
  readonly editorRef: RefObject<ComposerPromptEditorHandle | null>;
  readonly children: ReactNode;
}) {
  const target = useMemo<ComposerAttachmentDropTargetData | null>(() => {
    if (props.viewTabId === null) return null;
    const viewTabId = props.viewTabId;
    return {
      kind: COMPOSER_ATTACHMENT_DROP_TARGET_TYPE,
      viewTabId,
      accepts: (source) =>
        source.viewTabId === viewTabId &&
        props.editorRef.current?.isReady() === true &&
        mentionAttachmentFromDragSource(source, props.hostId) !== null,
      attach: (source) => {
        if (source.viewTabId !== viewTabId) return;
        const mention = mentionAttachmentFromDragSource(source, props.hostId);
        if (mention === null) return;
        props.editorRef.current?.insertMentionAttachment(mention);
      },
    };
  }, [props.editorRef, props.hostId, props.viewTabId]);
  const occurrenceId = useId();
  const { setNodeRef, isOver } = useDroppable({
    id: `composer-attachment:${occurrenceId}`,
    data: target ?? undefined,
    disabled: target === null,
  });

  return (
    <div ref={setNodeRef} className="relative">
      {props.children}
      {isOver ? (
        <ComposerDropOverlay
          Icon={Paperclip}
          title="Drop to attach"
          subtitle="Adds this item as message context"
        />
      ) : null}
    </div>
  );
}
