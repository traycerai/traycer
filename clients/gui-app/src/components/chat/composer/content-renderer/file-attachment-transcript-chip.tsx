import { useCallback } from "react";
import { FileWarning } from "lucide-react";
import type { FileAttachmentAttrs } from "@traycer/protocol/common/file-attachment";

import { useChatAttachmentScope } from "@/components/chat/chat-attachment-scope-context";
import type { ComposerInlineChipClassNames } from "@/components/chat/composer/nodes/composer-inline-chip-classnames";
import { FileAttachmentIcon } from "@/components/chat/composer/nodes/file-attachment-icon";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useEpicDownloadChatFile } from "@/hooks/epic/use-epic-download-chat-file-mutation";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostNegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";
import { fileAttachmentFamily } from "@/lib/composer/file-attachments";
import { formatByteSize } from "@/lib/format-byte-size";
import { cn } from "@/lib/utils";

interface FileAttachmentTranscriptChipProps {
  /** `null` when the node's attrs do not parse; drawn by name only. */
  readonly attrs: FileAttachmentAttrs | null;
  readonly fallbackName: string;
  readonly classNames: ComposerInlineChipClassNames;
}

/**
 * A sent message's file, in the transcript. Inside a chat tile it downloads on
 * tap; anywhere without a chat scope (a preview, a minimap), or on a host that
 * cannot serve the read, it is the same chip with no action.
 */
export function FileAttachmentTranscriptChip(
  props: FileAttachmentTranscriptChipProps,
) {
  const scope = useChatAttachmentScope();
  if (scope === null || props.attrs === null) {
    return (
      <StaticFileChip
        fileName={props.attrs?.fileName ?? props.fallbackName}
        mediaType={props.attrs?.mediaType ?? ""}
        size={props.attrs?.size ?? null}
        classNames={props.classNames}
      />
    );
  }
  return (
    <DownloadableFileChip
      attrs={props.attrs}
      epicId={scope.epicId}
      chatId={scope.chatId}
      hostId={scope.hostId}
      classNames={props.classNames}
    />
  );
}

function ChipContents(props: {
  readonly fileName: string;
  readonly mediaType: string;
  readonly size: number | null;
  readonly classNames: ComposerInlineChipClassNames;
}) {
  return (
    <>
      <FileAttachmentIcon
        family={fileAttachmentFamily(props.mediaType, props.fileName)}
        className={props.classNames.mutedIcon}
      />
      <span className={props.classNames.text}>{props.fileName}</span>
      {props.size === null ? null : (
        <span className="shrink-0 text-muted-foreground">
          {formatByteSize(props.size)}
        </span>
      )}
    </>
  );
}

function StaticFileChip(props: {
  readonly fileName: string;
  readonly mediaType: string;
  readonly size: number | null;
  readonly classNames: ComposerInlineChipClassNames;
}) {
  return (
    <span
      aria-label={`Attached file ${props.fileName}`}
      className={props.classNames.root}
      data-composer-chip="file-attachment"
    >
      <ChipContents {...props} />
    </span>
  );
}

function DownloadableFileChip(props: {
  readonly attrs: FileAttachmentAttrs;
  readonly epicId: string;
  readonly chatId: string;
  readonly hostId: string;
  readonly classNames: ComposerInlineChipClassNames;
}) {
  const { attrs, epicId, chatId, hostId, classNames } = props;
  const client = useHostClientForHostId(hostId);
  const version = useHostNegotiatedMethodVersion(client, "epic.readChatFile");
  const download = useEpicDownloadChatFile({
    client,
    hostId,
    chatId,
    hash: attrs.hash,
  });
  const { mutate, reset } = download;
  const onDownload = useCallback(() => {
    mutate(
      {
        epicId,
        chatId,
        hash: attrs.hash,
        fileName: attrs.fileName,
        mediaType: attrs.mediaType,
      },
      {
        // The bytes have been handed to the save route; holding them on the
        // mutation would keep up to 22 MB of base64 alive for as long as the
        // message is on screen.
        onSuccess: (response) => {
          if (response.ok) reset();
        },
      },
    );
  }, [
    attrs.fileName,
    attrs.hash,
    attrs.mediaType,
    chatId,
    epicId,
    mutate,
    reset,
  ]);

  // A host that completed a handshake without the method has never stored a
  // file, so there is nothing to offer.
  if (version === false) {
    return (
      <StaticFileChip
        fileName={attrs.fileName}
        mediaType={attrs.mediaType}
        size={attrs.size}
        classNames={classNames}
      />
    );
  }

  if (download.data?.ok === false) {
    return (
      <TooltipWrapper
        label="This file is no longer available."
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <span
          aria-label={`${attrs.fileName}, file unavailable`}
          className={cn(classNames.root, "text-muted-foreground")}
          data-composer-chip="file-attachment"
          data-file-attachment-state="missing"
        >
          <FileWarning className={classNames.mutedIcon} aria-hidden />
          <span className={cn(classNames.text, "line-through")}>
            {attrs.fileName}
          </span>
          <span className="shrink-0">File unavailable</span>
        </span>
      </TooltipWrapper>
    );
  }

  return (
    <TooltipWrapper
      label={`Download ${attrs.fileName}`}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <button
        type="button"
        aria-label={`Download ${attrs.fileName}`}
        className={cn(
          classNames.root,
          "cursor-pointer hover:bg-foreground/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-progress",
        )}
        data-composer-chip="file-attachment"
        disabled={download.isPending}
        onClick={onDownload}
      >
        <ChipContents
          fileName={attrs.fileName}
          mediaType={attrs.mediaType}
          size={attrs.size}
          classNames={classNames}
        />
        {download.isPending ? (
          <AgentSpinningDots
            className={undefined}
            testId="file-attachment-downloading"
            variant={undefined}
            tone="muted"
          />
        ) : null}
      </button>
    </TooltipWrapper>
  );
}
