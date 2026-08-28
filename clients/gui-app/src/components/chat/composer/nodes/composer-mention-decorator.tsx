import {
  CircleDot,
  Folder,
  FolderGit2,
  GitBranch,
  GitPullRequest,
  Layers,
} from "lucide-react";
import type { ReactElement } from "react";
import type {
  BrowserTabMentionAttachment,
  MentionAttachment,
} from "@/lib/composer/types";
import { MaterialFileIcon } from "@/components/material-file-icon";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { BrowserFavicon } from "@/components/epic-canvas/browser-favicon";
import { useMaybeBrowserSessionsContext } from "@/components/epic-canvas/renderers/browser-sessions-context";
import {
  browserTabFaviconUrl,
  resolveTabTitle,
} from "@/lib/browser-view/browser-tab-display";
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
  if (
    mention.contextType === "chat" ||
    mention.contextType === "terminal-agent" ||
    mention.contextType === "terminal"
  ) {
    const Icon = EPIC_NODE_ICONS[mention.contextType];
    return (
      <Icon className={cn(className, "text-muted-foreground")} aria-hidden />
    );
  }
  if (mention.contextType === "github_pull_request") {
    return (
      <GitPullRequest
        className={cn(className, "text-muted-foreground")}
        aria-hidden
      />
    );
  }
  if (mention.contextType === "github_issue") {
    return (
      <CircleDot
        className={cn(className, "text-muted-foreground")}
        aria-hidden
      />
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
  if (mention.contextType === "browser-tab") {
    return <BrowserTabMentionDecorator density={density} mention={mention} />;
  }
  return <StaticMentionDecorator density={density} mention={mention} />;
}

/**
 * The browser-tab chip resolves LIVE against the epic's browser sessions
 * context rather than trusting the attachment's captured title/favicon: a
 * tab's title (and even its url) changes as it navigates, so a static chip
 * would go stale the moment the page did. When the tab no longer exists in
 * that live set - closed, or the session gone - the chip falls back to the
 * attachment's captured label and dims, mirroring how `BrowserReferenceChips`
 * degrades a reference whose target is gone rather than erroring.
 */
function BrowserTabMentionDecorator({
  density,
  mention,
}: {
  readonly density: ComposerInlineChipDensity;
  readonly mention: BrowserTabMentionAttachment;
}): ReactElement {
  const classNames = composerInlineChipClassNames(density);
  const sessions = useMaybeBrowserSessionsContext();
  const liveTab =
    sessions?.items
      .find((session) => session.sessionId === mention.sessionId)
      ?.tabs.find((tab) => tab.tabId === mention.tabId) ?? null;
  const missing = liveTab === null;
  const label = liveTab !== null ? resolveTabTitle(liveTab) : mention.label;
  const tooltip = liveTab !== null ? liveTab.url : mention.url;
  return (
    <TooltipWrapper
      label={tooltip}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <span
        className={cn(
          classNames.root,
          missing && "opacity-60 text-muted-foreground",
        )}
        data-composer-chip="mention"
        contentEditable={false}
      >
        <BrowserFavicon
          faviconUrl={
            liveTab !== null ? browserTabFaviconUrl(liveTab.url) : null
          }
          isolated={false}
          className={classNames.icon}
        />
        <span className={classNames.text}>{label}</span>
      </span>
    </TooltipWrapper>
  );
}

function StaticMentionDecorator({
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
