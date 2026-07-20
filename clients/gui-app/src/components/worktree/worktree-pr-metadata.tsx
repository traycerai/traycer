import { use, useCallback, type MouseEvent, type ReactNode } from "react";
import type {
  WorktreeBinding,
  WorktreeHostEntryV12,
} from "@traycer/protocol/host/worktree-schemas";
import { ExternalLink, FolderGit2, GitBranch } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { HOVER_PREVIEW_SCROLL_CLASS } from "@/components/ui/hover-preview-surface";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useRunnerOpenExternalLink } from "@/hooks/runner/use-open-external-link-mutation";
import { cn } from "@/lib/utils";
import { RunnerHostContext } from "@/providers/runner-host-context";
import {
  ownerWorkspaceMetadataItems,
  worktreePrReferences,
  type WorktreeDisplayedPrState,
  type WorktreePrReference,
} from "@/components/worktree/worktree-pr-metadata-model";

/**
 * The one theme-aware PR-pill palette, used wherever a pill renders: the Epic
 * history list (page background) and the chat/owner hover preview (the
 * `bg-popover` hover-preview card). Both are normal, non-inverted surfaces, so
 * a single palette covers them.
 *
 * The light text is `-800`, not `-700`: over the pill's own 10% tint, `-700`
 * drops to 3.23:1 (green) on Tokyo Night light, whose surfaces are the darkest
 * of the light presets. `-800` clears 4.5:1 across every preset and surface;
 * dark `-300` already does. See worktree-pr-metadata.test.tsx's matrix.
 */
const PR_PILL_CLASS: Record<WorktreeDisplayedPrState, string> = {
  open: "border-green-600/30 bg-green-500/10 text-green-800 dark:border-green-400/30 dark:text-green-300",
  closed:
    "border-red-600/25 bg-red-500/10 text-red-800 dark:border-red-400/25 dark:text-red-300",
  merged:
    "border-purple-600/30 bg-purple-500/10 text-purple-800 dark:border-purple-400/30 dark:text-purple-300",
};

export function WorktreePrPills(props: {
  readonly worktrees: readonly WorktreeHostEntryV12[];
  readonly detailOnHover: boolean;
  readonly maximumVisible: number | null;
  readonly className: string | undefined;
  readonly testId: string;
}): ReactNode {
  const references = worktreePrReferences(props.worktrees);
  if (references.length === 0) return null;
  const visibleReferences =
    props.maximumVisible === null
      ? references
      : references.slice(0, props.maximumVisible);
  const overflowReferences =
    props.maximumVisible === null ? [] : references.slice(props.maximumVisible);
  return (
    <span
      className={cn("flex min-w-0 items-center gap-1", props.className)}
      data-testid={props.testId}
    >
      {visibleReferences.map((reference) => (
        <WorktreePrPill
          key={reference.key}
          reference={reference}
          detailOnHover={props.detailOnHover}
          flexible={props.maximumVisible !== null}
        />
      ))}
      {overflowReferences.length === 0 ? null : (
        <WorktreePrOverflow references={overflowReferences} />
      )}
    </span>
  );
}

function WorktreePrPill(props: {
  readonly reference: WorktreePrReference;
  readonly detailOnHover: boolean;
  readonly flexible: boolean;
}): ReactNode {
  // The pill is a real PR link everywhere it renders - the Epic history list
  // and the chat/owner hover preview (now an interactive HoverCard, so a
  // focusable `<a>` no longer duplicates into a Tooltip a11y clone).
  const pill = (
    <Badge
      asChild
      variant="outline"
      className={cn(
        "gap-1 font-medium",
        props.flexible && "min-w-0 shrink",
        PR_PILL_CLASS[props.reference.state],
      )}
    >
      <WorktreePrAnchor
        reference={props.reference}
        className={cn("max-w-[min(60vw,16rem)]", props.flexible && "min-w-0")}
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

function WorktreePrOverflow(props: {
  readonly references: readonly WorktreePrReference[];
}): ReactNode {
  const count = props.references.length;
  return (
    <Popover>
      <Badge
        asChild
        variant="outline"
        className="cursor-pointer border-border bg-background font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <PopoverTrigger
          aria-label={`Show ${count} more pull request${count === 1 ? "" : "s"}`}
          data-testid="worktree-pr-overflow-trigger"
        >
          +{count}
        </PopoverTrigger>
      </Badge>
      <PopoverContent
        aria-label="More pull requests"
        align="end"
        sideOffset={6}
        className="w-[min(90vw,24rem)]"
        data-testid="worktree-pr-overflow-content"
      >
        <span className="text-ui-xs font-medium text-muted-foreground">
          More pull requests
        </span>
        <span className="flex flex-wrap gap-1.5">
          {props.references.map((reference) => (
            <WorktreePrPill
              key={reference.key}
              reference={reference}
              detailOnHover={false}
              flexible={false}
            />
          ))}
        </span>
      </PopoverContent>
    </Popover>
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
              maximumVisible={null}
              className="mt-0.5 flex-wrap overflow-visible"
              testId={`owner-workspace-prs-${item.key}`}
            />
          )}
        </span>
      ))}
    </span>
  );
}
