import { use, useCallback, type MouseEvent, type ReactNode } from "react";
import type {
  WorktreeBinding,
  WorktreeHostEntryV12,
} from "@traycer/protocol/host/worktree-schemas";
import { ExternalLink, FolderGit2, GitBranch } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { HOVER_PREVIEW_SCROLL_CLASS } from "@/components/ui/hover-preview-surface";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useRunnerOpenExternalLink } from "@/hooks/runner/use-open-external-link-mutation";
import { cn } from "@/lib/utils";
import { RunnerHostContext } from "@/providers/runner-host-context";
import {
  ownerWorkspaceMetadataItems,
  worktreePrReferences,
  PR_PILL_CLASS,
  type WorktreePrReference,
} from "@/components/worktree/worktree-pr-metadata-model";

export function WorktreePrPills(props: {
  readonly worktrees: readonly WorktreeHostEntryV12[];
  readonly detailOnHover: boolean;
  readonly className: string | undefined;
  readonly testId: string;
}): ReactNode {
  const references = worktreePrReferences(props.worktrees);
  if (references.length === 0) return null;
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1 overflow-hidden",
        props.className,
      )}
      data-testid={props.testId}
    >
      {references.map((reference) => (
        <WorktreePrPill
          key={reference.key}
          reference={reference}
          detailOnHover={props.detailOnHover}
        />
      ))}
    </span>
  );
}

function WorktreePrPill(props: {
  readonly reference: WorktreePrReference;
  readonly detailOnHover: boolean;
}): ReactNode {
  // The pill is a real PR link everywhere it renders - the Epic history list
  // and the chat/owner hover preview (now an interactive HoverCard, so a
  // focusable `<a>` no longer duplicates into a Tooltip a11y clone).
  const pill = (
    <Badge
      asChild
      variant="outline"
      className={cn("gap-1 font-medium", PR_PILL_CLASS[props.reference.state])}
    >
      <WorktreePrAnchor
        reference={props.reference}
        className="max-w-[min(60vw,16rem)]"
      />
    </Badge>
  );
  if (!props.detailOnHover) return pill;
  return (
    <TooltipWrapper
      label={<WorktreePrHoverDetail reference={props.reference} />}
      side="top"
      sideOffset={6}
      align="start"
    >
      {pill}
    </TooltipWrapper>
  );
}

function WorktreePrPillContent(props: { readonly label: string }): ReactNode {
  return (
    <>
      <span className="truncate">{props.label}</span>
      <ExternalLink className="size-3" aria-hidden />
    </>
  );
}

function WorktreePrAnchor(props: {
  readonly reference: WorktreePrReference;
  readonly className: string | undefined;
}): ReactNode {
  const runnerHost = use(RunnerHostContext);
  const openExternalLink = useRunnerOpenExternalLink();
  const openExternal = useCallback(
    (event: MouseEvent<HTMLAnchorElement>): void => {
      event.stopPropagation();
      if (runnerHost === null) return;
      event.preventDefault();
      openExternalLink.mutate(props.reference.url);
    },
    [openExternalLink, props.reference.url, runnerHost],
  );
  return (
    <a
      href={props.reference.url}
      target="_blank"
      rel="noreferrer"
      aria-label={props.reference.ariaLabel}
      className={props.className}
      data-testid="worktree-context-pr-pill"
      data-pr-state={props.reference.state}
      onClick={openExternal}
    >
      <WorktreePrPillContent label={props.reference.label} />
    </a>
  );
}

function WorktreePrHoverDetail(props: {
  readonly reference: WorktreePrReference;
}): ReactNode {
  return (
    <span className="flex max-w-[min(80vw,24rem)] flex-col gap-1 py-0.5">
      <span className="flex items-start gap-1.5">
        <GitBranch className="mt-0.5 size-3 shrink-0" aria-hidden />
        <span className="break-words">
          {props.reference.branch ?? "Detached HEAD"}
        </span>
      </span>
      <span className="flex items-start gap-1.5 text-background/70">
        <FolderGit2 className="mt-0.5 size-3 shrink-0" aria-hidden />
        <span className="break-all">{props.reference.worktreePath}</span>
      </span>
    </span>
  );
}

/**
 * Chat/owner workspace hover preview. Renders on the shared hover-preview card
 * surface (`HoverPreviewCard`), so its tones are the card's own
 * foreground/muted pair — matching the composer's @mention preview panel and
 * the workspace picker's folder list.
 */
export function OwnerWorkspaceMetadataContent(props: {
  readonly binding: WorktreeBinding | null;
  readonly worktrees: readonly WorktreeHostEntryV12[];
  readonly pending: boolean;
  readonly error: boolean;
}): ReactNode {
  if (props.pending && props.binding === null) {
    return (
      <span className="flex items-center gap-2 px-3 py-2 text-ui-xs">
        <AgentSpinningDots
          testId={undefined}
          variant="dots"
          className="size-4"
        />
        Loading workspace…
      </span>
    );
  }
  if (props.error) {
    return (
      <span className="block px-3 py-2 text-ui-xs text-muted-foreground">
        Unable to load workspace details
      </span>
    );
  }
  const items = ownerWorkspaceMetadataItems(props.binding, props.worktrees);
  if (items.length === 0) {
    return (
      <span className="block px-3 py-2 text-ui-xs text-muted-foreground">
        No workspace linked
      </span>
    );
  }
  return (
    <span
      className={cn(
        "flex max-h-[min(60vh,20rem)] w-full flex-col gap-2",
        HOVER_PREVIEW_SCROLL_CLASS,
      )}
      data-testid="owner-workspace-metadata-content"
      // See workspace-folder-hover-list.tsx: Chromium makes an overflowing
      // scroll container a sequential tab stop regardless of DOM tabIndex;
      // this keeps it out of the Tab order while pointer/wheel scroll works.
      tabIndex={-1}
    >
      {items.map((item) => (
        <span key={item.key} className="flex min-w-0 flex-col gap-0.5">
          <span className="text-ui-sm font-medium">{item.name}</span>
          <span className="flex items-start gap-1.5 text-ui-xs text-muted-foreground">
            <GitBranch className="mt-0.5 size-3 shrink-0" aria-hidden />
            <span className="break-words">{item.branch ?? "No branch"}</span>
          </span>
          <span className="flex items-start gap-1.5 text-ui-xs text-muted-foreground/70">
            <FolderGit2 className="mt-0.5 size-3 shrink-0" aria-hidden />
            <span className="break-all">{item.runPath}</span>
          </span>
          {item.worktree === null ? null : (
            <WorktreePrPills
              worktrees={[item.worktree]}
              detailOnHover={false}
              className="mt-0.5 flex-wrap overflow-visible"
              testId={`owner-workspace-prs-${item.key}`}
            />
          )}
        </span>
      ))}
    </span>
  );
}
