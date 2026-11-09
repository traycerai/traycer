import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { FileWarning, X } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useSyncExternalStore,
  type MouseEvent,
} from "react";

import { composerInlineChipClassNames } from "@/components/chat/composer/nodes/composer-inline-chip-classnames";
import { FileAttachmentIcon } from "@/components/chat/composer/nodes/file-attachment-icon";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  cancelFileAttachmentUpload,
  readFileAttachmentUploadStatus,
  subscribeFileAttachmentUploads,
  type FileAttachmentUploadStatus,
} from "@/lib/composer/file-attachment-upload";
import {
  fileAttachmentFamily,
  fileAttachmentSizeValue,
  isPendingFileAttachmentAttrs,
} from "@/lib/composer/file-attachments";
import { stringValue } from "@/lib/composer/tiptap-json-content";
import { formatByteSize } from "@/lib/format-byte-size";
import { cn } from "@/lib/utils";

const CHIP_CLASS_NAMES = composerInlineChipClassNames("regular");

type FileChipState = "uploading" | "unconfirmed" | "stored";

function useFileAttachmentUploadStatus(
  id: string | null,
): FileAttachmentUploadStatus | null {
  const getSnapshot = useCallback(
    () => (id === null ? null : readFileAttachmentUploadStatus(id)),
    [id],
  );
  return useSyncExternalStore(subscribeFileAttachmentUploads, getSnapshot);
}

/**
 * A pending node this renderer is not uploading is UNCONFIRMED: a draft that
 * was persisted mid-upload and restored after a reload, or one another device
 * is still uploading. Either way the host may not hold its bytes, so it keeps
 * blocking send until the upload lands or the person removes it.
 */
function chipState(
  pending: boolean,
  status: FileAttachmentUploadStatus | null,
): FileChipState {
  if (!pending) return "stored";
  return status === "uploading" ? "uploading" : "unconfirmed";
}

function chipTooltip(state: FileChipState, fileName: string): string {
  if (state === "uploading") return `Uploading ${fileName}`;
  if (state === "unconfirmed") {
    return "This file hasn't finished uploading. Remove it and attach it again.";
  }
  return fileName;
}

function stopEditorPointer(event: MouseEvent<HTMLButtonElement>): void {
  event.preventDefault();
  event.stopPropagation();
}

function FileAttachmentNodeViewBase(props: NodeViewProps) {
  const { node, updateAttributes, deleteNode } = props;
  const id = stringValue(node.attrs.id);
  const fileName = stringValue(node.attrs.fileName) ?? "File";
  const mediaType = stringValue(node.attrs.mediaType) ?? "";
  const size = fileAttachmentSizeValue(node.attrs.size);
  const pending = isPendingFileAttachmentAttrs(node.attrs);
  const status = useFileAttachmentUploadStatus(id);
  const state = chipState(pending, status);

  // The upload's outcome, applied to whichever editor shows this node. It runs
  // again on every mount, so an upload that settled while the composer was
  // unmounted lands the next time the node is drawn.
  useEffect(() => {
    if (!pending) return;
    if (status === "stored") updateAttributes({ uploadState: null });
    else if (status === "failed") deleteNode();
  }, [deleteNode, pending, status, updateAttributes]);

  const remove = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      stopEditorPointer(event);
      if (id !== null) cancelFileAttachmentUpload(id);
      deleteNode();
    },
    [deleteNode, id],
  );

  return (
    <TooltipWrapper
      label={chipTooltip(state, fileName)}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <NodeViewWrapper
        as="span"
        aria-label={`Attached file ${fileName}`}
        className={cn(
          CHIP_CLASS_NAMES.root,
          state === "unconfirmed" &&
            "border-warning/30 bg-warning/10 text-warning-foreground",
        )}
        contentEditable={false}
        data-composer-chip="file-attachment"
        data-file-attachment-state={state}
      >
        {state === "unconfirmed" ? (
          <FileWarning className={CHIP_CLASS_NAMES.icon} aria-hidden />
        ) : (
          <FileAttachmentIcon
            family={fileAttachmentFamily(mediaType, fileName)}
            className={CHIP_CLASS_NAMES.mutedIcon}
          />
        )}
        <span className={CHIP_CLASS_NAMES.text}>{fileName}</span>
        {size === null ? null : (
          <span className="shrink-0 text-muted-foreground">
            {formatByteSize(size)}
          </span>
        )}
        {state === "uploading" ? (
          <AgentSpinningDots
            className={undefined}
            testId="file-attachment-uploading"
            variant={undefined}
            tone="muted"
          />
        ) : null}
        <button
          type="button"
          aria-label={`Remove ${fileName}`}
          className="inline-flex size-[1.15em] shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-foreground/8 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onMouseDown={stopEditorPointer}
          onClick={remove}
        >
          <X className="size-[0.85em]" aria-hidden />
        </button>
      </NodeViewWrapper>
    </TooltipWrapper>
  );
}

export const FileAttachmentNodeView = memo(FileAttachmentNodeViewBase);
