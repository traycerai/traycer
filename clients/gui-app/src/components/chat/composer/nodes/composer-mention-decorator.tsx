import { Folder, FolderGit2, GitBranch, Layers } from "lucide-react";
import type { ReactElement } from "react";
import type { MentionAttachment } from "@/lib/composer/types";
import { MaterialFileIcon } from "@/components/material-file-icon";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { basenameOfPath } from "@/lib/path";
import { cn } from "@/lib/utils";
import { EPIC_NODE_ICONS } from "@/lib/artifacts/node-display";

interface ComposerMentionDecoratorProps {
  mention: MentionAttachment;
}

interface DecoratorIconProps {
  readonly mention: MentionAttachment;
  readonly filename: string;
}

const DECORATOR_ICON_CLASS = "size-3 shrink-0 text-muted-foreground";

function DecoratorIcon({
  mention,
  filename,
}: DecoratorIconProps): ReactElement {
  if (mention.contextType === "file") {
    return <MaterialFileIcon filename={filename} className="size-3 shrink-0" />;
  }
  if (mention.contextType === "folder") {
    return <Folder className={DECORATOR_ICON_CLASS} aria-hidden />;
  }
  if (mention.contextType === "worktree") {
    return <FolderGit2 className={DECORATOR_ICON_CLASS} aria-hidden />;
  }
  if (mention.contextType === "epic") {
    return <Layers className={DECORATOR_ICON_CLASS} aria-hidden />;
  }
  if (mention.contextType === "chat") {
    const Icon = EPIC_NODE_ICONS.chat;
    return <Icon className={DECORATOR_ICON_CLASS} aria-hidden />;
  }
  if (
    mention.contextType === "spec" ||
    mention.contextType === "ticket" ||
    mention.contextType === "story" ||
    mention.contextType === "review"
  ) {
    const Icon = EPIC_NODE_ICONS[mention.contextType];
    return <Icon className={DECORATOR_ICON_CLASS} aria-hidden />;
  }
  return <GitBranch className={DECORATOR_ICON_CLASS} aria-hidden />;
}

export function ComposerMentionDecorator({
  mention,
}: ComposerMentionDecoratorProps): ReactElement {
  const isPathMention =
    mention.contextType === "file" || mention.contextType === "folder";
  const label = isPathMention
    ? basenameOfPath(mention.path) || mention.path
    : mention.label;
  const tooltip = isPathMention
    ? (mention.absolutePath ?? mention.path)
    : mention.description;
  const filename = basenameOfPath(mention.path) || mention.path;
  return (
    <TooltipWrapper
      label={tooltip}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <span
        className={cn(
          "mx-[1px] inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/60 px-1.5 py-0.5 align-baseline font-medium text-foreground/90",
          "select-none",
        )}
        data-composer-chip="mention"
        contentEditable={false}
      >
        <DecoratorIcon mention={mention} filename={filename} />
        <span className="truncate">{label}</span>
      </span>
    </TooltipWrapper>
  );
}
