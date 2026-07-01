import { Folder, FolderGit2, GitBranch, Layers } from "lucide-react";
import type { ReactElement } from "react";
import type { MentionAttachment } from "@/lib/composer/types";
import { MaterialFileIcon } from "@/components/material-file-icon";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { basenameOfPath } from "@/lib/path";
import { EPIC_NODE_ICONS } from "@/lib/artifacts/node-display";
import { cn } from "@/lib/utils";
import {
  composerInlineChipClassNames,
  type ComposerInlineChipDensity,
} from "./composer-inline-chip-classnames";

interface ComposerMentionDecoratorProps {
  readonly mention: MentionAttachment;
  readonly density: ComposerInlineChipDensity;
}

interface DecoratorIconProps {
  readonly mention: MentionAttachment;
  readonly filename: string;
  readonly className: string;
}

function DecoratorIcon({
  className,
  mention,
  filename,
}: DecoratorIconProps): ReactElement {
  if (mention.contextType === "file") {
    return <MaterialFileIcon filename={filename} className={className} />;
  }
  if (mention.contextType === "folder") {
    return (
      <Folder className={cn(className, "text-muted-foreground")} aria-hidden />
    );
  }
  if (mention.contextType === "worktree") {
    return (
      <FolderGit2
        className={cn(className, "text-muted-foreground")}
        aria-hidden
      />
    );
  }
  if (mention.contextType === "epic") {
    return (
      <Layers className={cn(className, "text-muted-foreground")} aria-hidden />
    );
  }
  if (mention.contextType === "chat") {
    const Icon = EPIC_NODE_ICONS.chat;
    return (
      <Icon className={cn(className, "text-muted-foreground")} aria-hidden />
    );
  }
  if (
    mention.contextType === "spec" ||
    mention.contextType === "ticket" ||
    mention.contextType === "story" ||
    mention.contextType === "review"
  ) {
    const Icon = EPIC_NODE_ICONS[mention.contextType];
    return (
      <Icon className={cn(className, "text-muted-foreground")} aria-hidden />
    );
  }
  return (
    <GitBranch className={cn(className, "text-muted-foreground")} aria-hidden />
  );
}

export function ComposerMentionDecorator({
  density,
  mention,
}: ComposerMentionDecoratorProps): ReactElement {
  const classNames = composerInlineChipClassNames(density);
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
        className={classNames.root}
        data-composer-chip="mention"
        contentEditable={false}
      >
        <DecoratorIcon
          mention={mention}
          filename={filename}
          className={classNames.icon}
        />
        <span className={classNames.text}>{label}</span>
      </span>
    </TooltipWrapper>
  );
}
