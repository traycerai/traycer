import { File, Folder, FolderGit2, GitBranch, Layers } from "lucide-react";
import { memo, type ReactElement, type ReactNode } from "react";
import { MaterialFileIcon } from "@/components/material-file-icon";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  createLegacyMentionAttachment,
  inferPathKind,
} from "@/lib/composer/mentions";
import { splitPromptIntoComposerSegments } from "@/lib/composer/segments";
import type { Attachment, MentionAttachment } from "@/lib/composer/types";
import { basenameOfPath } from "@/lib/path";
import { EPIC_NODE_ICONS } from "@/lib/artifacts/node-display";

const MENTION_ICON_CLASS = "size-3.5 shrink-0 text-muted-foreground";

interface ChatUserMessageContentProps {
  readonly content: string;
  readonly attachments: ReadonlyArray<Attachment>;
}

/**
 * Renders user-message text with composer-style mention chips. Memoized
 * so the minimap overlay's per-row instance and the bubble's instance
 * skip the segment-split + Map rebuild when their `(content, attachments)`
 * pair is reference-equal across renders.
 */
export const ChatUserMessageContent = memo(ChatUserMessageContentImpl);

function ChatUserMessageContentImpl({
  content,
  attachments,
}: ChatUserMessageContentProps): ReactNode {
  const segments = splitPromptIntoComposerSegments(content);
  if (segments.length === 0) return content;
  const mentionsByPath = new Map(
    attachments
      .filter(
        (attachment): attachment is MentionAttachment =>
          attachment.kind === "mention",
      )
      .map((mention) => [mention.path, mention]),
  );
  let offset = 0;
  return segments.map((segment) => {
    const start = offset;
    if (segment.type === "mention") {
      offset += segment.path.length + 1;
      return (
        <ChatUserMessageMentionChip
          key={`m-${start}-${segment.path}`}
          mention={
            mentionsByPath.get(segment.path) ??
            createLegacyMentionAttachment(segment.path)
          }
        />
      );
    }
    offset += segment.text.length;
    return <span key={`t-${start}`}>{segment.text}</span>;
  });
}

interface ChatUserMessageMentionChipProps {
  readonly mention: MentionAttachment;
}

interface MentionChipIconProps {
  readonly mention: MentionAttachment;
  readonly pathKind: "file" | "folder";
  readonly filename: string;
}

const ChatUserMessageMentionChip = memo(ChatUserMessageMentionChipImpl);

function ChatUserMessageMentionChipImpl({
  mention,
}: ChatUserMessageMentionChipProps): ReactNode {
  const pathKind = mention.pathKind ?? inferPathKind(mention.path);
  const usesLabel =
    mention.contextType === "git" ||
    mention.contextType === "worktree" ||
    "epicId" in mention;
  const label = usesLabel
    ? mention.label
    : basenameOfPath(mention.path) || mention.path;
  const filename = basenameOfPath(mention.path) || mention.path;
  const tooltip =
    mention.contextType === "git" || "epicId" in mention
      ? mention.description
      : (mention.absolutePath ?? mention.path);
  return (
    <TooltipWrapper
      label={tooltip}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <span
        className="mx-px inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/60 px-1.5 py-0.5 align-baseline text-ui-sm font-medium text-foreground/90"
        data-composer-chip="mention"
      >
        <MentionChipIcon
          mention={mention}
          pathKind={pathKind}
          filename={filename}
        />
        <span className="truncate">{label}</span>
      </span>
    </TooltipWrapper>
  );
}

function MentionChipIcon({
  mention,
  pathKind,
  filename,
}: MentionChipIconProps): ReactElement {
  if (mention.contextType === "file") {
    return (
      <MaterialFileIcon filename={filename} className="size-3.5 shrink-0" />
    );
  }
  if (mention.contextType === "git") {
    return <GitBranch className={MENTION_ICON_CLASS} aria-hidden />;
  }
  if (mention.contextType === "worktree") {
    return <FolderGit2 className={MENTION_ICON_CLASS} aria-hidden />;
  }
  if (mention.contextType === "epic") {
    return <Layers className={MENTION_ICON_CLASS} aria-hidden />;
  }
  if (
    mention.contextType === "chat" ||
    mention.contextType === "terminal-agent"
  ) {
    const Icon = EPIC_NODE_ICONS[mention.contextType];
    return <Icon className={MENTION_ICON_CLASS} aria-hidden />;
  }
  if (
    mention.contextType === "spec" ||
    mention.contextType === "ticket" ||
    mention.contextType === "story" ||
    mention.contextType === "review"
  ) {
    const Icon = EPIC_NODE_ICONS[mention.contextType];
    return <Icon className={MENTION_ICON_CLASS} aria-hidden />;
  }
  if (pathKind === "folder") {
    return <Folder className={MENTION_ICON_CLASS} aria-hidden />;
  }
  return <File className={MENTION_ICON_CLASS} aria-hidden />;
}
